// emacs-mode.js — page-world Emacs engine for Pluto's CodeMirror 6 cells.
//
// Runs in the page (not the isolated content-script world) so it can reach
// CodeMirror EditorView instances. It hooks keydown in the capture phase on
// `.cm-content` elements and dispatches edits through CM6's
// `view.dispatch({ changes, selection })` API.
//
// Emacs is modeless: text keys self-insert as usual and we only intercept the
// specific control/meta chords and prefix sequences we implement. State that
// Emacs keeps globally (the kill ring, the last-command flag) lives at module
// scope; state that is per-buffer (the mark) lives in a per-editor record.
(function () {
  'use strict';

  if (window.__plutoEmacsLoaded) return;
  window.__plutoEmacsLoaded = true;

  // ---------- Global (cross-buffer) state ----------
  const killRing = [];        // most-recent kill is last
  let yankPointer = -1;       // index into killRing of the last yank (for M-y)
  let lastYankRange = null;   // { editorEl, from, to } of the last yank
  let lastWasKill = false;    // consecutive kills append to the top entry
  let lastWasYank = false;    // M-y only valid immediately after a yank

  // Prefix argument (C-u / M-<digit>) — transient, applies to the next command.
  let prefixArg = null;       // null, or an integer count
  let prefixActive = false;   // C-u seen, still accumulating

  // Multi-key prefix (C-x, C-c, M-g) — the pending first chord, or null.
  let pendingPrefix = null;

  // ---------- Per-editor state ----------
  const editorStates = new WeakMap();
  function getState(editorEl) {
    let s = editorStates.get(editorEl);
    if (!s) {
      s = { mark: null };     // active-region anchor offset, or null
      editorStates.set(editorEl, s);
    }
    return s;
  }

  // ---------- CM6 view discovery ----------
  // CM6 doesn't expose a public way to get EditorView from the DOM, but a node
  // inside `.cm-editor` carries it on a `cmView.view` property in practice.
  function getView(editorEl) {
    if (!editorEl) return null;
    if (editorEl.__plutoEmacsView && editorEl.__plutoEmacsView.dom &&
        editorEl.__plutoEmacsView.dom.isConnected) {
      return editorEl.__plutoEmacsView;
    }
    const nodes = [editorEl, ...editorEl.querySelectorAll('*')];
    for (const n of nodes) {
      if (n.cmView && n.cmView.view) {
        editorEl.__plutoEmacsView = n.cmView.view;
        return n.cmView.view;
      }
    }
    return null;
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
    return { from: Math.min(s.anchor, s.head), to: Math.max(s.anchor, s.head) };
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
  function replaceRange(editorEl, from, to, insert) {
    const view = getView(editorEl);
    if (!view) return;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
  }
  function docLine(editorEl, pos) {
    const doc = getDoc(editorEl);
    return doc ? doc.lineAt(pos) : null;
  }

  // Move point to `target`. If the mark is active, extend the region so the
  // native CM6 selection reflects it (transient-mark-mode style).
  function goTo(editorEl, state, target) {
    if (state.mark != null) setSelection(editorEl, state.mark, target);
    else setCursor(editorEl, target);
  }

  // ---------- Motions (return a new offset) ----------
  function charLeft(editorEl, pos, count) { return Math.max(0, pos - count); }
  function charRight(editorEl, pos, count) {
    return Math.min(getDoc(editorEl).length, pos + count);
  }
  function lineUp(editorEl, pos, count) {
    const doc = getDoc(editorEl);
    const line = doc.lineAt(pos);
    const col = pos - line.from;
    const target = doc.line(Math.max(1, line.number - count));
    return target.from + Math.min(col, target.length);
  }
  function lineDown(editorEl, pos, count) {
    const doc = getDoc(editorEl);
    const line = doc.lineAt(pos);
    const col = pos - line.from;
    const target = doc.line(Math.min(doc.lines, line.number + count));
    return target.from + Math.min(col, target.length);
  }
  function lineStart(editorEl, pos) { return docLine(editorEl, pos).from; }
  function lineEnd(editorEl, pos) { return docLine(editorEl, pos).to; }
  function docStart() { return 0; }
  function docEnd(editorEl) { return getDoc(editorEl).length; }
  function gotoLine(editorEl, n) {
    const doc = getDoc(editorEl);
    return doc.line(Math.max(1, Math.min(doc.lines, n))).from;
  }
  // Page motion: move `count` screenfuls, approximated by lines that fit.
  function pageLines(editorEl) {
    const view = getView(editorEl);
    if (!view) return 20;
    const lineH = view.defaultLineHeight || 18;
    return Math.max(1, Math.floor(view.dom.clientHeight / lineH) - 2);
  }

  const WORD_RE = /[A-Za-z0-9_]/;
  function isWord(c) { return c && WORD_RE.test(c); }

  function wordForward(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count; i++) {
      while (p < text.length && !isWord(text[p])) p++;
      while (p < text.length && isWord(text[p])) p++;
    }
    return p;
  }
  function wordBackward(editorEl, pos, count) {
    const text = getDoc(editorEl).toString();
    let p = pos;
    for (let i = 0; i < count; i++) {
      while (p > 0 && !isWord(text[p - 1])) p--;
      while (p > 0 && isWord(text[p - 1])) p--;
    }
    return p;
  }

  // ---------- Kill ring ----------
  function pushKill(text, prepend) {
    if (lastWasKill && killRing.length) {
      // Append/prepend to the current top entry for consecutive kills.
      const top = killRing[killRing.length - 1];
      killRing[killRing.length - 1] = prepend ? text + top : top + text;
    } else {
      killRing.push(text);
    }
    yankPointer = killRing.length - 1;
  }
  function copyToRing(text) {
    if (!text) return;
    killRing.push(text);
    yankPointer = killRing.length - 1;
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

  function killRegion(editorEl, state, copyOnly) {
    if (state.mark == null) { echo('No mark set'); return; }
    const from = Math.min(state.mark, getCursor(editorEl));
    const to = Math.max(state.mark, getCursor(editorEl));
    if (from === to) { state.mark = null; return; }
    const text = getDoc(editorEl).sliceString(from, to);
    copyToRing(text);
    toClipboard(text);
    if (!copyOnly) replaceRange(editorEl, from, to, '');
    else setCursor(editorEl, getCursor(editorEl));
    state.mark = null;
  }

  // ---------- Case commands ----------
  function transformWord(editorEl, fn, count) {
    const pos = getCursor(editorEl);
    const to = wordForward(editorEl, pos, count);
    const from = pos;
    const text = getDoc(editorEl).sliceString(Math.min(from, to), Math.max(from, to));
    replaceRange(editorEl, Math.min(from, to), Math.max(from, to), fn(text));
  }
  const capitalizeStr = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

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
    if (pendingPrefix) s = pendingPrefix + '-';
    else if (prefixActive) s = prefixArg == null ? 'C-u' : `C-u ${prefixArg}`;
    echo(s);
  }

  // ---------- Cell (notebook) helpers ----------
  function allCells() { return Array.from(document.querySelectorAll('pluto-cell')); }
  function cellOf(node) { return node && node.closest ? node.closest('pluto-cell') : null; }
  function currentCellIndex() {
    const cells = allCells();
    const cell = cellOf(document.activeElement);
    return cell ? cells.indexOf(cell) : -1;
  }
  function focusCell(index) {
    const cells = allCells();
    const cell = cells[Math.max(0, Math.min(cells.length - 1, index))];
    if (!cell) return;
    const content = cell.querySelector('.cm-content');
    if (content) {
      content.focus();
      cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  function findButton(cell, keywords) {
    for (const b of cell.querySelectorAll('button')) {
      const label = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
      if (keywords.every((k) => label.includes(k))) return b;
    }
    return null;
  }
  function addCell(after) {
    const cell = allCells()[Math.max(0, currentCellIndex())];
    if (!cell) return;
    const sel = after ? 'button.add_cell.after, .add_cell_button.after'
                      : 'button.add_cell.before, .add_cell_button.before';
    const btn = cell.querySelector(sel) ||
      findButton(cell, ['add', after ? 'below' : 'above']) ||
      findButton(cell, ['add', after ? 'after' : 'before']);
    if (btn) btn.click();
  }
  function deleteCell() {
    const cell = allCells()[Math.max(0, currentCellIndex())];
    if (!cell) return;
    const btn = cell.querySelector('button.delete_cell, .delete_cell') || findButton(cell, ['delete']);
    if (btn) btn.click();
  }
  function runCell(editorEl) {
    // Pluto runs a cell on Shift-Enter; dispatch it to the editor's content.
    const view = getView(editorEl);
    const target = view ? view.contentDOM : editorEl.querySelector('.cm-content');
    if (target) target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
    }));
  }

  // ---------- Incremental search ----------
  let isearch = null; // { editorEl, dir, query, start, matchFrom, inputEl }
  function openIsearch(editorEl, dir) {
    closeIsearch(false);
    const start = getCursor(editorEl);
    const bar = document.createElement('div');
    bar.className = 'pluto-emacs-isearch';
    const label = document.createElement('span');
    label.className = 'pluto-emacs-isearch-label';
    label.textContent = dir > 0 ? 'I-search: ' : 'I-search backward: ';
    const input = document.createElement('input');
    input.className = 'pluto-emacs-isearch-input';
    input.type = 'text';
    bar.appendChild(label);
    bar.appendChild(input);
    document.body.appendChild(bar);
    input.focus();
    isearch = { editorEl, dir, query: '', start, matchFrom: start, inputEl: bar, labelEl: label };

    input.addEventListener('input', () => {
      isearch.query = input.value;
      searchStep(isearch.start, isearch.dir, true);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault(); closeIsearch(true);
      } else if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'g' || e.key === 'G'))) {
        e.preventDefault(); closeIsearch(false);
      } else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); isearch.dir = 1; label.textContent = 'I-search: ';
        searchStep(getCursor(editorEl) + 1, 1, false);
      } else if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault(); isearch.dir = -1; label.textContent = 'I-search backward: ';
        searchStep(getCursor(editorEl) - 1, -1, false);
      }
    }, true);
  }
  function searchStep(fromPos, dir, fromStart) {
    if (!isearch || !isearch.query) return;
    const text = getDoc(isearch.editorEl).toString();
    const q = isearch.query;
    let idx;
    if (dir > 0) {
      idx = text.indexOf(q, Math.max(0, fromStart ? isearch.start : fromPos));
      if (idx === -1) idx = text.indexOf(q, 0); // wrap
    } else {
      idx = text.lastIndexOf(q, Math.max(0, fromPos));
      if (idx === -1) idx = text.lastIndexOf(q);
    }
    if (idx >= 0) {
      isearch.matchFrom = idx;
      setSelection(isearch.editorEl, idx, idx + q.length);
      isearch.labelEl.classList.remove('pluto-emacs-isearch-fail');
    } else {
      isearch.labelEl.classList.add('pluto-emacs-isearch-fail');
    }
  }
  function closeIsearch(keep) {
    if (!isearch) return;
    const { editorEl, inputEl, matchFrom, query, start } = isearch;
    if (inputEl && inputEl.parentNode) inputEl.parentNode.removeChild(inputEl);
    const content = editorEl.querySelector('.cm-content');
    if (content) content.focus();
    if (keep) setCursor(editorEl, matchFrom + query.length);
    else setCursor(editorEl, start);
    isearch = null;
  }

  // ---------- Command table ----------
  // Each command receives (editorEl, state, count) and returns nothing.
  // A `false` return means "don't reset lastWasKill/lastWasYank flags here".
  const commands = {
    // Movement
    'C-f': (el, s, n) => goTo(el, s, charRight(el, getCursor(el), n)),
    'C-b': (el, s, n) => goTo(el, s, charLeft(el, getCursor(el), n)),
    'C-n': (el, s, n) => goTo(el, s, lineDown(el, getCursor(el), n)),
    'C-p': (el, s, n) => goTo(el, s, lineUp(el, getCursor(el), n)),
    'M-f': (el, s, n) => goTo(el, s, wordForward(el, getCursor(el), n)),
    'M-b': (el, s, n) => goTo(el, s, wordBackward(el, getCursor(el), n)),
    'C-a': (el, s) => goTo(el, s, lineStart(el, getCursor(el))),
    'C-e': (el, s) => goTo(el, s, lineEnd(el, getCursor(el))),
    'M-<': (el, s) => goTo(el, s, docStart()),
    'M->': (el, s) => goTo(el, s, docEnd(el)),
    'C-v': (el, s, n) => goTo(el, s, lineDown(el, getCursor(el), pageLines(el) * n)),
    'M-v': (el, s, n) => goTo(el, s, lineUp(el, getCursor(el), pageLines(el) * n)),
    'Left': (el, s, n) => goTo(el, s, charLeft(el, getCursor(el), n)),
    'Right': (el, s, n) => goTo(el, s, charRight(el, getCursor(el), n)),
    'Up': (el, s, n) => goTo(el, s, lineUp(el, getCursor(el), n)),
    'Down': (el, s, n) => goTo(el, s, lineDown(el, getCursor(el), n)),

    // Mark / region
    'C-Space': (el, s) => { s.mark = getCursor(el); echo('Mark set'); setCursor(el, getCursor(el)); },
    'C-@': (el, s) => { s.mark = getCursor(el); echo('Mark set'); },

    // Killing / yanking
    'C-d': (el, s, n) => {
      const p = getCursor(el);
      replaceRange(el, p, Math.min(docEnd(el), p + n), '');
    },
    'Delete': (el, s, n) => {
      const p = getCursor(el);
      replaceRange(el, p, Math.min(docEnd(el), p + n), '');
    },
    'C-k': (el, s) => {
      const p = getCursor(el);
      const line = docLine(el, p);
      // Kill to end of line, or the newline itself if already at end.
      const to = (p === line.to) ? Math.min(docEnd(el), line.to + 1) : line.to;
      if (to <= p) return;
      pushKill(getDoc(el).sliceString(p, to), false);
      replaceRange(el, p, to, '');
      lastWasKill = true; lastWasYank = false;
      return false;
    },
    'M-d': (el, s, n) => {
      const p = getCursor(el);
      const to = wordForward(el, p, n);
      if (to <= p) return;
      pushKill(getDoc(el).sliceString(p, to), false);
      replaceRange(el, p, to, '');
      lastWasKill = true; lastWasYank = false;
      return false;
    },
    'M-Backspace': (el, s, n) => {
      const p = getCursor(el);
      const from = wordBackward(el, p, n);
      if (from >= p) return;
      pushKill(getDoc(el).sliceString(from, p), true);
      replaceRange(el, from, p, '');
      lastWasKill = true; lastWasYank = false;
      return false;
    },
    'C-w': (el, s) => killRegion(el, s, false),
    'M-w': (el, s) => killRegion(el, s, true),
    'C-y': (el, s) => {
      if (!killRing.length) { echo('Kill ring is empty'); return; }
      yankPointer = killRing.length - 1;
      const text = killRing[yankPointer];
      const from = getCursor(el);
      s.mark = from;
      replaceRange(el, from, from, text);
      lastYankRange = { editorEl: el, from, to: from + text.length };
      lastWasYank = true; lastWasKill = false;
      return false;
    },
    'M-y': (el, s) => {
      if (!lastWasYank || !lastYankRange || !killRing.length) { echo('Previous command was not a yank'); return; }
      yankPointer = (yankPointer - 1 + killRing.length) % killRing.length;
      const text = killRing[yankPointer];
      replaceRange(el, lastYankRange.from, lastYankRange.to, text);
      lastYankRange = { editorEl: el, from: lastYankRange.from, to: lastYankRange.from + text.length };
      lastWasYank = true; lastWasKill = false;
      return false;
    },

    // Editing
    'C-o': (el, s) => {
      const p = getCursor(el);
      replaceRange(el, p, p, '\n');
      setCursor(el, p); // leave point before the inserted newline
    },
    'C-j': (el, s) => {
      const p = getCursor(el);
      replaceRange(el, p, p, '\n');
    },
    'C-t': (el, s) => {
      const p = getCursor(el);
      const doc = getDoc(el);
      const line = doc.lineAt(p);
      // Transpose the two chars around point (Emacs default at line end).
      let a = p;
      if (a >= line.to) a = line.to; // clamp
      if (a - 1 < line.from || a >= line.to) return;
      const left = doc.sliceString(a - 1, a);
      const right = doc.sliceString(a, a + 1);
      replaceRange(el, a - 1, a + 1, right + left);
    },
    'M-u': (el, s, n) => transformWord(el, (t) => t.toUpperCase(), n),
    'M-l': (el, s, n) => transformWord(el, (t) => t.toLowerCase(), n),
    'M-c': (el, s, n) => transformWord(el, capitalizeStr, n),

    // Undo / redo (delegate to CodeMirror history)
    'C-/': (el) => sendCmKey(el, { key: 'z', code: 'KeyZ', ctrlKey: true }),
    'C-_': (el) => sendCmKey(el, { key: 'z', code: 'KeyZ', ctrlKey: true }),

    // Search
    'C-s': (el) => openIsearch(el, 1),
    'C-r': (el) => openIsearch(el, -1),

    // Quit / cancel
    'C-g': (el, s) => {
      s.mark = null;
      setCursor(el, getCursor(el));
      echo('Quit');
    },

    // ----- C-x prefix -----
    'C-x C-x': (el, s) => {
      if (s.mark == null) { echo('No mark set'); return; }
      const m = s.mark, p = getCursor(el);
      s.mark = p;
      setSelection(el, p, m);
    },
    'C-x h': (el, s) => { s.mark = 0; setSelection(el, 0, docEnd(el)); },
    'C-x u': (el) => sendCmKey(el, { key: 'z', code: 'KeyZ', ctrlKey: true }),
    'C-x C-s': (el) => { runCell(el); echo('Cell evaluated'); },

    // ----- M-g prefix (goto line) -----
    'M-g g': (el, s) => gotoLinePrompt(el, s),
    'M-g M-g': (el, s) => gotoLinePrompt(el, s),

    // ----- C-c prefix (cell / notebook operations) -----
    'C-c C-c': (el) => { runCell(el); echo('Cell evaluated'); },
    'C-c C-n': () => focusCell(currentCellIndex() + 1),
    'C-c C-p': () => focusCell(currentCellIndex() - 1),
    'C-c C-a': () => addCell(true),
    'C-c C-o': () => addCell(false),
    'C-c C-k': () => deleteCell(),
  };

  function sendCmKey(editorEl, opts) {
    const view = getView(editorEl);
    const target = view ? view.contentDOM : editorEl.querySelector('.cm-content');
    if (target) target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, ...opts,
    }));
  }

  function gotoLinePrompt(editorEl, state) {
    const n = prefixArg;
    if (n != null) { goTo(editorEl, state, gotoLine(editorEl, n)); return; }
    // No prefix arg: ask in the echo area via a small inline prompt.
    const bar = document.createElement('div');
    bar.className = 'pluto-emacs-isearch';
    const label = document.createElement('span');
    label.className = 'pluto-emacs-isearch-label';
    label.textContent = 'Goto line: ';
    const input = document.createElement('input');
    input.className = 'pluto-emacs-isearch-input';
    input.type = 'text';
    bar.appendChild(label); bar.appendChild(input);
    document.body.appendChild(bar);
    input.focus();
    const done = (accept) => {
      const v = parseInt(input.value, 10);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      const content = editorEl.querySelector('.cm-content');
      if (content) content.focus();
      if (accept && !isNaN(v)) goTo(editorEl, state, gotoLine(editorEl, v));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'g')) { e.preventDefault(); done(false); }
    }, true);
  }

  // ---------- Key token normalisation ----------
  const PREFIX_KEYS = new Set(['C-x', 'C-c', 'M-g']);

  function baseKey(e) {
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    switch (e.key) {
      case ' ': return 'Space';
      case 'ArrowLeft': return 'Left';
      case 'ArrowRight': return 'Right';
      case 'ArrowUp': return 'Up';
      case 'ArrowDown': return 'Down';
      default: return e.key; // Enter, Backspace, Delete, Tab, punctuation, etc.
    }
  }

  function tokenFor(e) {
    const ctrl = e.ctrlKey;
    const meta = e.altKey || e.metaKey;
    const k = baseKey(e);
    let t = '';
    if (ctrl) t += 'C-';
    if (meta) t += 'M-';
    // Space with control is written C-Space; the '@' variant handles C-@.
    return t + k;
  }

  // ---------- Main key handler ----------
  function handleKey(editorEl, e) {
    if (isearch) return; // the search bar owns the keyboard while open

    const ctrl = e.ctrlKey;
    const meta = e.altKey || e.metaKey;
    const k = baseKey(e);
    const token = tokenFor(e);

    // --- Prefix argument: C-u ---
    if (token === 'C-u') {
      e.preventDefault(); e.stopPropagation();
      if (!prefixActive) { prefixActive = true; prefixArg = 4; prefixExplicit = false; }
      else if (!prefixExplicit) prefixArg *= 4; // chained C-u ⇒ ×4 each
      echoPrefix();
      return;
    }
    // Digits: accumulate while a prefix arg is active, or M-<digit> starts one.
    if (/^[0-9]$/.test(k) && !ctrl && ((prefixActive) || meta)) {
      e.preventDefault(); e.stopPropagation();
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
      echo('');
      if (commands[full]) {
        e.preventDefault(); e.stopPropagation();
        runCommand(full, editorEl);
        return;
      }
      // Unknown sequence: swallow the key so it doesn't stray into the buffer.
      e.preventDefault(); e.stopPropagation();
      echo(full + ' is undefined');
      resetPrefixArg();
      return;
    }
    if (PREFIX_KEYS.has(token)) {
      e.preventDefault(); e.stopPropagation();
      pendingPrefix = token;
      echoPrefix();
      return;
    }

    // --- C-Space / C-@ special-casing (mark) ---
    let cmdKey = token;
    if (ctrl && (k === 'Space' || k === '@' || k === '2')) cmdKey = 'C-Space';

    // --- Direct command lookup ---
    if (commands[cmdKey]) {
      e.preventDefault(); e.stopPropagation();
      runCommand(cmdKey, editorEl);
      return;
    }

    // Backspace with no modifier: let CM handle deletion, but if a region is
    // active, treat it as a normal delete and drop the mark.
    if (k === 'Backspace' && !ctrl && !meta) {
      const st = getState(editorEl);
      if (st.mark != null) st.mark = null;
      resetPrefixArg();
      lastWasKill = false; lastWasYank = false;
      return; // let the keystroke through to CodeMirror
    }

    // A plain self-inserting key ends any kill/yank streak and deactivates the
    // region selection so typing replaces it (Emacs delete-selection-ish).
    if (!ctrl && !meta && k.length === 1) {
      const st = getState(editorEl);
      if (st.mark != null) st.mark = null;
      resetPrefixArg();
      lastWasKill = false; lastWasYank = false;
      return; // pass through to CodeMirror for insertion
    }

    // Any other unhandled chord: reset transient state, let it pass.
    resetPrefixArg();
  }

  // A separate flag so the first digit after a bare `C-u` replaces the implicit
  // 4 rather than appending to it.
  let prefixExplicit = false;

  function resetPrefixArg() {
    prefixActive = false;
    prefixArg = null;
    prefixExplicit = false;
  }

  function runCommand(key, editorEl) {
    const state = getState(editorEl);
    const count = prefixArg != null ? prefixArg : 1;
    // Commands read lastWasKill / lastWasYank to detect a continuing streak,
    // so they run BEFORE we touch those flags. Streak commands (kill/yank) set
    // both flags themselves and return false; every other command returns
    // undefined and has both flags cleared here.
    let ret;
    try {
      ret = commands[key](editorEl, state, count);
    } finally {
      resetPrefixArg();
      echo('');
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
    const listener = (e) => handleKey(editorEl, e);
    const content = editorEl.querySelector('.cm-content') || editorEl;
    content.addEventListener('keydown', listener, true);
    listeners.set(editorEl, { listener, content });
  }
  function detach(editorEl) {
    const rec = listeners.get(editorEl);
    if (rec) rec.content.removeEventListener('keydown', rec.listener, true);
    listeners.delete(editorEl);
    attached.delete(editorEl);
    editorEl.classList.remove('pluto-emacs-active');
  }
  function attachAll() { document.querySelectorAll('.cm-editor').forEach(attach); }
  function detachAll() {
    document.querySelectorAll('.cm-editor').forEach(detach);
    if (badgeEl && badgeEl.parentNode) badgeEl.parentNode.removeChild(badgeEl);
    if (echoEl && echoEl.parentNode) echoEl.parentNode.removeChild(echoEl);
    badgeEl = echoEl = null;
    closeIsearch(false);
  }

  // ---------- Enable / disable lifecycle ----------
  let enabled = false;
  let observer = null;
  function enable() {
    if (enabled) return;
    enabled = true;
    ensureBadge();
    attachAll();
    observer = new MutationObserver(() => attachAll());
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
