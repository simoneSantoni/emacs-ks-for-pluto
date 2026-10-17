# AMO submission — status & handoff

Working notes for publishing this add-on to addons.mozilla.org (AMO) as a
**listed** (public) add-on. Pick up from "Remaining steps" below.

## Decision

- **Listed** (distribution = "On this site"), chosen over unlisted/self-hosted.
  Reasons: free auto-updates handled by Mozilla, one-click install, and search
  discoverability; avoids having to run our own `update_url`. Trade-off accepted:
  human review latency (hours–days) and a listing page to fill in.

## Done so far

- **Tests** — `cd test && npm test`: unit tests for `background.js` / `content.js`
  and a Playwright end-to-end suite that drives the engine in Firefox against a
  real Pluto server. Green on Pluto 1.0.3 and 0.20.21 (2026-09-20); re-run
  2026-10-17 before building the upload ZIP: 7/7 unit, 32 pass / 1 skipped e2e
  (the skip is the real-completion-popup test, expected under Julia 1.13). Re-run
  before every upload; a Pluto release that changes CodeMirror internals shows up
  here first.

- **Lint** — `npx web-ext lint` → 0 errors, 0 notices, **1 warning**.
  - Warning `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: `strict_min_version`
    is `140.0`, but `browser_specific_settings.gecko.data_collection_permissions`
    is only supported on Firefox **for Android** 142+. Desktop-only, non-blocking.
    Bump `manifest.json` `strict_min_version` to `142.0` to clear it (open decision).
- **Build** — `./store/build-zip.sh` → **`emacs-ks-for-pluto-1.0.0.zip`** in repo
  root (gitignored). 14 files, ~30 KB, dev files excluded. Rebuilt 2026-10-17 from
  commit `a85c47f` (clean tree). This is the upload artifact. Rebuild after any source change (and bump `version` in `manifest.json`
  before re-uploading — AMO rejects duplicate versions).

- **Screenshots** — `store/screenshots/1-region-and-badge.png` (active region +
  top-right badge) and `store/screenshots/2-isearch.png` (incremental-search bar),
  1280×800 PNG, captured 2026-10-17 against a real Pluto with the engine injected
  (same plumbing as the e2e suite). Upload both in step 5.

## Submitted — 2026-10-17

Version **1.0.0** was submitted as a listed add-on on 2026-10-17 (driven through
the Developer Hub in the user's Chrome session). Status: **awaiting review**;
AMO emails when it is published (up to 24 h, longer if picked for manual review).

- Listing / dashboard: https://addons.mozilla.org/en-US/developers/addon/emacs-keybindings-for-pluto/edit
- Public URL once approved: https://addons.mozilla.org/firefox/addon/emacs-keybindings-for-pluto/
- Upload validation: 0 errors, 1 warning (the `strict_min_version` / Android note).
- Fields as submitted: name, summary and description from "Listing copy" below;
  category **Web Development** (AMO has no "Developer Tools" category);
  license **MIT**; support website `https://github.com/simoneSantoni/emacs-ks-for-pluto/issues`;
  **no support email** (add one under Edit → Describe if wanted); no privacy
  policy (nothing is collected); not experimental; "uses build tools" = No;
  reviewer notes from "Notes to reviewer" below plus a "no build step" line.
  Developer display name set to "Simone Santoni".
- Images: both `store/screenshots/*.png` uploaded with captions, and a
  **custom listing icon** uploaded from the new `icons/icon.svg` (the official
  GNU Emacs "E" and disc from `icons/emacs.svg`, with Pluto.jl's three
  Julia-coloured dots stacked beside it; GPL v3+ as a derivative of that logo —
  see the licence note in `README.md`). The 1.0.0 package still ships the *previous*
  toolbar icon PNGs — the regenerated `icons/icon{16,32,48,128}.png` go out
  with the next version bump (`rsvg-convert -w N -h N icons/icon.svg -o icons/iconN.png`).

### Next upload

Bump `version` in `manifest.json`, `./store/build-zip.sh`, then Developer Hub →
*Upload New Version* (or generate API keys at
https://addons.mozilla.org/developers/addon/api/key/ and use
`npx web-ext sign --channel=listed`). Note: Chrome's extension-mode automation
cannot use native file choosers; the upload was done by injecting the file into
the `<input type=file>` via a `DataTransfer` from page JS.

---

## Listing copy

### Name
```
Emacs Keybindings for Pluto
```

