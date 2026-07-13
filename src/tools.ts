import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { SessionManager } from "./sessions.js";

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

function resolveClickLocator(
  page: Page,
  args: { selector?: string; role?: string; name?: string },
): Locator {
  if (args.role) {
    return page.getByRole(args.role as Parameters<Page["getByRole"]>[0], args.name ? { name: args.name } : undefined);
  }
  if (args.selector) {
    return page.locator(args.selector);
  }
  throw new Error("Provide either `selector` or `role` (optionally with `name`) to locate the element.");
}

function resolveWaitLocator(page: Page, args: { selector?: string; text?: string }): Locator {
  if (args.selector) {
    return page.locator(args.selector);
  }
  if (args.text) {
    return page.getByText(args.text);
  }
  throw new Error("Provide either `selector` or `text` to locate the element.");
}

export function registerTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    "start_evidence_session",
    {
      title: "Start evidence session",
      description:
        "Launches a Chromium browser context with video and trace recording enabled, and creates an " +
        "evidence directory under `.evidence/<featureName>/<timestamp>/` in the current project. Returns a " +
        "sessionId to pass to the other tools. Call finish_evidence_session when done to finalize the recording.",
      inputSchema: {
        featureName: z.string().min(1).describe("Short name for the feature being verified, used in the evidence path"),
        baseUrl: z.string().url().optional().describe("Base URL of the app under test; relative navigate() URLs resolve against this"),
      },
    },
    async ({ featureName, baseUrl }) => {
      const session = await sessions.start(featureName, baseUrl);
      return text(`Started evidence session ${session.id}\nEvidence directory: ${session.evidenceDir}`);
    },
  );

  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description: "Navigates the session's page to a URL. If the URL is relative, it resolves against the session's baseUrl.",
      inputSchema: {
        sessionId: z.string(),
        url: z.string().min(1),
      },
    },
    async ({ sessionId, url }) => {
      const session = sessions.get(sessionId);
      const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)
        ? url
        : session.baseUrl
          ? new URL(url, session.baseUrl).toString()
          : url;
      await session.page.goto(target, { waitUntil: "load" });
      return text(`Navigated to ${target}`);
    },
  );

  server.registerTool(
    "click",
    {
      title: "Click",
      description: "Clicks an element, located either by CSS/text `selector` or by ARIA `role` (optionally with `name`).",
      inputSchema: {
        sessionId: z.string(),
        selector: z.string().optional().describe("CSS or Playwright text selector"),
        role: z.string().optional().describe("ARIA role, e.g. 'button', 'link'"),
        name: z.string().optional().describe("Accessible name to match, used together with `role`"),
        timeout: z.number().optional().describe("Max time to wait for the element, in milliseconds"),
      },
    },
    async ({ sessionId, selector, role, name, timeout }) => {
      const session = sessions.get(sessionId);
      const locator = resolveClickLocator(session.page, { selector, role, name });
      await locator.click({ timeout });
      return text(`Clicked ${selector ?? `role=${role}${name ? ` name="${name}"` : ""}`}`);
    },
  );

  server.registerTool(
    "fill",
    {
      title: "Fill",
      description: "Fills a form field located by CSS selector with the given value.",
      inputSchema: {
        sessionId: z.string(),
        selector: z.string().min(1),
        value: z.string(),
        timeout: z.number().optional().describe("Max time to wait for the element, in milliseconds"),
      },
    },
    async ({ sessionId, selector, value, timeout }) => {
      const session = sessions.get(sessionId);
      await session.page.locator(selector).fill(value, { timeout });
      return text(`Filled ${selector}`);
    },
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for",
      description: "Waits for an element (located by CSS `selector` or visible `text`) to reach the given state.",
      inputSchema: {
        sessionId: z.string(),
        selector: z.string().optional(),
        text: z.string().optional(),
        state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
        timeout: z.number().optional().describe("Max time to wait, in milliseconds (default 30000)"),
      },
    },
    async ({ sessionId, selector, text: textArg, state, timeout }) => {
      const session = sessions.get(sessionId);
      const locator = resolveWaitLocator(session.page, { selector, text: textArg });
      await locator.waitFor({ state, timeout });
      return text(`${selector ?? textArg} reached state "${state}"`);
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description: "Takes a screenshot and saves it immediately into the evidence directory, so it survives even if the session later errors.",
      inputSchema: {
        sessionId: z.string(),
        name: z.string().min(1).describe("Short label for this screenshot, used in the filename"),
        fullPage: z.boolean().optional().describe("Capture the full scrollable page instead of just the viewport"),
      },
    },
    async ({ sessionId, name, fullPage }) => {
      const session = sessions.get(sessionId);
      const filename = sessions.nextScreenshotFilename(session, name);
      const filePath = `${session.evidenceDir}/${filename}`;
      await session.page.screenshot({ path: filePath, fullPage: fullPage ?? false });
      session.screenshots.push({ name, path: filePath, takenAt: new Date().toISOString() });
      return text(`Saved screenshot: ${filePath}`);
    },
  );

  server.registerTool(
    "finish_evidence_session",
    {
      title: "Finish evidence session",
      description:
        "Closes the browser context (finalizing the video), stops tracing, writes network.json (every request " +
        "made during the session) and manifest.json, and returns the evidence folder path plus counts of " +
        "console errors, uncaught page errors, and network requests/issues seen. Always call this at the end " +
        "of a verification run.",
      inputSchema: {
        sessionId: z.string(),
        summary: z.string().optional().describe("Short human-readable summary of what was verified"),
      },
    },
    async ({ sessionId, summary }) => {
      const { evidenceDir, consoleErrorCount, pageErrorCount, networkIssueCount, networkRequestCount } =
        await sessions.finish(sessionId, summary);
      return text(
        `Finished evidence session. Evidence saved to: ${evidenceDir}\n` +
          `Console errors: ${consoleErrorCount}, page errors: ${pageErrorCount}, ` +
          `network requests: ${networkRequestCount} (${networkIssueCount} non-2xx/failed, see network.json for the full list)` +
          (consoleErrorCount + pageErrorCount + networkIssueCount > 0
            ? "\nSee manifest.json / network.json for details."
            : ""),
      );
    },
  );
}
