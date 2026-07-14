# mcp-evidence

An MCP server that drives a real Chromium browser (via Playwright) and packages
the run into **evidence** — screenshots, a video, and a Playwright trace —
proving a feature works. Meant for an agent to call after implementing
something, as a verification step.

Generic and reusable: no assumptions about any particular app's routes or
auth. You pass a `baseUrl` per session, and evidence is written into the
*consuming* project's working directory at
`.evidence/<featureName>/<timestamp>/`.

## Install

Browsers aren't bundled — install Chromium once per machine:

```bash
npx playwright install chromium
```

### Register with Claude Code

Per-user (available in every project):

```bash
claude mcp add --scope user evidence -- npx -y github:meovan07/mcp-evidence
```

Or per-project, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "evidence": {
      "command": "npx",
      "args": ["-y", "github:meovan07/mcp-evidence"]
    }
  }
}
```

This repo is public, so no GitHub credentials are needed on the machine
running `npx`.

Consuming projects should add `.evidence/` to their own `.gitignore`.

## Tools

| Tool | Purpose |
|---|---|
| `start_evidence_session({ featureName, baseUrl?, browser?, storageStatePath? })` | Launches a browser context with video + trace recording on. Returns `sessionId`. |
| `navigate({ sessionId, url })` | Goes to `url` (resolved against `baseUrl` if relative). |
| `click({ sessionId, selector? , role?, name?, timeout? })` | Clicks an element, located by CSS/text `selector` or ARIA `role`/`name`. |
| `fill({ sessionId, selector, value, timeout? })` | Fills a form field. |
| `wait_for({ sessionId, selector?, text?, state?, timeout? })` | Waits for an element to reach a state (default `visible`). |
| `set_network({ sessionId, offline })` | Simulates losing (`offline: true`) or restoring (`offline: false`) internet connectivity, for testing error banners/retry/reconnect behavior. |
| `screenshot({ sessionId, name, fullPage? })` | Saves a PNG immediately into the evidence dir. Survives even if the session later errors. |
| `finish_evidence_session({ sessionId, summary? })` | Closes the context, finalizes `video.webm`, stops tracing (`trace.zip`), writes `network.json` and `manifest.json`, returns counts of console/page/network errors seen. |

A session left open for 10 minutes with no tool calls is auto-finished. The
server also flushes any open sessions on `SIGINT`/`SIGTERM` so evidence isn't
lost if the process is killed mid-run.

### Browser choice

`start_evidence_session` defaults to Chromium. Pass `browser: "firefox"` or
`browser: "webkit"` to use a different engine — `webkit` is the open-source
engine behind Safari, the closest available option for catching
Safari-specific bugs (though not a literal Safari build; some macOS-only
behavior like Intelligent Tracking Prevention may differ slightly). Install
the extra engines once per machine:

```bash
npx playwright install webkit firefox
```

`manifest.json` records which engine a session used (`browserEngine`).

Every session also passively records, into `manifest.json`, anything a
screenshot or video wouldn't show: browser console errors and uncaught page
exceptions. `finish_evidence_session` reports the counts directly so a
silent failure doesn't slip through unnoticed.

Every request the page makes — not just failures — is also logged to
`network.json` (method, url, resource type, status, timing), the same data
Chrome DevTools' Network tab shows. `manifest.json` keeps a filtered
`networkIssues` list (non-2xx/failed only) plus a `networkRequestCount` for a
quick read without opening the full log. (The `trace.zip` already had this
same data in Playwright's own trace viewer; this just makes it directly
readable by the calling agent too, not only a human opening the trace UI.)

### Reusing an authenticated session (`storageStatePath`)

Every session starts from a completely clean browser context by default —
good for testing a fresh visit, but it means any auth-gated flow (email OTP,
password login) has to be redone from scratch on every single run. Pass
`storageStatePath` to skip that:

```
start_evidence_session({ featureName: "checkout", baseUrl, storageStatePath: ".evidence/.auth/test-user.json" })
```

- **First run**: the file doesn't exist yet, so the session starts fresh
  (logged out) as usual. Log in normally with `navigate`/`fill`/`click`
  (using `wait_for_email` from `mcp-evidence-api` if it's an OTP flow). When
  `finish_evidence_session` runs, the session's cookies + localStorage are
  saved to that path.
- **Every subsequent run** that passes the *same* `storageStatePath`: the
  file exists, so the session loads it and starts already signed in —
  `start_evidence_session`'s response says
  `[loaded existing storage state, likely pre-authenticated]`. The state is
  refreshed on every `finish_evidence_session` too, so rotating session
  tokens stay current.

**This file contains live session credentials** — treat it exactly like a
password. Store it under `.evidence/` (already covered by the gitignore
guidance below) or another path you've confirmed is gitignored, never commit
it, and use a separate path per test account/user if you're testing more
than one identity.

### Example

```
start_evidence_session({ featureName: "checkout flow", baseUrl: "http://localhost:3000" })
  -> sessionId, evidenceDir

navigate({ sessionId, url: "/cart" })
click({ sessionId, role: "button", name: "Checkout" })
fill({ sessionId, selector: "#email", value: "test@example.com" })
wait_for({ sessionId, selector: "#confirmation", state: "visible" })
screenshot({ sessionId, name: "confirmation" })
finish_evidence_session({ sessionId, summary: "Checkout completes and shows confirmation" })
```

Resulting evidence directory:

```
.evidence/checkout-flow/2026-07-08T07-52-21-042Z/
  0-confirmation.png
  video.webm
  trace.zip
  network.json
  manifest.json
```

View the trace with `npx playwright show-trace trace.zip`.

## Known limitations

- If the process is killed within roughly a second of a session starting or
  navigating (tracing/video still warming up), the video or trace for that
  session may be incomplete or missing. Screenshots and `manifest.json` are
  written eagerly and always survive. This doesn't affect the normal flow of
  calling `finish_evidence_session` at the end of a run.
- One Chromium process per session. Idle sessions are reaped after 10 minutes
  to avoid orphaned processes.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run dev     # tsc --watch
npm start        # node dist/index.js
```
