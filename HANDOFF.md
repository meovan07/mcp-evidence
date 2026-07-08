# mcp-evidence — handoff notes

Written by a Claude Code session rooted at `~/Working/boost-3d-app` (sessions are
scoped per working directory, so a new Claude Code session opened in this repo
starts with no memory of that conversation — this file is the bridge). Delete
this file once the project has its own README/history.

## Goal
A custom MCP server that gives agents Playwright browser-automation tools AND
packages the run into "evidence" (screenshots + video + trace) proving a
feature works, after the agent finishes implementing it. Meant to be reusable:
across projects, and across this Mac + a Windows machine at home.

## Decisions already made (don't re-litigate without reason)
- **Full browser automation**, not capture-only: this MCP drives navigate/click/
  fill/wait itself, not just screenshots on top of another driver — one process
  needs to own the browser context so video/trace recording stays coherent.
- **Generic/reusable**: no assumptions about any specific app's routes/auth.
  `baseUrl` is passed per session.
- **Evidence storage**: written into the *consuming* project's working directory
  as `.evidence/<featureName>/<timestamp>/` (gitignored in that project), using
  `process.cwd()` since Claude Code launches MCP servers with cwd = the project
  dir.
- **Distribution**: standalone **private** GitHub repo (this one), installed via
  `npx -y github:<you>/mcp-evidence` on each machine. No npm publish (avoids the
  $7/mo paid-account requirement for private npm packages), no GitHub Packages
  setup. Requires git/GitHub auth (SSH key or `gh` credential helper) on each
  machine for the private clone to work.
- **Registration**: `claude mcp add --scope user evidence -- npx -y github:<you>/mcp-evidence`
  (per-user, works in every project) or a per-project `.mcp.json`.

## Planned tool surface
- `start_evidence_session({ featureName, baseUrl })` → launches Chromium context
  with `recordVideo` + tracing on, creates the evidence dir, returns `sessionId`.
- `navigate({ sessionId, url })`
- `click({ sessionId, selector | role+name })`
- `fill({ sessionId, selector, value })`
- `wait_for({ sessionId, selector | text, state, timeout })`
- `screenshot({ sessionId, name, fullPage? })` → saves PNG immediately, returns
  path (so evidence survives even if the session later errors).
- `finish_evidence_session({ sessionId, summary? })` → closes context (finalizes
  `video.webm`), stops tracing (`trace.zip`), writes `manifest.json`, returns
  the evidence folder path.

Session state lives in-memory in the server process:
`Map<sessionId, {browser, context, page, evidenceDir, screenshots[]}>`, with
idle-session cleanup (e.g. 10 min no activity) to avoid orphaned Chromium
processes.

## Build order
1. ~~Scaffold package (package.json, tsconfig.json), `npm install`~~ — done.
2. ~~Write `src/index.ts`: minimal stdio MCP server, zero tools yet.~~ — done.
   Confirmed API: `McpServer`/`registerTool` from
   `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from
   `@modelcontextprotocol/sdk/server/stdio.js`. Builds clean (`npm run build`)
   and starts (`node dist/index.js` prints "mcp-evidence server running on
   stdio" to stderr and connects over stdio).
3. Add `navigate`/`click`/`fill`/`wait_for`/`screenshot` tools (no
   session/recording yet), validate against a real dev server.
4. Add `start_evidence_session`/`finish_evidence_session` with video + trace +
   manifest.
5. Idle-session cleanup + crash-safe partial evidence flush.
6. README (Playwright browser install step: `npx playwright install
   chromium`; per-machine MCP registration command; tool usage examples).
7. Create the private GitHub repo and push. **Note: `gh` CLI is not installed
   on the Mac this was scaffolded on** — either install it or create the repo
   manually on github.com and add the remote.
8. Register in `boost-3d-app` and other projects.

## Current repo state
- `git init` done, **no commits yet**.
- `package.json` — deps: `@modelcontextprotocol/sdk@^1.29.0`,
  `playwright@^1.61.1`, `zod@^3.24.1`; devDeps: `typescript`, `@types/node`.
  `bin: mcp-evidence -> dist/index.js`, `prepare: npm run build`.
- `tsconfig.json` — ES2022/NodeNext, `src` → `dist`.
- `.gitignore` — `node_modules`.
- `npm install` has been run (`node_modules/`, `package-lock.json` present).
- `src/index.ts` exists (minimal stdio MCP server, zero tools) and
  `npm run build` succeeds. Next step: add the Playwright-backed tools
  (build order #3).
