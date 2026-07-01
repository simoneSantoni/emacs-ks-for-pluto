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
4. Toggle on/off from the toolbar popup (reload the Pluto tab after toggling).

A temporary add-on is removed when Firefox restarts. To package a signed `.xpi`
for permanent install, see [`store/build-zip.sh`](store/build-zip.sh) and Mozilla's
[web-ext](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
tooling.

## Supported bindings

Emacs is modeless — ordinary keys self-insert; only the chords below are
intercepted. **Meta** is <kbd>Alt</kbd> (or <kbd>⌘</kbd>).

### Movement

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| `C-f` / `C-b` | forward / backward char | `M-f` / `M-b` | forward / backward word |
| `C-n` / `C-p` | next / previous line | `C-a` / `C-e` | line start / end |
| `C-v` / `M-v` | page down / up | `M-<` / `M->` | buffer start / end |
| `M-g g` / `M-g M-g` | goto line (prompt or prefix arg) | arrows | char / line motion |

### Region, kill & yank

- `C-Space` (or `C-@`) — set the mark; movement then extends the region.
- `C-w` — kill (cut) region, `M-w` — copy region to the kill ring.
- `C-k` — kill to end of line (consecutive `C-k` append).
- `M-d` — kill word forward, `M-DEL` — kill word backward.
- `C-d` / `Delete` — delete char forward.
- `C-y` — yank, `M-y` — yank-pop (cycle the kill ring, only right after a yank).
- `C-x C-x` — exchange point and mark, `C-x h` — mark whole buffer.

Kills/copies are also mirrored to the system clipboard where the browser allows it.

### Editing & case

- `C-o` — open line, `C-j` — newline, `C-t` — transpose chars.
- `M-u` / `M-l` / `M-c` — upcase / downcase / capitalize word.
- `C-/`, `C-_`, `C-x u` — undo (delegates to CodeMirror history).

### Search

- `C-s` / `C-r` — incremental search forward / backward. While searching:
  `C-s` / `C-r` jump to the next / previous match, `Enter` accepts, `C-g` / `Esc` cancels.

### Prefix arguments

- `C-u` — universal argument (`C-u` = 4, `C-u C-u` = 16, `C-u 25` = 25).
- `M-<digit>` — numeric argument. Applies to the next movement/kill/case command.

### Cell (notebook) operations

- `C-c C-c` or `C-x C-s` — evaluate the current cell (Pluto's Shift-Enter).
- `C-c C-n` / `C-c C-p` — focus next / previous cell.
- `C-c C-a` / `C-c C-o` — add a cell below / above (best-effort via Pluto's buttons).
- `C-c C-k` — delete the current cell (best-effort).

## Known browser conflicts

A few chords are reserved by Firefox itself and may not reach the page (e.g.
`C-w` can close the tab, `C-d` may bookmark). This is a browser-level limit on
extensions; prefer the mouse or Pluto's own controls for those, or remap the
reserved shortcuts in Firefox.

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for a tour of the three execution contexts and how
state flows between them.

## License

MIT — see [`LICENSE`](LICENSE).
