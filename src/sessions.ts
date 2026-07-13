import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, type BrowserContext, type Page, chromium, firefox, webkit } from "playwright";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

const LAUNCHERS = { chromium, firefox, webkit } as const;

export interface ScreenshotRecord {
  name: string;
  path: string;
  takenAt: string;
}

export interface ConsoleErrorRecord {
  text: string;
  location?: string;
  timestamp: string;
}

export interface PageErrorRecord {
  message: string;
  stack?: string;
  timestamp: string;
}

export interface NetworkRequestRecord {
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  ok: boolean;
  failure?: string;
  timestamp: string;
}

export interface EvidenceSession {
  id: string;
  featureName: string;
  baseUrl?: string;
  browserEngine: BrowserEngine;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  evidenceDir: string;
  startedAt: string;
  lastActivity: number;
  screenshots: ScreenshotRecord[];
  consoleErrors: ConsoleErrorRecord[];
  pageErrors: PageErrorRecord[];
  networkLog: NetworkRequestRecord[];
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
// Bounds how much a single chatty page can bloat manifest.json; oldest entries drop first.
const MAX_LOGGED_ENTRIES = 200;
// The network log records every request (not just failures), so a busy page needs more headroom.
const MAX_NETWORK_LOG_ENTRIES = 1000;

function pushCapped<T>(arr: T[], item: T, cap: number = MAX_LOGGED_ENTRIES): void {
  arr.push(item);
  if (arr.length > cap) arr.shift();
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").slice(0, 80);
  return cleaned || "unnamed";
}

export class SessionManager {
  private sessions = new Map<string, EvidenceSession>();
  private idleTimer: NodeJS.Timeout;

  constructor() {
    this.idleTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref();
  }

