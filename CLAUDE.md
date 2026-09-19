# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Firefox add-on (Manifest V3) that adds Emacs-style keybindings to Julia's Pluto
notebook editor cells (which are CodeMirror 6 instances). It is the Emacs
counterpart to the Chrome extension `vim-kb-for-pluto` and mirrors its layout.

## Loading & testing the add-on

No build step and no root `package.json` — the add-on is plain JS/CSS loaded
directly by Firefox. Checks are `npx web-ext lint` plus the dev-only harness in
`test/` (see "Tests" below).

- Load: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → pick `manifest.json`.
- Test against a running Pluto server at `http://localhost:*`, `http://127.0.0.1:*`, or `https://localhost:*` (see `manifest.json` match patterns).
- After editing `background.js`, `content.js`, `emacs-mode.js`, or `manifest.json`, click "Reload" on the add-on card and hard-reload the Pluto tab.
- Package for distribution with `store/build-zip.sh` (produces the upload ZIP; sign via AMO / `web-ext`). The script zips an **explicit file allowlist**: a new runtime file must be added there as well as to `manifest.json`, and a new dev-only file to `ignoreFiles` in `web-ext-config.mjs` (`test/**` is already there). Bump `version` in `manifest.json` before re-uploading — AMO rejects duplicate versions.
- `store/AMO-SUBMISSION.md` is the handoff doc for the AMO listing (status, open decisions such as the `strict_min_version` 140 → 142 lint warning, listing copy, reviewer notes). Keep it in sync when submission-relevant things change.
- Mozilla's `web-ext` (not vendored — `npx web-ext …` or install globally) reads `web-ext-config.mjs`, which excludes dev-only files (`store/**`, docs, `*.zip`/`*.xpi`) from lint/build output:
  - `npx web-ext lint` — validate the add-on the way AMO's automated review does; run before any submission.
  - `npx web-ext run` — launch Firefox with the add-on side-loaded and auto-reloading.
  - `npx web-ext build` / `web-ext sign` — produce/sign an `.xpi` (alternative to `store/build-zip.sh`).

## Tests

Run from `test/` (its own `package.json`; Playwright is the only dependency, `npm install` once, plus `npx playwright install firefox` if no Playwright Firefox is cached):

- `npm run test:unit` — `unit/extension.test.mjs` loads `background.js` / `content.js` into a `node:vm` sandbox with a fake `browser` API and fake DOM. Fast, no browser.
- `npm run test:e2e` — `e2e/engine.test.mjs` drives the engine with real keyboard events in headless Firefox against a **real Pluto server**. Playwright's Firefox cannot load WebExtensions, so `e2e/helpers.mjs` does `content.js`'s job by hand: it injects `content.css` + `emacs-mode.js` into the notebook page. Anything involving the extension plumbing therefore belongs in the unit tests.
- `npm test` — both. Single test: `node --test --test-name-pattern="goal column" "e2e/*.test.mjs"` (Node ≥ 22 wants the quoted glob, not a directory).
- Env knobs (all in `helpers.mjs`): `PLUTO_URL` reuses a running server (must be started with `require_secret_for_access=false, require_secret_for_open_links=false`) — much faster when iterating; otherwise the suite spawns `julia` itself, with `PLUTO_JULIA_PROJECT` naming a project that has Pluto and `JULIA_BIN` the executable. `FIREFOX_BIN` overrides the browser, `HEADED=1` shows it.
- The e2e tests share one page and one notebook; `setDoc()` resets the first cell and presses `C-g`, so tests must not depend on kill-ring contents left by earlier ones. Cell-operation tests run last because they need the Julia process (first evaluation can take a minute).
- Test against more than one Pluto when touching view discovery or cell ops: e.g. `julia --project=/tmp/p1 -e 'import Pkg; Pkg.add(name="Pluto", version="0.20.21")'`. Verified green on Pluto 1.0.3 and 0.20.21.
- The "real completion popup" test skips itself when Pluto offers no completions (it did not under Julia 1.13 here); the simulated-popup test covers the key remapping regardless.

## Firefox specifics

- Uses `browser.*` WebExtension APIs (promise-based) with a `const api = (typeof browser !== 'undefined') ? browser : chrome;` shim so the same files also run on Chromium.
- Background is an **event page** (`background.scripts`), not a service worker — the broadly-compatible Firefox MV3 form.
- `browser_specific_settings.gecko.id` pins the add-on ID (required for signing).

## Architecture

Three execution contexts — know which one your code runs in, because they have different capabilities:

