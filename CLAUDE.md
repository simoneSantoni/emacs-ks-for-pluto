# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Firefox add-on (Manifest V3) that adds Emacs-style keybindings to Julia's Pluto
notebook editor cells (which are CodeMirror 6 instances). It is the Emacs
counterpart to the Chrome extension `vim-kb-for-pluto` and mirrors its layout.

## Loading & testing the add-on

No build step — this is plain JS/CSS loaded directly by Firefox.

- Load: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → pick `manifest.json`.
- Test against a running Pluto server at `http://localhost:*`, `http://127.0.0.1:*`, or `https://localhost:*` (see `manifest.json` match patterns).
- After editing `background.js`, `content.js`, `emacs-mode.js`, or `manifest.json`, click "Reload" on the add-on card and hard-reload the Pluto tab.
- Package for distribution with `store/build-zip.sh` (produces the upload ZIP; sign via AMO / `web-ext`).
- Mozilla's `web-ext` (not vendored — `npx web-ext …` or install globally) reads `web-ext-config.mjs`, which excludes dev-only files (`store/**`, docs, `*.zip`/`*.xpi`) from lint/build output:
  - `npx web-ext lint` — validate the add-on the way AMO's automated review does; run before any submission.
  - `npx web-ext run` — launch Firefox with the add-on side-loaded and auto-reloading.
  - `npx web-ext build` / `web-ext sign` — produce/sign an `.xpi` (alternative to `store/build-zip.sh`).

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

- **Global state** (Emacs keeps these cross-buffer): `killRing` + `yankPointer` (M-y cycling), `lastWasKill` / `lastWasYank` streak flags, and the prefix-argument state (`prefixArg`, `prefixActive`, `prefixExplicit`).
- **Per-editor state** (`editorStates` WeakMap): just `mark` — the active-region anchor. When the mark is set, movement commands extend the native CM6 selection (`anchor = mark`, `head = point`), which is how transient-mark-mode highlighting is achieved for free.
- **`commands` table** maps a normalised key token (e.g. `"C-f"`, `"M-<"`, `"C-x C-x"`, `"C-c C-c"`) to `(editorEl, state, count) => …`. Kill/yank commands read the streak flags, set their own, and `return false` so `runCommand` won't clear them; every other command returns undefined and both flags are reset.
- **Key normalisation** (`tokenFor` / `baseKey`) derives a token from `e.ctrlKey`/`e.altKey`/`e.metaKey` and `e.code` (letters/digits, to dodge Alt-diacritics) or `e.key` (punctuation, named keys). `C-x`, `C-c`, `M-g` are two-chord prefixes handled via `pendingPrefix`.
- **Editing goes through CM6**: `view.dispatch({ changes, selection })`. The engine finds the `EditorView` by probing DOM nodes for a `cmView.view` property (no public CM6 API for this), cached per editor on `__plutoEmacsView`.
- **Minibuffer UX**: a bottom-left "Emacs" badge, a transient echo area (prefix keys / messages via `echo()`), and an inline input bar for incremental search (`C-s`/`C-r`) and the goto-line prompt.
- **Cell ops** are best-effort DOM: `runCell` dispatches Shift-Enter to the cell's `contentDOM`; add/delete click Pluto's own buttons (`findButton` matches by title/aria/text); navigation focuses the adjacent cell's `.cm-content`.

## State flow

The **toolbar popup** (`popup/`) is the only user-facing control: a single checkbox that reads state via a `getState` message on open and sends `setState` on toggle. It never touches `storage.local` directly — background owns that.

Popup or background → `storage.local` → broadcast `emacsStateChanged` to all tabs → `content.js` injects/enables or disables → dispatches window event → page-world `emacs-mode.js` attaches to or detaches from CodeMirror views.

Note the asymmetry: on a `setState` broadcast `content.js` both injects `emacs-mode.js` *and* dispatches the enable event, but on first page load (`boot`) it only injects if already enabled — the engine self-attaches on inject. `emacsEnabled` defaults to `true` (set on `onInstalled`; absence reads as enabled).
