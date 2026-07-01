# AMO submission — status & handoff

Working notes for publishing this add-on to addons.mozilla.org (AMO) as a
**listed** (public) add-on. Pick up from "Remaining steps" below.

## Decision

- **Listed** (distribution = "On this site"), chosen over unlisted/self-hosted.
  Reasons: free auto-updates handled by Mozilla, one-click install, and search
  discoverability; avoids having to run our own `update_url`. Trade-off accepted:
  human review latency (hours–days) and a listing page to fill in.

## Done so far

- **Lint** — `npx web-ext lint` → 0 errors, 0 notices, **1 warning**.
  - Warning `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: `strict_min_version`
    is `140.0`, but `browser_specific_settings.gecko.data_collection_permissions`
    is only supported on Firefox **for Android** 142+. Desktop-only, non-blocking.
    Bump `manifest.json` `strict_min_version` to `142.0` to clear it (open decision).
- **Build** — `./store/build-zip.sh` → **`emacs-ks-for-pluto-1.0.0.zip`** in repo
  root (gitignored). 13 files, ~45 KB, dev files excluded. This is the upload
  artifact. Rebuild after any source change (and bump `version` in `manifest.json`
  before re-uploading — AMO rejects duplicate versions).

## Remaining steps

1. Sign in at https://addons.mozilla.org → Developer Hub (Firefox Account).
2. *Submit a New Add-on* → choose **"On this site"** (listed) → upload the ZIP.
3. Paste the **listing copy** (below) into the form fields.
4. Paste the **reviewer notes** (below) into "Notes for Reviewers" — this pre-empts
   the two likely snags: reviewers can't run a Pluto server, and the page-world
   script injection can trip a false "remote code" flag.
5. Upload **at least one screenshot** (required for listed). Best: a focused Pluto
   cell with the bottom-left "Emacs" badge visible; optional second: the popup toggle.
6. Select license **MIT**, set support email, submit for review.

## Open items needing the user

- [ ] Confirm the GitHub URL used in the copy: `https://github.com/simoneSantoni/emacs-ks-for-pluto`
      (inferred from git user; README link is a bare placeholder).
- [ ] Provide/capture screenshot(s). Can be captured by driving Firefox against a
      local Pluto server (`import Pluto; Pluto.run()`), e.g. via the browser tooling.
- [ ] Decide whether to bump `strict_min_version` 140 → 142 to clear the lint warning.
- [ ] Confirm AMO support email (defaults to Firefox Account email).

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

An "Emacs" badge appears at the bottom-left of the page when the add-on is
active. Toggle it on or off from the toolbar popup (reload the Pluto tab
after toggling).

SUPPORTED BINDINGS

Movement
• C-f / C-b, M-f / M-b — char / word motion
• C-n / C-p, C-a / C-e — line motion, line start / end
• C-v / M-v, M-< / M-> — page and buffer motion
• M-g g — goto line

Region, kill & yank
• C-Space sets the mark; movement extends the region
• C-w kill, M-w copy, C-k kill-to-end-of-line
• M-d / M-DEL kill word forward / backward
• C-y yank, M-y yank-pop (cycle the kill ring)
• C-x C-x exchange point and mark, C-x h mark whole buffer

Editing & case
• C-o open line, C-j newline, C-t transpose
• M-u / M-l / M-c upcase / downcase / capitalize word
• C-/ , C-_ , C-x u undo

Search
• C-s / C-r incremental search forward / backward

Prefix arguments
• C-u universal argument, M-<digit> numeric argument

Cell operations
• C-c C-c or C-x C-s evaluate the current cell
• C-c C-n / C-c C-p focus next / previous cell
• C-c C-a / C-c C-o add a cell below / above
• C-c C-k delete the current cell

NOTES

• A few chords are reserved by Firefox itself (e.g. C-w may close a tab) and
  cannot always be intercepted by an extension.
• The add-on runs only on Pluto notebooks served from localhost / 127.0.0.1.
• No data is collected and no network requests are made.

Open source (MIT). Source: https://github.com/simoneSantoni/emacs-ks-for-pluto
```

### License
MIT (already in `LICENSE`).

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
makes no network requests at all.

HOW TO TEST
This add-on activates only on a running Pluto server, which requires Julia.
Quickest setup:
  1. Install Julia, then in the Julia REPL:
       import Pkg; Pkg.add("Pluto"); import Pluto; Pluto.run()
  2. Pluto opens a notebook at http://localhost:1234 (or similar).
  3. The "Emacs" badge appears bottom-left. Click into a cell and try, e.g.,
     C-a / C-e (line start/end), C-Space then C-f (region), C-k (kill line),
     C-y (yank), C-s (incremental search).
  4. Toggle the add-on off from the toolbar popup; the bindings stop and the
     badge disappears after reloading the tab.

No account or credentials are needed.

Source code: https://github.com/simoneSantoni/emacs-ks-for-pluto
```