1. **`background.js` (event page)** — owns persisted state in `storage.local` under the `emacsEnabled` key. Responds to `getState` / `setState` messages and broadcasts `emacsStateChanged` to all tabs on change. Single source of truth for enabled/disabled.

2. **`content.js` (content script, isolated world)** — detects Pluto pages via `<pluto-notebook>` / `<pluto-editor>`. Cannot touch page-world CodeMirror `EditorView` instances, so it injects `emacs-mode.js` into the page context via a `<script>` tag and drives it with `CustomEvent`s on `window` (`pluto-emacs-enable`, `pluto-emacs-disable`). A `MutationObserver` covers Pluto's async DOM build.

3. **`emacs-mode.js` (page world)** — listed in `web_accessible_resources`; the actual Emacs engine, because only page-world scripts reach CM6 `EditorView`s. Responds to the enable/disable window events.

## emacs-mode.js internals

Emacs is **modeless**, so — unlike the Vim sibling — there is no per-editor mode
state machine. Instead:

- **Global state** (Emacs keeps these cross-buffer): `killRing` (capped) + `yankPointer` (M-y cycling), the `lastWasKill` / `lastWasYank` / `lastWasLineMove` streak flags, and the prefix-argument state (`prefixArg`, `prefixActive`, `prefixExplicit`).
- **Per-editor state** (`editorStates` WeakMap): `mark` (offset or null), `active` (is the region live?) and `goalCol`. While the region is active, movement commands extend the native CM6 selection (`anchor = mark`, `head = point`), which is how transient-mark-mode highlighting is achieved for free. The engine cannot install a CM6 update listener (it has no access to the page's CM6 classes), so the mark is kept valid by convention: every engine edit goes through `replaceRange`, which maps the mark through the change and deactivates the region; any key passed through to CodeMirror that might edit (`dropMark`) forgets the mark entirely; mouse clicks and `C-g` only deactivate it. `C-w` / `M-w` act on the native selection first, then on mark..point.
- **`commands` table** maps a normalised key token (e.g. `"C-f"`, `"M-<"`, `"C-x C-x"`, `"C-c C-c"`) to `(editorEl, state, count) => …`. Kill/yank commands read the streak flags, set their own, and `return false` so `runCommand` won't clear them (`killRange` is the shared helper); every other command returns undefined and both flags are reset. Vertical motions go through `lineMove`, which sets `thisIsLineMove` so consecutive ones share a goal column. `runCommand` clears the echo area *before* running the command so messages the command prints stay visible.
- **Key normalisation** (`tokenFor` / `baseKey`): Meta is **Alt only** (⌘ stays the system's on macOS) and AltGr is never a modifier. `baseKey` prefers `e.key` when it is an ASCII character — so bindings follow the user's layout (AZERTY, Dvorak) and `Shift+9` is `(`, not a digit — and falls back to `e.code` otherwise (macOS Option-diacritics / dead keys, Cyrillic or Greek layouts). Shift is not part of the token. `C-x`, `C-c`, `M-g` are two-chord prefixes handled via `pendingPrefix`.
- **Editing goes through CM6**: `view.dispatch({ changes, selection })`. There is no public CM6 API to get an `EditorView` from the DOM, so `getView` reads a private property off `.cm-content`, and **its name depends on the CodeMirror version Pluto bundles**: `cmTile.root.view` in newer `@codemirror/view` releases (as bundled by Pluto 1.0.3), `cmView.view` in older ones (Pluto 0.20.21). The view is cached per editor on `__plutoEmacsView`. If discovery fails, `handleKey` passes every key through untouched and warns once in the console — if the add-on "does nothing" after a Pluto upgrade, look here first (`grep -o 'cmTile\|cmView' ~/.julia/packages/Pluto/*/frontend-dist/*.js`). Offsets are UTF-16 code units; motions use `stepLeft`/`stepRight` to avoid landing inside surrogate pairs, and words are Unicode-aware (`WORD_RE`).
- **Key handling** (`handleKey`) is a capture-phase `keydown` listener on each editor's `.cm-content`, attached by `attach()` and kept current by a `MutationObserver` for cells created later. It first bails out for synthetic keys it replayed itself (`synthesizing`), an open isearch, IME composition, and **bare modifier keydowns** (a lone Ctrl press must not cancel a pending `C-u` / `C-x`). Then: `C-g` aborting a pending prefix → `C-u`/digit prefix arg → pending two-chord prefix → `PREFIX_KEYS` → completion-popup remap (`COMPLETION_KEYS`, when `.cm-tooltip-autocomplete` exists) → `commands` lookup → pass-through to CodeMirror (ends streaks, usually drops the mark; `C-u n <char>` self-inserts n copies). `NATIVE_KEYS` (arrows, Home/End, PageUp/PageDown) are in the table but only used when a region is active or a prefix arg is pending — otherwise CodeMirror/Pluto keep them (shift-selection, moving into the adjacent cell, completion lists). Unhandled chords are *not* swallowed; undefined two-chord sequences are.
- **Adding a binding**: add an entry to `commands` (and to `PREFIX_KEYS` if it introduces a new first chord), then update the bindings tables in `README.md`. `count` defaults to 1, so a command that must tell "no prefix arg" apart reads `prefixArg` directly (see `gotoLinePrompt`) — `runCommand` only resets it after the command returns. `C-@` is aliased to `C-Space`, and prefix-arg `Delete` / `Backspace` to `C-d` / `DEL`, inside `handleKey` before the table lookup. Add an e2e test next to the similar ones.
- **Delegation by synthetic keys**: undo / redo / `M-;` are not reimplemented — `sendCmKey` replays `Mod-z` / `Mod-y` / `Mod-/` into `contentDOM` so CodeMirror's and Pluto's own keymaps handle them (`mod()` picks Ctrl or ⌘). `C-x C-s` dispatches `Mod-s` on `document.body` for Pluto's document-level "submit all changes" handler, which our capture-phase `stopPropagation` would otherwise shadow.
- **Minibuffer UX**: a bottom-left "Emacs" badge, a transient echo area (prefix keys / messages via `echo()`), and an inline input bar for incremental search (`C-s`/`C-r`) and the goto-line prompt. `openMinibuffer` builds the bar for both prompts and `activePrompt.close(accept, refocus)` tears it down (blur closes it, so it can't be orphaned). Isearch is within the current cell only, wraps, is case-insensitive for lowercase queries, and leaves the mark at the start on accept. The engine creates these elements in the page world, but their styles (`.pluto-emacs-*`, plus `.cm-editor.pluto-emacs-active`) live in `content.css`, which the manifest injects as content-script CSS — change class names in both places. While the isearch bar is open it owns the keyboard (`handleKey` returns early; the bar's own listener stops propagation).
- **Cell ops** are best-effort DOM against Pluto's markup: `runCell` replays Shift-Enter; add clicks `button.add_cell.before|after`; delete has no standing button — `deleteCell` opens the cell's `button.input_context_menu`, polls for the `button.delete` item that Preact renders only while the menu is open, clicks it, then waits for the cell to leave the DOM and focuses the neighbour. `findButton` (title/aria/text match) is the fallback. Pluto itself shows a `confirm()` and interrupts instead of deleting when the cell is queued or running.

## State flow

The **toolbar popup** (`popup/`) is the only user-facing control: a single checkbox that reads state via a `getState` message on open and sends `setState` on toggle. It never touches `storage.local` directly — background owns that.

Popup or background → `storage.local` → broadcast `emacsStateChanged` to all tabs → `content.js` injects/enables or disables → dispatches window event → page-world `emacs-mode.js` attaches to or detaches from CodeMirror views.

Note the asymmetry: on a `setState` broadcast `content.js` both injects `emacs-mode.js` *and* dispatches the enable event, but on first page load (`boot`) it only injects if already enabled — the engine self-attaches on inject. `emacsEnabled` defaults to `true`: `onInstalled` seeds it only for `reason === 'install'` and only if unset (the event also fires on updates and add-on reloads, which must not undo a disabled state), and absence reads as enabled.

Disabling never removes the injected `<script>`: the engine stays loaded (guarded by `window.__plutoEmacsLoaded`), detaches its listeners and UI, and is revived by the next `pluto-emacs-enable` event. Kill ring and other module-scope state therefore survive a toggle but not a page reload. Both paths (`boot` and the broadcast listener) check `isPlutoPage()`, because the manifest patterns match every localhost dev server; the fallback `MutationObserver` only runs when the page isn't already Pluto and gives up after 30 s.

## Known limits

- Firefox reserves `C-n`, `C-w`, `C-t` (and `C-q` on Linux): they never reach the page, so those bindings cannot work in a real browser no matter what the engine does — see "Known browser conflicts" in `README.md`. They *do* work under Playwright, which injects keys below the browser chrome, so a passing e2e test says nothing about reserved shortcuts.
- `C-y` reads the kill ring only; kills are mirrored *to* the system clipboard, but reading it back would need a permission prompt.
- Multiple cursors are ignored (commands act on the main selection), and columns are UTF-16 offsets, not visual columns (tabs, wide characters).
