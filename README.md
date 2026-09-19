# emacs-ks-for-pluto

Firefox add-on bringing Emacs key strokes to Julia's [Pluto](https://plutojl.org/) notebook editor.

It is the Emacs counterpart to the Chrome
[vim-kb-for-pluto](https://github.com/) extension and shares the same three-part
architecture (background event page, isolated content script, page-world engine).

## Install (temporary / development)

1. Clone this repo.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**,
   and select the `manifest.json` in the repo root.
3. Open a Pluto notebook at `http://localhost:*`, `http://127.0.0.1:*`, or
   `https://localhost:*`. An **Emacs** badge appears at the bottom-left when the
   add-on is active.
4. Toggle on/off from the toolbar popup; open Pluto tabs follow immediately.

Works with both current Pluto (1.x) and the 0.20 series — the two bundle
different CodeMirror internals, and the engine handles either.

A temporary add-on is removed when Firefox restarts. To package a signed `.xpi`
for permanent install, see [`store/build-zip.sh`](store/build-zip.sh) and Mozilla's
[web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
tooling.

## Supported bindings

Emacs is modeless — ordinary keys self-insert; only the chords below are
intercepted. **Meta** is <kbd>Alt</kbd> (<kbd>⌥ Option</kbd> on macOS; <kbd>⌘</kbd>
is left to the system so copy / paste / find keep working). Bindings follow the
letters of your keyboard layout (AZERTY, Dvorak, …); on non-Latin layouts they
fall back to the physical QWERTY positions.

### Movement

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| `C-f` / `C-b` | forward / backward char | `M-f` / `M-b` | forward / backward word |
| `C-n` / `C-p` | next / previous line | `C-a` / `C-e` | line start / end |
| `C-v` / `M-v` | page down / up | `M-<` / `M->` | buffer start / end |
| `M-g g` / `M-g M-g` | goto line (prompt or prefix arg) | `M-m` | back to indentation |
| `C-l` | scroll point to the middle of the window | | |

`C-n` / `C-p` keep their goal column across shorter lines. Arrow keys, `Home` /
`End` and `PageUp` / `PageDown` stay native (shift-selection, moving into the
neighbouring cell, …) until there is an active region to extend or a prefix
argument to apply. While a completion popup is open, `C-n` / `C-p` / `C-v` /
`M-v` move through it and `C-g` closes it.

### Region, kill & yank

- `C-Space` (or `C-@`) — set the mark; movement then extends the region.
  Editing or `C-g` deactivates it; a mouse click does too.
- `C-w` — kill (cut) region, `M-w` — copy region to the kill ring. Both also
  work on a mouse / shift selection.
- `C-k` — kill to end of line (consecutive kills append); `C-u n C-k` kills
  `n` whole lines.
- `M-d` — kill word forward, `M-DEL` — kill word backward.
- `C-d` / `Delete` — delete char forward.
- `C-y` — yank, `M-y` — yank-pop (cycle the kill ring, only right after a yank).
- `C-x C-x` — exchange point and mark, `C-x h` — mark whole buffer.

Kills/copies are also mirrored to the system clipboard where the browser allows
it. The reverse is not true: `C-y` yanks from the kill ring only (reading the
clipboard would raise a permission prompt) — use the browser's paste for text
copied elsewhere.

### Editing & case

- `C-o` — open line, `C-j` — newline, `C-t` — transpose chars.
- `M-u` / `M-l` / `M-c` — upcase / downcase / capitalize word.
- `M-;` — toggle comment (Pluto's own command).
- `C-/`, `C-_`, `C-x u` — undo, `C-?` — redo (both delegate to CodeMirror history).

Words are Unicode-aware, so `M-f`, `M-d`, … treat `α`, `∇f` or `x₁` as words.

### Search

- `C-s` / `C-r` — incremental search forward / backward within the cell. While
  searching: `C-s` / `C-r` jump to the next / previous match (wrapping around),
  `Enter` accepts, `C-g` / `Esc` returns to where you started, and any other
  chord (`C-a`, `M-f`, …) accepts and then runs. An empty `C-s C-s` reuses the
  previous search string. A lowercase query matches case-insensitively. On
  accept the mark is left at the starting point, so `C-x C-x` jumps back.

### Prefix arguments

- `C-u` — universal argument (`C-u` = 4, `C-u C-u` = 16, `C-u 25` = 25).
- `M-<digit>` — numeric argument. Applies to the next movement/kill/case command;
  followed by an ordinary character it inserts that many copies (`C-u 8 0 -`).

### Cell (notebook) operations

- `C-c C-c` — evaluate the current cell (Pluto's Shift-Enter).
- `C-x C-s` — submit all changes: run every edited cell (Pluto's Ctrl-S; the
  notebook file itself autosaves).
- `C-c C-n` / `C-c C-p` — focus next / previous cell.
- `C-c C-a` / `C-c C-o` — add a cell below / above (clicks Pluto's own buttons).
- `C-c C-k` — delete the current cell (via the cell's ⋯ menu). Pluto asks for
  confirmation if the cell is still running.

## Known browser conflicts

Firefox reserves a handful of shortcuts that **never reach the page**, so no
add-on can rebind them:

| Chord | Firefox does | Use instead |
| --- | --- | --- |
| `C-n` | new window | <kbd>↓</kbd> |
| `C-w` | close tab | `M-w` then delete, or the browser's cut |
| `C-t` | new tab | — |
| `C-q` (Linux) | quit | — |

Everything else in the tables above — including `C-d`, `C-l`, `C-k`, `C-s`,
`M-d`, `M-f` — is an ordinary shortcut that the add-on overrides while a cell
has focus. (On Chromium-family browsers the reserved set is the same.)

## Tests

`test/` holds a dev-only harness (not part of the packaged add-on):

```sh
cd test && npm install          # Playwright; add `npx playwright install firefox` once
npm run test:unit               # background.js / content.js against a fake browser API
npm run test:e2e                # the engine against a real Pluto notebook in Firefox
```

The end-to-end run starts its own Pluto server (`julia` must have Pluto
installed — point `PLUTO_JULIA_PROJECT` at a project that does, or set
`PLUTO_URL` to reuse a server started with `require_secret_for_access=false`).

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for a tour of the three execution contexts and how
state flows between them.

## License

MIT — see [`LICENSE`](LICENSE).