### Summary (231/250 chars)
```
Adds Emacs-style keybindings to Julia's Pluto notebook cells. Movement, kill/yank, incremental search, prefix arguments, and cell evaluation — all the muscle memory, right inside Pluto's CodeMirror editors.
```

### Category
Developer Tools

### Full description
```
Emacs Keybindings for Pluto brings Emacs muscle memory to Julia's Pluto
notebook editor. Pluto's cells are CodeMirror 6 editors; this add-on layers
a modeless Emacs keymap on top of them, so ordinary keys still self-insert
and only Emacs chords are intercepted.

An "Emacs" badge appears at the top-right of the page when the add-on is
active. Toggle it on or off from the toolbar popup; open Pluto tabs follow
immediately.

SUPPORTED BINDINGS

Movement
• C-f / C-b, M-f / M-b — char / word motion
• C-n / C-p, C-a / C-e — line motion, line start / end
• C-v / M-v, M-< / M-> — page and buffer motion
• M-g g — goto line, M-m back to indentation, C-l recenter

Region, kill & yank
• C-Space sets the mark; movement extends the region
• C-w kill, M-w copy, C-k kill-to-end-of-line
• M-d / M-DEL kill word forward / backward
• C-y yank, M-y yank-pop (cycle the kill ring)
• C-x C-x exchange point and mark, C-x h mark whole buffer

Editing & case
• C-o open line, C-j newline, C-t transpose
• M-u / M-l / M-c upcase / downcase / capitalize word
• M-; toggle comment
• C-/ , C-_ , C-x u undo, C-? redo

Search
• C-s / C-r incremental search forward / backward (wraps, smart case)

Prefix arguments
• C-u universal argument, M-<digit> numeric argument

Cell operations
• C-c C-c evaluate the current cell, C-x C-s submit all changed cells
• C-c C-n / C-c C-p focus next / previous cell
• C-c C-a / C-c C-o add a cell below / above
• C-c C-k delete the current cell

NOTES

• Firefox reserves C-n, C-w, C-t (and C-q on Linux); those never reach the
  page, so use the arrow keys / M-w instead.
• Works with Pluto 1.x and 0.20.x.
• The add-on runs only on Pluto notebooks served from localhost / 127.0.0.1.
• No data is collected and no network requests are made.

Open source (MIT). Source: https://github.com/simoneSantoni/emacs-ks-for-pluto
```

### License
MIT (already in `LICENSE`). The only third-party asset is `icons/emacs.svg`,
the official GNU Emacs logo (FSF, GPL v3+, notice kept inside the file),
loaded by `content.css` for the on-page badge and reused in the add-on icon.

---

## Notes to reviewer

```
WHAT IT DOES
Adds an Emacs keymap to the CodeMirror 6 editors inside Julia's Pluto
notebooks. Modeless — normal typing is unaffected; only Emacs chords are
handled.

PERMISSIONS
• "storage" — persists a single boolean (enabled/disabled) in
  storage.local under the key "emacsEnabled". Nothing else is stored.
• Content scripts run only on http://localhost/*, http://127.0.0.1/*, and
  https://localhost/* — a Pluto notebook server. No broad host access.

ABOUT THE INJECTED SCRIPT (emacs-mode.js)
content.js injects emacs-mode.js (listed in web_accessible_resources) into
the page context via a <script> tag. This is NOT remote code — emacs-mode.js
is bundled inside the add-on and loaded via runtime.getURL(). Page-world
injection is required because CodeMirror 6's EditorView instances are only
reachable from the page's own JavaScript context, not from an isolated
content script. No code is fetched from any network source; the add-on
makes no network requests at all. icons/emacs.svg is also listed in
web_accessible_resources: content.css shows it in the on-page badge.

HOW TO TEST
This add-on activates only on a running Pluto server, which requires Julia.
Quickest setup:
  1. Install Julia, then in the Julia REPL:
       import Pkg; Pkg.add("Pluto"); import Pluto; Pluto.run()
  2. Pluto opens a notebook at http://localhost:1234 (or similar).
  3. The "Emacs" badge appears top-right, in Pluto's header bar. Click into
     a cell and try, e.g.,
     C-a / C-e (line start/end), C-Space then C-f (region), C-k (kill line),
     C-y (yank), C-s (incremental search).
  4. Toggle the add-on off from the toolbar popup; the bindings stop and the
     badge disappears immediately (no reload needed).

No account or credentials are needed.

Source code: https://github.com/simoneSantoni/emacs-ks-for-pluto
```
