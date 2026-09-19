// emacs-mode.js — page-world Emacs engine for Pluto's CodeMirror 6 cells.
//
// Runs in the page (not the isolated content-script world) so it can reach
// CodeMirror EditorView instances. It hooks keydown in the capture phase on
// `.cm-content` elements and dispatches edits through CM6's
// `view.dispatch({ changes, selection })` API.
//
// Emacs is modeless: text keys self-insert as usual and we only intercept the
// specific control/meta chords and prefix sequences we implement. State that
// Emacs keeps globally (the kill ring, the last-command flags) lives at module
// scope; state that is per-buffer (the mark) lives in a per-editor record.
(function () {
  'use strict';

  if (window.__plutoEmacsLoaded) return;
  window.__plutoEmacsLoaded = true;

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const KILL_RING_MAX = 60;

  // ---------- Global (cross-buffer) state ----------
  const killRing = [];        // most-recent kill is last
  let yankPointer = -1;       // index into killRing of the last yank (for M-y)
  let lastYankRange = null;   // { editorEl, from, to } of the last yank
  let lastWasKill = false;    // consecutive kills append to the top entry
  let lastWasYank = false;    // M-y only valid immediately after a yank
  let lastWasLineMove = false; // consecutive C-n/C-p keep their goal column
  let thisIsLineMove = false;  // set by the running command, read by runCommand

  // Prefix argument (C-u / M-<digit>) — transient, applies to the next command.
  let prefixArg = null;       // null, or an integer count
  let prefixActive = false;   // C-u seen, still accumulating
  let prefixExplicit = false; // a digit was typed, so the next digit appends
                              // rather than replacing C-u's implicit 4

  // Multi-key prefix (C-x, C-c, M-g) — the pending first chord, or null.
  let pendingPrefix = null;

  // True while we replay a synthetic key into CodeMirror (undo, Shift-Enter…)
  // so our own capture listener lets it through untouched.
  let synthesizing = false;

  // ---------- Per-editor state ----------
  // `mark` is a document offset or null. `active` says whether the region is
  // live (movement extends the selection). Engine edits map the mark through
  // the change and deactivate it; native edits, which we can't observe, drop it.
  const editorStates = new WeakMap();
  function getState(editorEl) {
    let s = editorStates.get(editorEl);
    if (!s) {
      s = { mark: null, active: false, goalCol: null };
      editorStates.set(editorEl, s);
    }
    return s;
  }

  // ---------- CM6 view discovery ----------
  // CM6 has no public DOM → EditorView lookup from outside the bundle
  // (`EditorView.findFromDOM` needs the page's own class). The view hangs off a
  // private property of the content DOM, whose name changed over time:
  //   newer @codemirror/view:  node.cmTile.root.view   (seen in Pluto 1.0.3)
  //   older releases:          node.cmView.view        (seen in Pluto 0.20.21)
  function viewFromNode(n) {
    let v = null;
    if (n.cmTile) v = (n.cmTile.root && n.cmTile.root.view) || n.cmTile.view;
    if (!v && n.cmView) v = n.cmView.view || (n.cmView.rootView && n.cmView.rootView.view);
    return v && v.state && typeof v.dispatch === 'function' ? v : null;
  }
  let warnedNoView = false;
  function getView(editorEl) {
    if (!editorEl) return null;
    const cached = editorEl.__plutoEmacsView;
    if (cached && cached.dom && cached.dom.isConnected) return cached;
    const content = editorEl.querySelector('.cm-content');
    let view = (content && viewFromNode(content)) || viewFromNode(editorEl);
    if (!view) {
      for (const n of editorEl.querySelectorAll('*')) {
        if ((view = viewFromNode(n))) break;
      }
    }
    if (view) editorEl.__plutoEmacsView = view;
    else if (!warnedNoView) {
      warnedNoView = true;
      console.warn('[pluto-emacs] could not find the CodeMirror EditorView; keys pass through untouched.');
    }
    return view;
  }

  // ---------- Text access helpers ----------
  function getDoc(editorEl) {
    const view = getView(editorEl);
    return view ? view.state.doc : null;
  }
  function getCursor(editorEl) {
    const view = getView(editorEl);
    return view ? view.state.selection.main.head : 0;
  }
  function getSelRange(editorEl) {
    const view = getView(editorEl);
    if (!view) return { from: 0, to: 0 };
    const s = view.state.selection.main;
    return { from: s.from, to: s.to };
  }
  function setCursor(editorEl, pos) {
    const view = getView(editorEl);
    if (!view) return;
    const len = view.state.doc.length;
    const clamped = Math.max(0, Math.min(len, pos));
    view.dispatch({ selection: { anchor: clamped }, scrollIntoView: true });
  }
  function setSelection(editorEl, anchor, head) {
    const view = getView(editorEl);
    if (!view) return;
    const len = view.state.doc.length;
    view.dispatch({
      selection: {
        anchor: Math.max(0, Math.min(len, anchor)),
        head: Math.max(0, Math.min(len, head)),
      },
      scrollIntoView: true,
    });
  }
  // Replace [from, to) with `insert`. Point lands after the insertion unless
  // `cursor` says otherwise. The mark is carried through the change and the
  // region deactivated, as Emacs does after a buffer modification.
  function replaceRange(editorEl, from, to, insert, cursor) {
    const view = getView(editorEl);
    if (!view) return;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: cursor != null ? cursor : from + insert.length },
      scrollIntoView: true,
      userEvent: insert ? 'input' : 'delete',
    });
    const st = getState(editorEl);
    st.active = false;
    if (st.mark != null) {
      if (st.mark >= to) st.mark += insert.length - (to - from);
      else if (st.mark > from) st.mark = from;
    }
  }
  function docLine(editorEl, pos) {
    const doc = getDoc(editorEl);
    return doc ? doc.lineAt(pos) : null;
  }

  function setMark(state, pos) { state.mark = pos; state.active = true; }
  function deactivateMark(state) { state.active = false; }
  function dropMark(state) { state.mark = null; state.active = false; }

  // Move point to `target`. If the region is active, extend it so the native
  // CM6 selection reflects it (transient-mark-mode style).
  function goTo(editorEl, state, target) {
    if (state.active && state.mark != null) setSelection(editorEl, state.mark, target);
    else setCursor(editorEl, target);
  }

  // ---------- Motions (return a new offset) ----------
  // Offsets are UTF-16 code units, so step over surrogate pairs as one char.
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
  function stepRight(text, p) {
    return p + (isHigh(text.charCodeAt(p)) && isLow(text.charCodeAt(p + 1)) ? 2 : 1);
  }
  function stepLeft(text, p) {
    return p - (p >= 2 && isLow(text.charCodeAt(p - 1)) && isHigh(text.charCodeAt(p - 2)) ? 2 : 1);
  }
  function charLeft(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count && p > 0; i++) p = stepLeft(text, p);
    return Math.max(0, p);
  }
  function charRight(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count && p < text.length; i++) p = stepRight(text, p);
    return Math.min(text.length, p);
  }
  // Vertical motion with an Emacs-style goal column: a run of consecutive line
  // moves remembers the column it started from across shorter lines.
  function lineMove(editorEl, state, delta) {
    const doc = getDoc(editorEl);
    const pos = getCursor(editorEl);
    const line = doc.lineAt(pos);
    const col = (lastWasLineMove && state.goalCol != null) ? state.goalCol : pos - line.from;
    state.goalCol = col;
    thisIsLineMove = true;
    const target = doc.line(Math.max(1, Math.min(doc.lines, line.number + delta)));
    let p = target.from + Math.min(col, target.length);
    if (p > target.from && isLow(target.text.charCodeAt(p - target.from))) p--; // not inside a pair
    goTo(editorEl, state, p);
  }
  function lineStart(editorEl, pos) { return docLine(editorEl, pos).from; }
  function lineEnd(editorEl, pos) { return docLine(editorEl, pos).to; }
  function indentation(editorEl, pos) {
    const line = docLine(editorEl, pos);
    return line.from + line.text.match(/^[ \t]*/)[0].length;
  }
  function docEnd(editorEl) { return getDoc(editorEl).length; }
  function gotoLine(editorEl, n) {
    const doc = getDoc(editorEl);
    return doc.line(Math.max(1, Math.min(doc.lines, n))).from;
  }
  // Page motion: a screenful of lines. Pluto cells grow with their content, so
  // the window — not the editor box — is what bounds a "screen".
  function pageLines(editorEl) {
    const view = getView(editorEl);
    if (!view) return 20;
    const lineH = view.defaultLineHeight || 18;
    const height = Math.min(view.dom.clientHeight || Infinity, window.innerHeight || Infinity);
    return Math.max(1, Math.floor((isFinite(height) ? height : 400) / lineH) - 2);
  }

  // Julia code is full of Unicode identifiers (α, ∇f, x₁), so "word" means any
  // letter / number / mark / underscore, not just ASCII.
  const WORD_RE = /[\p{L}\p{N}\p{M}_]/u;
  function wordCharAt(text, p) {            // char starting at p
    if (p < 0 || p >= text.length) return false;
    return WORD_RE.test(String.fromCodePoint(text.codePointAt(p)));
  }
  function wordForward(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count; i++) {
      while (p < text.length && !wordCharAt(text, p)) p = stepRight(text, p);
      while (p < text.length && wordCharAt(text, p)) p = stepRight(text, p);
    }
    return Math.min(text.length, p);
  }
  function wordBackward(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count; i++) {
      while (p > 0 && !wordCharAt(text, stepLeft(text, p))) p = stepLeft(text, p);
      while (p > 0 && wordCharAt(text, stepLeft(text, p))) p = stepLeft(text, p);
    }
    return Math.max(0, p);
  }

  // ---------- Kill ring ----------
  function pushKill(text, prepend) {
    if (lastWasKill && killRing.length) {
      // Append/prepend to the current top entry for consecutive kills.
      const top = killRing[killRing.length - 1];
      killRing[killRing.length - 1] = prepend ? text + top : top + text;
    } else {
      killRing.push(text);
      if (killRing.length > KILL_RING_MAX) killRing.shift();
    }
    yankPointer = killRing.length - 1;
    toClipboard(killRing[yankPointer]);
  }
  function copyToRing(text) {
    if (!text) return;
    killRing.push(text);
    if (killRing.length > KILL_RING_MAX) killRing.shift();
    yankPointer = killRing.length - 1;
    toClipboard(text);
  }

  // Write to the system clipboard too, best-effort, so kills interoperate with
  // the OS (Emacs' "interprogram-cut" behaviour).
  function toClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }

  // Kill `[from, to)` as one streak-aware kill. Returns false for runCommand.
  function killRange(editorEl, from, to, prepend) {
    if (to <= from) return;
    pushKill(getDoc(editorEl).sliceString(from, to), prepend);
    replaceRange(editorEl, from, to, '');
    lastWasKill = true; lastWasYank = false;
    return false;
  }

  // The region is the native selection when there is one (an active mark, or a
  // mouse / shift selection), else mark..point even if the mark is inactive.
  function regionBounds(editorEl, state) {
    const selRange = getSelRange(editorEl);
    if (selRange.from !== selRange.to) return selRange;
    if (state.mark == null) return null;
    const p = getCursor(editorEl);
    return { from: Math.min(state.mark, p), to: Math.max(state.mark, p) };
  }
  function killRegion(editorEl, state, copyOnly) {
    const r = regionBounds(editorEl, state);
    if (!r) { echo('No mark set'); return; }
    if (r.from === r.to) { deactivateMark(state); return; }
    if (!copyOnly) return killRange(editorEl, r.from, r.to, false);
    copyToRing(getDoc(editorEl).sliceString(r.from, r.to));
    deactivateMark(state);
    setCursor(editorEl, getCursor(editorEl));
  }

  // ---------- Case commands ----------
  function transformWord(editorEl, fn, count) {
    const from = getCursor(editorEl);
    const to = wordForward(editorEl, from, count);
    if (to <= from) return;
    replaceRange(editorEl, from, to, fn(getDoc(editorEl).sliceString(from, to)));
  }
  const capitalizeStr = (s) =>
    s.toLowerCase().replace(/(^|[^\p{L}\p{N}\p{M}_])([\p{L}\p{N}])/gu, (m, pre, c) => pre + c.toUpperCase());

  // ---------- Echo area (minibuffer) ----------
  let badgeEl = null;
  let echoEl = null;
  function ensureBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.className = 'pluto-emacs-badge';
    badgeEl.textContent = 'Emacs';
    document.body.appendChild(badgeEl);
  }
  let echoTimer = null;
  function echo(msg) {
    if (!msg && !echoEl) return;
    ensureBadge();
    if (!echoEl) {
      echoEl = document.createElement('div');
      echoEl.className = 'pluto-emacs-echo';
      document.body.appendChild(echoEl);
    }
    echoEl.textContent = msg;
    echoEl.style.display = msg ? 'block' : 'none';
    if (echoTimer) clearTimeout(echoTimer);
    if (msg) echoTimer = setTimeout(() => { if (echoEl) echoEl.style.display = 'none'; }, 2500);
  }
  function echoPrefix() {
    let s = '';
    if (prefixActive) s = prefixExplicit || prefixArg !== 4 ? `C-u ${prefixArg}` : 'C-u';
    if (pendingPrefix) s = (s ? s + ' ' : '') + pendingPrefix + '-';
    echo(s);
  }

  // An input bar in the echo-area slot, shared by isearch and goto-line.
  let activePrompt = null;    // { close(accept, refocus) } of the open bar
  function openMinibuffer(labelText) {
    if (activePrompt) activePrompt.close(false, false);
    echo('');
    const bar = document.createElement('div');
    bar.className = 'pluto-emacs-isearch';
    const label = document.createElement('span');
    label.className = 'pluto-emacs-isearch-label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'pluto-emacs-isearch-input';
    input.type = 'text';
    input.setAttribute('aria-label', labelText.trim());
    bar.appendChild(label);
    bar.appendChild(input);
    document.body.appendChild(bar);
    input.focus();
    return { bar, label, input };
  }
  function focusEditor(editorEl) {
    const view = getView(editorEl);
    if (view) view.focus();
    else { const c = editorEl.querySelector('.cm-content'); if (c) c.focus(); }
  }

  // ---------- Cell (notebook) helpers ----------
  function allCells() { return Array.from(document.querySelectorAll('pluto-cell')); }
  function cellOf(node) { return node && node.closest ? node.closest('pluto-cell') : null; }
  function focusCellEl(cell) {
    const content = cell && cell.querySelector('.cm-content');
    if (!content) return false;
    content.focus();
    cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return true;
  }
  function focusNeighbour(editorEl, delta) {
    const cells = allCells();
    const i = cells.indexOf(cellOf(editorEl));
    if (i < 0) return;
    const j = i + delta;
    if (j < 0) { echo('Beginning of notebook'); return; }
    if (j >= cells.length) { echo('End of notebook'); return; }
    focusCellEl(cells[j]);
  }
  function findButton(root, keywords) {
    for (const b of root.querySelectorAll('button')) {
      const label = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
      if (keywords.every((k) => label.includes(k))) return b;
    }
    return null;
  }
  function addCell(editorEl, after) {
    const cell = cellOf(editorEl);
    if (!cell) return;
    const btn = cell.querySelector(after ? 'button.add_cell.after' : 'button.add_cell.before') ||
      findButton(cell, ['add', after ? 'below' : 'above']) ||
      findButton(cell, ['add', after ? 'after' : 'before']);
    if (btn) btn.click();
    else echo('Could not find Pluto\'s add-cell button');
  }
  // Pluto keeps "Delete cell" inside the cell's ⋯ context menu, which is only
  // rendered while open: open it, wait for the item, click it.
  function deleteCell(editorEl) {
    const cell = cellOf(editorEl);
    if (!cell) return;
    const cells = allCells();
    const i = cells.indexOf(cell);
    const neighbour = cells[i + 1] || cells[i - 1] || null;
    const findDelete = () =>
      cell.querySelector('.input_context_menu button.delete, button.delete_cell') ||
      findButton(cell, ['delete']);
    // Pluto removes the cell after a round trip to the server; once it is gone,
    // keep the keyboard in the notebook by focusing the neighbour.
    const finish = (btn) => {
      btn.click();
      let waited = 0;
      const refocus = () => {
        if (!cell.isConnected) { if (neighbour) focusCellEl(neighbour); }
        else if ((waited += 50) < 3000) setTimeout(refocus, 50);
      };
      setTimeout(refocus, 50);
    };
    let btn = findDelete();
    if (btn) { finish(btn); return; }
    const menu = cell.querySelector('button.input_context_menu');
    if (!menu) { echo('Could not find Pluto\'s delete-cell control'); return; }
    menu.click();
    let tries = 0;
    const poll = () => {
      btn = findDelete();
      if (btn) finish(btn);
      else if (++tries < 40) setTimeout(poll, 25);
      else { menu.click(); echo('Could not find Pluto\'s delete-cell control'); }
    };
    poll();
  }

  // Replay a key into CodeMirror so Pluto's / CM's own keymaps handle it.
  function sendCmKey(editorEl, opts) {
    const view = getView(editorEl);
    const target = view ? view.contentDOM : editorEl.querySelector('.cm-content');
    if (!target) return;
    synthesizing = true;
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts }));
    } finally {
      synthesizing = false;
    }
  }
  const mod = (opts) => (IS_MAC ? { metaKey: true, ...opts } : { ctrlKey: true, ...opts });
  function runCell(editorEl) {
    // Pluto runs a cell on Shift-Enter.
    sendCmKey(editorEl, { key: 'Enter', code: 'Enter', shiftKey: true });
  }
  // Pluto's Ctrl-S ("submit all changes": run every edited cell; the file itself
  // autosaves) is a document-level handler our capture listener shadows.
  function submitAllChanges() {
    document.body.dispatchEvent(new KeyboardEvent('keydown',
      mod({ key: 's', code: 'KeyS', bubbles: true, cancelable: true })));
  }
  function undo(editorEl, state) {
    dropMark(state); // history changes aren't mapped
    sendCmKey(editorEl, mod({ key: 'z', code: 'KeyZ' }));
  }
  function redo(editorEl, state) {
    dropMark(state);
    sendCmKey(editorEl, IS_MAC ? { key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }
                               : { key: 'y', code: 'KeyY', ctrlKey: true });
  }

  // While CodeMirror's completion popup is open these chords drive it instead.
  function completionOpen() { return document.querySelector('.cm-tooltip-autocomplete') !== null; }
  const COMPLETION_KEYS = {
    'C-n': { key: 'ArrowDown', code: 'ArrowDown' },
    'C-p': { key: 'ArrowUp', code: 'ArrowUp' },
    'C-v': { key: 'PageDown', code: 'PageDown' },
    'M-v': { key: 'PageUp', code: 'PageUp' },
    'C-g': { key: 'Escape', code: 'Escape' },
  };

  // ---------- Incremental search ----------
  let isearch = null; // { editorEl, dir, query, start, match, label, wrapped }
  let lastSearch = '';
  function isearchLabel() {
    if (!isearch) return;
    const failed = isearch.query && !isearch.match;
    isearch.label.textContent = (failed ? 'Failing ' : isearch.wrapped ? 'Wrapped ' : '') +
      (isearch.dir > 0 ? 'I-search: ' : 'I-search backward: ');
    isearch.label.classList.toggle('pluto-emacs-isearch-fail', !!failed);
  }
  function openIsearch(editorEl, dir) {
    const start = getCursor(editorEl);
    const { bar, label, input } = openMinibuffer('');
    isearch = { editorEl, dir, query: '', start, match: null, label, wrapped: false };
    isearchLabel();

    const close = (accept, refocus) => {
      if (!isearch) return;
      const { match, query, dir: d } = isearch;
      isearch = null;
      activePrompt = null;
      bar.remove();
      if (query) lastSearch = query;
      if (refocus) focusEditor(editorEl);
      if (accept && match) {
        // Like Emacs, leave the mark (inactive) where the search started.
        const st = getState(editorEl);
        st.mark = start; st.active = false;
        setCursor(editorEl, d > 0 ? match.to : match.from);
      } else {
        setCursor(editorEl, start);
      }
    };
    activePrompt = { close };

    input.addEventListener('input', () => {
      const extending = input.value.startsWith(isearch.query) && isearch.match;
      isearch.query = input.value;
      isearch.wrapped = false;
      if (extending) searchFrom(isearch.match.from, isearch.dir);
      else searchFrom(isearch.dir > 0 ? isearch.start : isearch.start - isearch.query.length, isearch.dir);
    });
    input.addEventListener('blur', () => close(true, false));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (isModifierKey(e) || e.isComposing) return;
      const token = tokenFor(e);
      if (token === 'Enter') {
        e.preventDefault(); close(true, true);
      } else if (token === 'Escape' || token === 'C-g') {
        e.preventDefault(); close(false, true);
      } else if (token === 'C-s' || token === 'C-r') {
        e.preventDefault();
        const dir = token === 'C-s' ? 1 : -1;
        isearch.dir = dir;
        if (!isearch.query && lastSearch) {
          input.value = isearch.query = lastSearch;
          searchFrom(dir > 0 ? isearch.start : isearch.start - lastSearch.length, dir);
        } else if (isearch.match) {
          searchFrom(isearch.match.from + dir, dir);
        } else {
          // Failing: try again from the far end, as a second C-s does in Emacs.
          isearch.wrapped = true;
          searchFrom(dir > 0 ? 0 : Infinity, dir);
        }
      } else if (/^(C-|M-)/.test(token)) {
        // Any other command chord ends the search here and then runs.
        e.preventDefault();
        close(true, true);
        handleKey(editorEl, e);
      }
    }, true);
  }
  // Find the next match at or after (dir > 0) / at or before (dir < 0) `fromPos`,
  // wrapping around once. A lowercase query matches case-insensitively.
  function searchFrom(fromPos, dir) {
    if (!isearch) return;
    const q = isearch.query;
    if (!q) { isearch.match = null; setCursor(isearch.editorEl, isearch.start); isearchLabel(); return; }
    let text = getDoc(isearch.editorEl).toString();
    if (q === q.toLowerCase()) {
      const folded = text.toLowerCase();
      if (folded.length === text.length) text = folded;
    }
    let idx;
    if (dir > 0) {
      idx = text.indexOf(q, Math.max(0, fromPos));
      if (idx === -1) { idx = text.indexOf(q); if (idx !== -1) isearch.wrapped = true; }
    } else {
      idx = fromPos < 0 ? -1 : text.lastIndexOf(q, fromPos);
      if (idx === -1) { idx = text.lastIndexOf(q); if (idx !== -1) isearch.wrapped = true; }
    }
    if (idx >= 0) {
      isearch.match = { from: idx, to: idx + q.length };
      setSelection(isearch.editorEl, idx, idx + q.length);
    } else {
      isearch.match = null;
    }
    isearchLabel();
  }

  function gotoLinePrompt(editorEl, state) {
    const n = prefixArg;
    if (n != null) { goTo(editorEl, state, gotoLine(editorEl, n)); return; }
    // No prefix arg: ask in the echo area via a small inline prompt.
    const { bar, input } = openMinibuffer('Goto line: ');
    let open = true;
    const close = (accept, refocus) => {
      if (!open) return;
      open = false;
      activePrompt = null;
      const v = parseInt(input.value, 10);
      bar.remove();
      if (refocus) focusEditor(editorEl);
      if (accept && !isNaN(v)) goTo(editorEl, state, gotoLine(editorEl, v));
    };
    activePrompt = { close };
    input.addEventListener('blur', () => close(false, false));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (isModifierKey(e)) return;
      const token = tokenFor(e);
      if (token === 'Enter') { e.preventDefault(); close(true, true); }
      else if (token === 'Escape' || token === 'C-g') { e.preventDefault(); close(false, true); }
    }, true);
  }

  // ---------- Command table ----------
  // Each command receives (editorEl, state, count) and returns nothing.
  // A `false` return means "don't reset lastWasKill/lastWasYank flags here".
  // `count` defaults to 1; a command that must tell "no prefix arg" apart reads
  // `prefixArg` itself (runCommand resets it only after the command returns).
  const commands = {
    // Movement
    'C-f': (el, s, n) => goTo(el, s, charRight(el, getCursor(el), n)),
    'C-b': (el, s, n) => goTo(el, s, charLeft(el, getCursor(el), n)),
    'C-n': (el, s, n) => lineMove(el, s, n),
    'C-p': (el, s, n) => lineMove(el, s, -n),
    'M-f': (el, s, n) => goTo(el, s, wordForward(el, getCursor(el), n)),
    'M-b': (el, s, n) => goTo(el, s, wordBackward(el, getCursor(el), n)),
    'C-a': (el, s) => goTo(el, s, lineStart(el, getCursor(el))),
    'C-e': (el, s) => goTo(el, s, lineEnd(el, getCursor(el))),
    'M-m': (el, s) => goTo(el, s, indentation(el, getCursor(el))),
    'M-<': (el, s) => goTo(el, s, 0),
    'M->': (el, s) => goTo(el, s, docEnd(el)),
    'C-v': (el, s, n) => lineMove(el, s, pageLines(el) * n),
    'M-v': (el, s, n) => lineMove(el, s, -pageLines(el) * n),
    'C-l': (el) => {
      const view = getView(el);
      const c = view.coordsAtPos(getCursor(el));
      if (c) window.scrollBy({ top: (c.top + c.bottom) / 2 - window.innerHeight / 2 });
    },
    // Navigation keys reach these only with an active region or a prefix
    // argument (see NATIVE_KEYS); otherwise CodeMirror / Pluto handle them.
    'Left': (el, s, n) => commands['C-b'](el, s, n),
    'Right': (el, s, n) => commands['C-f'](el, s, n),
    'Up': (el, s, n) => commands['C-p'](el, s, n),
    'Down': (el, s, n) => commands['C-n'](el, s, n),
    'Home': (el, s) => commands['C-a'](el, s),
    'End': (el, s) => commands['C-e'](el, s),
    'PageDown': (el, s, n) => commands['C-v'](el, s, n),
    'PageUp': (el, s, n) => commands['M-v'](el, s, n),

    // Mark / region  (C-@ is aliased to C-Space in handleKey)
    'C-Space': (el, s) => { setMark(s, getCursor(el)); setCursor(el, getCursor(el)); echo('Mark set'); },

    // Killing / yanking
    'C-d': (el, s, n) => {
      const p = getCursor(el);
      replaceRange(el, p, charRight(el, p, n), '');
    },
    'DEL': (el, s, n) => {              // Backspace, only when given a prefix arg
      const p = getCursor(el);
      replaceRange(el, charLeft(el, p, n), p, '');
    },
    'C-k': (el, s) => {
      const p = getCursor(el);
      const doc = getDoc(el);
      const line = doc.lineAt(p);
      if (prefixArg != null) {
        // C-u n C-k: n whole lines forward; n ≤ 0: back to the line start.
        if (prefixArg <= 0) return killRange(el, line.from, p, true);
        const last = doc.line(Math.min(doc.lines, line.number + prefixArg - 1));
        return killRange(el, p, Math.min(doc.length, last.to + 1), false);
      }
      // Kill to end of line, or the newline itself if already at end.
      const to = (p === line.to) ? Math.min(doc.length, line.to + 1) : line.to;
      return killRange(el, p, to, false);
    },
    'M-d': (el, s, n) => killRange(el, getCursor(el), wordForward(el, getCursor(el), n), false),
    'M-Backspace': (el, s, n) => killRange(el, wordBackward(el, getCursor(el), n), getCursor(el), true),
    'C-w': (el, s) => killRegion(el, s, false),
    'M-w': (el, s) => killRegion(el, s, true),
    'C-y': (el, s) => {
      if (!killRing.length) { echo('Kill ring is empty'); return; }
      yankPointer = killRing.length - 1;
      const text = killRing[yankPointer];
      const from = getCursor(el);
      replaceRange(el, from, from, text);
      s.mark = from; s.active = false;
      lastYankRange = { editorEl: el, from, to: from + text.length };
      lastWasYank = true; lastWasKill = false;
      return false;
    },
    'M-y': (el, s) => {
      if (!lastWasYank || !lastYankRange || lastYankRange.editorEl !== el || !killRing.length) {
        echo('Previous command was not a yank');
        return;
      }
      yankPointer = (yankPointer - 1 + killRing.length) % killRing.length;
      const text = killRing[yankPointer];
      const { from, to } = lastYankRange;
      replaceRange(el, from, to, text);
      s.mark = from; s.active = false;
      lastYankRange = { editorEl: el, from, to: from + text.length };
      lastWasYank = true; lastWasKill = false;
      return false;
    },

    // Editing
    'C-o': (el) => {
      const p = getCursor(el);
      replaceRange(el, p, p, '\n', p); // leave point before the inserted newline
    },
    'C-j': (el) => {
      const p = getCursor(el);
      replaceRange(el, p, p, '\n');
    },
    'C-t': (el) => {
      const doc = getDoc(el);
      const line = doc.lineAt(getCursor(el));
      // Swap the chars around point; at end of line, the two before it.
      let a = getCursor(el);
      if (a === line.to) a--;
      if (a - 1 < line.from || a >= line.to) return;
      replaceRange(el, a - 1, a + 1, doc.sliceString(a, a + 1) + doc.sliceString(a - 1, a));
    },
    'M-u': (el, s, n) => transformWord(el, (t) => t.toUpperCase(), n),
    'M-l': (el, s, n) => transformWord(el, (t) => t.toLowerCase(), n),
    'M-c': (el, s, n) => transformWord(el, capitalizeStr, n),
    'M-;': (el) => sendCmKey(el, mod({ key: '/', code: 'Slash' })), // Pluto's toggle-comment

    // Undo / redo (delegate to CodeMirror history)
    'C-/': undo,
    'C-_': undo,
    'C-?': redo,

    // Search
    'C-s': (el) => openIsearch(el, 1),
    'C-r': (el) => openIsearch(el, -1),

    // Quit / cancel
    'C-g': (el, s) => {
      deactivateMark(s);
      setCursor(el, getCursor(el));
      echo('Quit');
    },

    // ----- C-x prefix -----
    'C-x C-x': (el, s) => {
      if (s.mark == null) { echo('No mark set'); return; }
      const m = s.mark, p = getCursor(el);
      setMark(s, p);
      setSelection(el, p, m);
    },
    'C-x h': (el, s) => { setMark(s, docEnd(el)); setSelection(el, docEnd(el), 0); },
    'C-x u': undo,
    'C-x C-s': () => { submitAllChanges(); echo('Submitted all changes'); },

    // ----- M-g prefix (goto line) -----
    'M-g g': (el, s) => gotoLinePrompt(el, s),
    'M-g M-g': (el, s) => gotoLinePrompt(el, s),

    // ----- C-c prefix (cell / notebook operations) -----
    'C-c C-c': (el) => { runCell(el); echo('Cell evaluated'); },
    'C-c C-n': (el) => focusNeighbour(el, 1),
    'C-c C-p': (el) => focusNeighbour(el, -1),
    'C-c C-a': (el) => addCell(el, true),
    'C-c C-o': (el) => addCell(el, false),
    'C-c C-k': (el) => deleteCell(el),
  };

  // ---------- Key token normalisation ----------
  const PREFIX_KEYS = new Set(['C-x', 'C-c', 'M-g']);
  // Left to CodeMirror / Pluto (shift-selection, wrapped-line motion, crossing
  // into the neighbouring cell, completion lists) unless there is a region to
  // extend or a prefix argument to honour.
  const NATIVE_KEYS = new Set(['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown']);
  const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn', 'NumLock']);
  function isModifierKey(e) { return MODIFIER_KEYS.has(e.key); }
  function hasAltGr(e) { return !!(e.getModifierState && e.getModifierState('AltGraph')); }

  // The key's name without modifiers. Prefer what the layout produced (`e.key`)
  // so bindings follow the letters printed on AZERTY / Dvorak keyboards; fall
  // back to the physical key (`e.code`) when that isn't an ASCII character —
  // macOS Option-letter diacritics and dead keys, or Cyrillic / Greek layouts.
  function baseKey(e) {
    const key = e.key || '';
    const code = e.code || '';
    if (key.length === 1) {
      if (/[a-zA-Z]/.test(key)) return key.toLowerCase();
      if (key === ' ') return 'Space';
      const c = key.charCodeAt(0);
      if (c > 32 && c < 127) return key;   // digits, ASCII punctuation
    }
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    if (code === 'Space') return 'Space';
    switch (key) {
      case 'ArrowLeft': return 'Left';
      case 'ArrowRight': return 'Right';
      case 'ArrowUp': return 'Up';
      case 'ArrowDown': return 'Down';
      default: return key; // Enter, Backspace, Delete, Tab, Escape, …
    }
  }

  // Meta is Alt only: on macOS ⌘ must stay the system's (⌘C, ⌘V, ⌘F…). AltGr
  // (which Windows reports as Ctrl+Alt) types characters, so it is no modifier.
  function tokenFor(e) {
    const altGr = hasAltGr(e);
    let t = '';
    if (e.ctrlKey && !altGr) t += 'C-';
    if (e.altKey && !altGr) t += 'M-';
    return t + baseKey(e);
  }

  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  // ---------- Main key handler ----------
  function handleKey(editorEl, e) {
    if (synthesizing || isearch) return;         // our own replayed key / search bar owns the keyboard
    if (e.isComposing || e.keyCode === 229) return; // IME composition
    if (isModifierKey(e)) return;                // a bare Ctrl / Alt / Shift press is not a command
    if (!getView(editorEl)) return;              // unknown CM6 internals: stay out of the way

    const state = getState(editorEl);
    const altGr = hasAltGr(e);
    const ctrl = e.ctrlKey && !altGr;
    const meta = e.altKey && !altGr;
    const k = baseKey(e);
    const token = tokenFor(e);

    // --- C-g aborts a half-typed key sequence ---
    if (token === 'C-g' && pendingPrefix) {
      swallow(e);
      pendingPrefix = null;
      resetPrefixArg();
      echo('Quit');
      return;
    }

    // --- Prefix argument: C-u ---
    if (token === 'C-u' && !pendingPrefix) {
      swallow(e);
      if (!prefixActive) { prefixActive = true; prefixArg = 4; prefixExplicit = false; }
      else if (!prefixExplicit) prefixArg *= 4; // chained C-u ⇒ ×4 each
      echoPrefix();
      return;
    }
    // Digits: accumulate while a prefix arg is active, or M-<digit> starts one.
    if (/^[0-9]$/.test(k) && !ctrl && !pendingPrefix && (prefixActive || meta)) {
      swallow(e);
      const d = parseInt(k, 10);
      if (!prefixActive) { prefixActive = true; prefixArg = d; }
      else if (!prefixExplicit) prefixArg = d;      // first digit replaces implicit 4
      else prefixArg = prefixArg * 10 + d;          // subsequent digits append
      prefixExplicit = true;
      echoPrefix();
      return;
    }

    // --- Multi-key prefixes (build a two-chord token) ---
    if (pendingPrefix) {
      const full = pendingPrefix + ' ' + token;
      pendingPrefix = null;
      // Unknown sequence: swallow the key so it doesn't stray into the buffer.
      swallow(e);
      if (commands[full]) {
        runCommand(full, editorEl);
      } else {
        resetPrefixArg();
        echo(full + ' is undefined');
      }
      return;
    }
    if (PREFIX_KEYS.has(token)) {
      swallow(e);
      pendingPrefix = token;
      echoPrefix();
      return;
    }

    // --- Aliases ---
    let cmdKey = token;
    if (token === 'C-@') cmdKey = 'C-Space';
    const bare = !ctrl && !meta;
    if (bare && prefixArg != null && k === 'Delete') cmdKey = 'C-d';
    if (bare && prefixArg != null && k === 'Backspace') cmdKey = 'DEL';

    // --- Completion popup: Emacs chords drive the list ---
    if (COMPLETION_KEYS[cmdKey] && completionOpen()) {
      swallow(e);
      resetPrefixArg();
      sendCmKey(editorEl, COMPLETION_KEYS[cmdKey]);
      return;
    }

    // --- Direct command lookup ---
    const native = NATIVE_KEYS.has(cmdKey) &&
      (completionOpen() || !(state.active || prefixArg != null));
    if (commands[cmdKey] && !native) {
      swallow(e);
      runCommand(cmdKey, editorEl);
      return;
    }

    // --- Everything else goes to CodeMirror ---
    const hadPrefix = prefixArg;
    resetPrefixArg();
    if (hadPrefix != null) echo('');
    lastWasKill = false; lastWasYank = false; lastWasLineMove = false;
    if (NATIVE_KEYS.has(cmdKey)) return;         // plain navigation: the mark stays valid

    // C-u n <char> self-inserts n copies.
    if (bare && hadPrefix != null && e.key.length === 1) {
      swallow(e);
      const r = getSelRange(editorEl);
      replaceRange(editorEl, r.from, r.to, e.key.repeat(Math.max(0, hadPrefix)));
      return;
    }
    // Anything else may edit the text behind our back (typing replaces the
    // region, Backspace, Enter, Tab, Ctrl-z…), so the mark can't be trusted.
    dropMark(state);
  }

  function resetPrefixArg() {
    prefixActive = false;
    prefixArg = null;
    prefixExplicit = false;
  }

  function runCommand(key, editorEl) {
    const state = getState(editorEl);
    const count = prefixArg != null ? prefixArg : 1;
    // Commands read lastWasKill / lastWasYank / lastWasLineMove to detect a
    // continuing streak, so they run BEFORE we touch those flags. Streak
    // commands (kill/yank) set both flags themselves and return false; every
    // other command returns undefined and has both flags cleared here.
    // The echo area is cleared first so a message the command prints survives.
    echo('');
    thisIsLineMove = false;
    let ret;
    try {
      ret = commands[key](editorEl, state, count);
    } finally {
      resetPrefixArg();
      lastWasLineMove = thisIsLineMove;
    }
    if (ret !== false) {
      lastWasKill = false;
      lastWasYank = false;
    }
  }

  // ---------- Attach / detach ----------
  const attached = new WeakSet();
  const listeners = new WeakMap();

  function attach(editorEl) {
    if (attached.has(editorEl)) return;
    attached.add(editorEl);
    editorEl.classList.add('pluto-emacs-active');
    const onKey = (e) => handleKey(editorEl, e);
    // A click moves point natively: like Emacs, that deactivates the region.
    const onMouse = () => {
      deactivateMark(getState(editorEl));
      lastWasKill = false; lastWasYank = false; lastWasLineMove = false;
    };
    const content = editorEl.querySelector('.cm-content') || editorEl;
    content.addEventListener('keydown', onKey, true);
    editorEl.addEventListener('mousedown', onMouse, true);
    listeners.set(editorEl, { onKey, onMouse, content });
  }
  function detach(editorEl) {
    const rec = listeners.get(editorEl);
    if (rec) {
      rec.content.removeEventListener('keydown', rec.onKey, true);
      editorEl.removeEventListener('mousedown', rec.onMouse, true);
    }
    listeners.delete(editorEl);
    attached.delete(editorEl);
    editorEl.classList.remove('pluto-emacs-active');
  }
  function attachAll() { document.querySelectorAll('.cm-editor').forEach(attach); }
  function detachAll() {
    if (activePrompt) activePrompt.close(false, false);
    document.querySelectorAll('.cm-editor').forEach(detach);
    if (echoTimer) { clearTimeout(echoTimer); echoTimer = null; }
    if (badgeEl) badgeEl.remove();
    if (echoEl) echoEl.remove();
    badgeEl = echoEl = null;
    pendingPrefix = null;
    resetPrefixArg();
  }

  // ---------- Enable / disable lifecycle ----------
  let enabled = false;
  let observer = null;
  let attachScheduled = false;
  function scheduleAttach() {
    // Pluto mutates the DOM constantly while cells run; coalesce to one scan a frame.
    if (attachScheduled) return;
    attachScheduled = true;
    requestAnimationFrame(() => {
      attachScheduled = false;
      if (enabled) attachAll();
    });
  }
  function enable() {
    if (enabled) return;
    enabled = true;
    ensureBadge();
    attachAll();
    observer = new MutationObserver(scheduleAttach);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function disable() {
    if (!enabled) return;
    enabled = false;
    if (observer) { observer.disconnect(); observer = null; }
    detachAll();
  }

  window.addEventListener('pluto-emacs-enable', enable);
  window.addEventListener('pluto-emacs-disable', disable);

  // Auto-enable on load — content.js only injects when state is enabled.
  enable();
})();
