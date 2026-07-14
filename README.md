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
| `start_evidence_session({ featureName, baseUrl?, browser?, storageStatePath?, device?, displayMode? })` | Launches a browser context with video + trace recording on. Returns `sessionId`. |
| `navigate({ sessionId, url })` | Goes to `url` (resolved against `baseUrl` if relative). |
| `click({ sessionId, selector? , role?, name?, timeout? })` | Clicks an element, located by CSS/text `selector` or ARIA `role`/`name`. |
| `fill({ sessionId, selector, value, timeout? })` | Fills a form field. |
| `drag({ sessionId, sourceSelector/Role/Name, targetSelector/Role/Name, timeout? })` | Drags a source element onto a target, firing native HTML5 drag events. |
| `drag_by_offset({ sessionId, selector, dx, dy, steps? })` | Drags an element by a pixel distance — no drop target. For resize handles, sliders, swipe gestures. |
| `wait_for({ sessionId, selector?, text?, state?, timeout? })` | Waits for an element to reach a state (default `visible`). |
| `set_network({ sessionId, offline })` | Simulates losing (`offline: true`) or restoring (`offline: false`) internet connectivity, for testing error banners/retry/reconnect behavior. |
| `set_display_mode({ sessionId, mode })` | Mid-session version of `displayMode` above — see PWA section below. |
| `evaluate({ sessionId, script })` | Runs a JS expression in the page, returns the (JSON-serializable) result. |
| `snapshot({ sessionId, selector?, boxes? })` | Returns the accessibility tree as YAML (role, name, ref, bounding box) — see below. |
| `screenshot({ sessionId, name, fullPage? })` | Saves a PNG immediately into the evidence dir. Survives even if the session later errors. |
| `finish_evidence_session({ sessionId, summary? })` | Closes the context, finalizes `video.webm`, stops tracing (`trace.zip`), writes `network.json` and `manifest.json`, returns counts of console/page/network errors seen. |

A session left open for 10 minutes with no tool calls is auto-finished. The
server also flushes any open sessions on `SIGINT`/`SIGTERM` so evidence isn't
lost if the process is killed mid-run.

### Diagnostics on failure

`click`, `fill`, `drag`, `drag_by_offset`, and `wait_for` are the tools most
likely to fail while you're still figuring out an unfamiliar page — wrong
selector, element not visible yet, wrong assumption about the DOM. Rather
than returning a bare Playwright timeout, the error has a compact
accessibility snapshot of the page auto-attached, so you can usually see
what actually happened and correct course in the same round-trip instead of
needing a follow-up `snapshot()`/`evaluate()` call just to find out why.

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

### Mobile / tablet emulation (`device`)

Pass a Playwright device name to emulate a real device's viewport, user
agent, touch support, and pixel ratio instead of a generic desktop window:

```
start_evidence_session({ featureName: "checkout mobile", baseUrl, device: "iPhone 13" })
```

Common values: `"iPhone 13"`, `"Pixel 5"`, `"iPad Pro 11"` — see
[Playwright's device list](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/deviceDescriptorsSource.json)
for the full set (includes landscape variants, older devices, etc.). An
invalid name throws immediately with that link. `manifest.json` records
which device a session used.

### PWA testing

Two genuinely different things fall under "PWA testing," with different
support levels here:

- **Offline / service-worker-cache behavior** — fully supported today via
  `set_network({ sessionId, offline: true })`. This is the actual mechanism
  a PWA is tested against: does it serve cached content, show a fallback
  UI, sync back up when reconnected.
- **"Installed" look/behavior** (`display-mode: standalone`) — **partially**
  supported, and it's worth understanding the real limitation rather than
  assuming it's fully covered. There is no browser API — CDP or otherwise —
  that can force the native CSS `@media (display-mode: standalone)` feature
  to match (confirmed by testing every parameter combination of Chrome
  DevTools Protocol's media-emulation command, and cross-checked against
  Puppeteer's docs, which list only `prefers-color-scheme`,
  `prefers-reduced-motion`, and `color-gamut` as supported — not
  `display-mode`). What `displayMode`/`set_display_mode` actually do is
  override the JS `window.matchMedia()` function, so an app's **JS**
  install-detection logic (`matchMedia('(display-mode: standalone)').matches`
  — a common real pattern, e.g. to hide an "Install app" banner once
  running standalone) reports the requested mode correctly. Any **CSS**
  written as `@media (display-mode: standalone) { ... }` will not be
  affected — the browser's CSS engine evaluates that independently of the
  JS function, and nothing in Playwright or CDP can override it.

```
start_evidence_session({ featureName: "pwa install banner", baseUrl, displayMode: "standalone" })
// or mid-session:
set_display_mode({ sessionId, mode: "standalone" })
```

For a full pixel-accurate "how does this look actually installed" check —
CSS included — there's no automatable substitute for genuinely installing
it (desktop: Chrome's `--app=<url>` launch mode; mobile: an actual
home-screen install on a real or emulated device), which is outside this
tool's scope.

### Accessibility snapshot (`snapshot`)

Reach for this before reaching for `evaluate` or trial-and-error `click`
calls to figure out what's on a page. It returns Playwright's aria snapshot
— a YAML tree of role, accessible name, a stable `ref`, and (by default) a
bounding box for every element:

```
snapshot({ sessionId })
  -> - generic [ref=e1] [box=0,0,393,727]:
       - button "Ask Coach..." [ref=e45] [box=40,412,321,24]
       - button [disabled] [box=337,775,40,40]:
           - img [box=347,785,20,20]
```

Two things this surfaces for free that a screenshot or DOM query won't:
elements with **missing accessible names** (the second button above is
icon-only with no `aria-label` — a real accessibility gap, not just
inconvenient for automation), and **disabled state** (explains why a filled
form's submit button won't respond, immediately, instead of via minutes of
click-timeout debugging). Pass `selector` to scope it to part of the page
instead of the whole thing, or `boxes: false` to drop the bounding boxes
if you only need structure.

### Distance-based drag (`drag_by_offset`)

`drag()` is element-to-element (drag *this* onto *that*) — built for
reordering/drop-target interactions. Some gestures have no target element:
a bottom-sheet resize handle, a slider, swipe-to-reveal. `drag_by_offset`
grabs `selector` and moves the mouse by `(dx, dy)` pixels instead:

```
drag_by_offset({ sessionId, selector: "#resize-handle", dx: 0, dy: -250 })
```

It uses Playwright's real mouse API, dispatched via CDP as trusted OS-level
input — not JS-synthesized `PointerEvent`s. That distinction matters: some
UI libraries (Radix, among others) ignore untrusted synthetic events
entirely, so a `dispatchEvent(new PointerEvent(...))` approach can silently
no-op even though the element clearly has a `pointerdown` listener attached.
Validated against both a native `<input type="range">` (jumped straight to
its max when dragged past the track) and a custom `pointerdown`/
`pointermove`-based drag handle (moved exactly the requested distance) —
the same pattern that didn't respond to synthetic events in earlier testing.

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
