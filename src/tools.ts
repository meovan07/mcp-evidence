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
        "Launches a browser context (Chromium by default) with video and trace recording enabled, and creates " +
        "an evidence directory under `.evidence/<featureName>/<timestamp>/` in the current project. Returns a " +
        "sessionId to pass to the other tools. Call finish_evidence_session when done to finalize the recording.",
      inputSchema: {
        featureName: z.string().min(1).describe("Short name for the feature being verified, used in the evidence path"),
        baseUrl: z.string().url().optional().describe("Base URL of the app under test; relative navigate() URLs resolve against this"),
        browser: z
          .enum(["chromium", "firefox", "webkit"])
          .optional()
          .describe(
            "Browser engine to use (default chromium). `webkit` is the open-source engine behind Safari — " +
              "closest available option for testing Safari-specific behavior, though not a literal Safari build.",
          ),
        storageStatePath: z
          .string()
          .optional()
          .describe(
            "Path to a storage-state JSON file (cookies + localStorage) to reuse an authenticated session, " +
              "skipping a repeated login flow. If the file doesn't exist yet, the session starts fresh (e.g. " +
              "logged out) and the file is created on finish_evidence_session, ready for the next run to reuse. " +
              "If it exists, it's loaded so the session starts already signed in. Contains live session " +
              "credentials — store it under a gitignored path, e.g. `.evidence/.auth/some-user.json`.",
          ),
        device: z
          .string()
          .optional()
          .describe(
            "Emulate a real mobile/tablet device (viewport, user agent, touch, pixel ratio) instead of a " +
              "generic desktop window, e.g. \"iPhone 13\", \"Pixel 5\", \"iPad Pro 11\". See Playwright's " +
              "device list for all options.",
          ),
        displayMode: z
          .enum(["browser", "minimal-ui", "standalone", "fullscreen"])
          .optional()
          .describe(
            "Overrides window.matchMedia() so a PWA's JS install-detection check " +
              "(matchMedia('(display-mode: standalone)')) reports the given mode, without installing it. " +
              "Does NOT affect native CSS `@media (display-mode: ...)` rules — no browser API exists to force " +
              "those (there's no CDP method for it; confirmed by testing). Only useful if the app's JS, not " +
              "just its CSS, branches on display mode. Can also be changed mid-session with set_display_mode.",
          ),
      },
    },
    async ({ featureName, baseUrl, browser, storageStatePath, device, displayMode }) => {
      const session = await sessions.start({
        featureName,
        baseUrl,
        browserEngine: browser,
        storageStatePath,
        device,
        displayMode,
      });
      return text(
        `Started evidence session ${session.id} (${session.browserEngine}${device ? `, ${device}` : ""})` +
          (session.loadedStorageState ? " [loaded existing storage state, likely pre-authenticated]" : "") +
          `\nEvidence directory: ${session.evidenceDir}`,
      );
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
    "drag",
    {
      title: "Drag and drop",
      description:
        "Drags a source element onto a target element, each located by CSS/text `selector` or ARIA " +
        "`role`+`name`. Fires native HTML5 drag events, so it works with most drag-and-drop libraries " +
        "(React DnD, Sortable.js, native draggable elements). For a drag with no drop target — a resize " +
        "handle, a slider — use drag_by_offset instead. A few custom implementations that bypass native " +
        "HTML5 drag events entirely (canvas-based, pointer-events-only) may not respond to either — check " +
        "with snapshot() first if a drag isn't having an effect.",
      inputSchema: {
        sessionId: z.string(),
        sourceSelector: z.string().optional(),
        sourceRole: z.string().optional(),
        sourceName: z.string().optional().describe("Accessible name, used together with sourceRole"),
        targetSelector: z.string().optional(),
        targetRole: z.string().optional(),
        targetName: z.string().optional().describe("Accessible name, used together with targetRole"),
        timeout: z.number().optional().describe("Max time to wait for either element, in milliseconds"),
      },
    },
    async ({ sessionId, sourceSelector, sourceRole, sourceName, targetSelector, targetRole, targetName, timeout }) => {
      const session = sessions.get(sessionId);
      const source = resolveClickLocator(session.page, { selector: sourceSelector, role: sourceRole, name: sourceName });
      const target = resolveClickLocator(session.page, { selector: targetSelector, role: targetRole, name: targetName });
      await source.dragTo(target, { timeout });
      return text(`Dragged ${sourceSelector ?? sourceRole} to ${targetSelector ?? targetRole}`);
    },
  );

  server.registerTool(
    "drag_by_offset",
    {
      title: "Drag by offset",
      description:
        "Drags an element by a pixel distance (dx, dy) with no drop target — for resize handles, sliders, " +
        "swipe-to-reveal, and similar gestures that drag() (element-to-element) doesn't fit. Uses real mouse " +
        "events dispatched via CDP (trusted, not JS-synthesized), so it works with pointer-event-based UI " +
        "libraries (e.g. Radix) that ignore untrusted synthetic events.",
      inputSchema: {
        sessionId: z.string(),
        selector: z.string().min(1).describe("Element to grab (e.g. the drag handle)"),
        dx: z.number().describe("Horizontal distance to drag, in pixels (positive = right)"),
        dy: z.number().describe("Vertical distance to drag, in pixels (positive = down)"),
        steps: z.number().optional().describe("Number of intermediate mousemove steps (default 10) — more steps looks more like a real drag to gesture-sensitive UI"),
      },
    },
    async ({ sessionId, selector, dx, dy, steps }) => {
      await sessions.dragByOffset(sessionId, { selector, dx, dy, steps });
      return text(`Dragged ${selector} by (${dx}, ${dy})`);
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
    "set_network",
    {
      title: "Set network",
      description:
        "Simulates the browser going offline or back online, for testing how the app handles lost/restored " +
        "connectivity (error banners, retry logic, reconnect behavior, etc.). Affects the whole session's " +
        "browser context, including subsequent navigate/click/fill calls.",
      inputSchema: {
        sessionId: z.string(),
        offline: z.boolean().describe("true to simulate no internet connection, false to restore it"),
      },
    },
    async ({ sessionId, offline }) => {
      const session = sessions.get(sessionId);
      await session.context.setOffline(offline);
      return text(offline ? "Network set to offline" : "Network restored (online)");
    },
  );

  server.registerTool(
    "set_display_mode",
    {
      title: "Set display mode",
      description:
        "Mid-session version of start_evidence_session's displayMode param — overrides window.matchMedia() " +
        "so JS install-detection checks report the given mode. Does NOT affect native CSS `@media " +
        "(display-mode: ...)` rules (no browser API can force those). Applies to the current page " +
        "immediately and to subsequent navigate() calls in this session.",
      inputSchema: {
        sessionId: z.string(),
        mode: z.enum(["browser", "minimal-ui", "standalone", "fullscreen"]),
      },
    },
    async ({ sessionId, mode }) => {
      await sessions.setDisplayMode(sessionId, mode);
      return text(`window.matchMedia() now reports display-mode: "${mode}" (JS checks only, not CSS)`);
    },
  );

  server.registerTool(
    "evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Runs a JavaScript expression in the page and returns the result (must be JSON-serializable, or " +
        "undefined). For introspecting state a screenshot can't show: service worker registration " +
        "(`navigator.serviceWorker.getRegistrations()`), Cache API contents, localStorage, PWA manifest " +
        "details, feature detection, etc. An async expression/IIFE is fine — it's awaited.",
      inputSchema: {
        sessionId: z.string(),
        script: z.string().min(1).describe('JS expression, e.g. "navigator.serviceWorker.getRegistrations()"'),
      },
    },
    async ({ sessionId, script }) => {
      const result = await sessions.evaluate(sessionId, script);
      return text(JSON.stringify(result, null, 2) ?? "undefined");
    },
  );

  server.registerTool(
    "snapshot",
    {
      title: "Accessibility snapshot",
      description:
        "Returns the page's accessibility tree as YAML (role, accessible name, state — e.g. `button \"Send\" " +
        "[ref=e12] [box=337,671,40,40]`), scoped to `selector` if given, otherwise the whole page. Much cheaper " +
        "and more reliable than a screenshot for figuring out what's actually on a page and how to target it — " +
        "use this instead of guessing at selectors via evaluate() or click() trial-and-error. Also surfaces " +
        "elements with missing/empty accessible names for free (an accessibility gap, e.g. an icon-only button " +
        "with no aria-label).",
      inputSchema: {
        sessionId: z.string(),
        selector: z.string().optional().describe("Scope the snapshot to this element instead of the whole page"),
        boxes: z.boolean().optional().describe("Include each element's bounding box as [box=x,y,width,height] (default true)"),
      },
    },
    async ({ sessionId, selector, boxes }) => {
      const result = await sessions.snapshot(sessionId, { selector, boxes });
      return text(result);
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
      const { evidenceDir, consoleErrorCount, pageErrorCount, networkIssueCount, networkRequestCount, savedStorageState } =
        await sessions.finish(sessionId, summary);
      return text(
        `Finished evidence session. Evidence saved to: ${evidenceDir}\n` +
          `Console errors: ${consoleErrorCount}, page errors: ${pageErrorCount}, ` +
          `network requests: ${networkRequestCount} (${networkIssueCount} non-2xx/failed, see network.json for the full list)` +
          (consoleErrorCount + pageErrorCount + networkIssueCount > 0
            ? "\nSee manifest.json / network.json for details."
            : "") +
          (savedStorageState ? "\nStorage state saved for reuse in future sessions." : ""),
      );
    },
  );
}