  get(sessionId: string): EvidenceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Unknown sessionId: ${sessionId}. It may have already finished, or timed out after ${IDLE_TIMEOUT_MS / 60000} minutes of inactivity.`,
      );
    }
    session.lastActivity = Date.now();
    return session;
  }

  nextScreenshotFilename(session: EvidenceSession, name: string): string {
    const index = session.screenshots.length;
    return `${index}-${sanitize(name)}.png`;
  }

  async start(featureName: string, baseUrl?: string, browserEngine: BrowserEngine = "chromium"): Promise<EvidenceSession> {
    const id = randomUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const evidenceDir = path.join(process.cwd(), ".evidence", sanitize(featureName), timestamp);
    await mkdir(evidenceDir, { recursive: true });

    const browser = await LAUNCHERS[browserEngine].launch();
    const context = await browser.newContext({
      recordVideo: { dir: evidenceDir },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();

    const consoleErrors: ConsoleErrorRecord[] = [];
    const pageErrors: PageErrorRecord[] = [];
    const networkLog: NetworkRequestRecord[] = [];

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const location = msg.location();
      pushCapped(consoleErrors, {
        text: msg.text(),
        location: location.url ? `${location.url}:${location.lineNumber}` : undefined,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("pageerror", (error) => {
      pushCapped(pageErrors, { message: error.message, stack: error.stack, timestamp: new Date().toISOString() });
    });
    // Covers every request that got a response, successful or not — the full "network tab" record.
    page.on("response", (response) => {
      const request = response.request();
      pushCapped(
        networkLog,
        {
          method: request.method(),
          url: response.url(),
          resourceType: request.resourceType(),
          status: response.status(),
          statusText: response.statusText(),
          ok: response.ok(),
          timestamp: new Date().toISOString(),
        },
        MAX_NETWORK_LOG_ENTRIES,
      );
    });
    // Covers requests that never got a response at all (DNS failure, connection refused, blocked, etc.).
    page.on("requestfailed", (request) => {
      pushCapped(
        networkLog,
        {
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          ok: false,
          failure: request.failure()?.errorText,
          timestamp: new Date().toISOString(),
        },
        MAX_NETWORK_LOG_ENTRIES,
      );
    });

    const session: EvidenceSession = {
      id,
      featureName,
      baseUrl,
      browserEngine,
      browser,
      context,
      page,
      evidenceDir,
      startedAt: new Date().toISOString(),
      lastActivity: Date.now(),
      screenshots: [],
      consoleErrors,
      pageErrors,
      networkLog,
    };
    this.sessions.set(id, session);
    return session;
  }

  async finish(
    sessionId: string,
    summary?: string,
  ): Promise<{
    evidenceDir: string;
    consoleErrorCount: number;
    pageErrorCount: number;
    networkIssueCount: number;
    networkRequestCount: number;
  }> {
    const session = this.get(sessionId);
    return this.finalize(session, summary, "finished");
  }

  private async finalize(
    session: EvidenceSession,
    summary: string | undefined,
    reason: "finished" | "idle-timeout" | "shutdown",
  ): Promise<{
    evidenceDir: string;
    consoleErrorCount: number;
    pageErrorCount: number;
    networkIssueCount: number;
    networkRequestCount: number;
  }> {
    this.sessions.delete(session.id);

    const tracePath = path.join(session.evidenceDir, "trace.zip");
    let traceFile: string | undefined;
    try {
      await session.context.tracing.stop({ path: tracePath });
      traceFile = "trace.zip";
    } catch (error) {
      console.error(`Failed to stop tracing for session ${session.id}:`, error);
    }

    try {
      await session.context.close();
    } catch (error) {
      console.error(`Failed to close context for session ${session.id}:`, error);
    }

    // recordVideo.dir was set to evidenceDir, and Playwright guarantees the video file is
    // written to disk once the context is closed — just look up the auto-generated filename
    // and rename it, rather than racing context.close() against video.saveAs()'s own artifact
    // channel (which can throw "Target page, context or browser has been closed"). On an abrupt
    // kill (SIGTERM mid-recording) the encoder can lag slightly behind context.close(), so retry
    // briefly before giving up.
    let videoFile: string | undefined;
    try {
      let recorded: string | undefined;
      for (let attempt = 0; attempt < 10 && !recorded; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
        const entries = await readdir(session.evidenceDir);
        recorded = entries.find((entry) => entry.endsWith(".webm"));
      }
      if (recorded && recorded !== "video.webm") {
        await rename(path.join(session.evidenceDir, recorded), path.join(session.evidenceDir, "video.webm"));
        videoFile = "video.webm";
      } else {
        videoFile = recorded;
      }
    } catch (error) {
      console.error(`Failed to locate recorded video for session ${session.id}:`, error);
    }

    try {
      await session.browser.close();
    } catch (error) {
      console.error(`Failed to close browser for session ${session.id}:`, error);
    }

    const networkIssues = session.networkLog.filter((entry) => !entry.ok);
    await writeFile(path.join(session.evidenceDir, "network.json"), JSON.stringify(session.networkLog, null, 2));

    const manifest = {
      featureName: session.featureName,
      baseUrl: session.baseUrl,
      browserEngine: session.browserEngine,
      startedAt: session.startedAt,
      finishedAt: new Date().toISOString(),
      endReason: reason,
      summary,
      screenshots: session.screenshots,
      video: videoFile,
      trace: traceFile,
      consoleErrors: session.consoleErrors,
      pageErrors: session.pageErrors,
      networkIssues,
      network: "network.json",
      networkRequestCount: session.networkLog.length,
    };
    await writeFile(path.join(session.evidenceDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    return {
      evidenceDir: session.evidenceDir,
      consoleErrorCount: session.consoleErrors.length,
      pageErrorCount: session.pageErrors.length,
      networkIssueCount: networkIssues.length,
      networkRequestCount: session.networkLog.length,
    };
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        console.error(`Session ${session.id} idle for over ${IDLE_TIMEOUT_MS / 60000} minutes, auto-finishing.`);
        await this.finalize(session, "auto-finished: idle timeout", "idle-timeout");
      }
    }
  }

  /** Best-effort flush of any still-open sessions so evidence isn't lost on shutdown/crash. */
  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map((session) => this.finalize(session, "auto-finished: server shutdown", "shutdown")),
    );
  }
}
