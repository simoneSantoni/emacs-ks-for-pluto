// End-to-end tests for emacs-mode.js against a real Pluto notebook.
// Run from test/: `npm run test:e2e` (see helpers.mjs for env knobs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startPluto, launchFirefox, openNotebook, setDoc, doc, head, sel, echoText,
  cellCount, focusedCell, keys,
} from './helpers.mjs';

let pluto, browser, page;

before(async () => {
  pluto = await startPluto();
  browser = await launchFirefox();
  page = await openNotebook(browser, pluto.url);
}, { timeout: 300_000 });

after(async () => {
  if (browser) await browser.close();
  if (pluto) await pluto.stop();
});

const TEXT = 'alpha beta gamma\nsecond line here\nx\nfourth line is long';

// ---------- Attach ----------
test('engine finds the CodeMirror view and attaches', async () => {
  await page.waitForSelector('.cm-editor.pluto-emacs-active');
  assert.equal(await page.locator('.pluto-emacs-badge').count(), 1);
  await setDoc(page, 'abc', 0);
  await keys(page, 'Control+f');
  assert.equal(await head(page), 1, 'C-f must move point (view discovery works)');
});

// ---------- Movement ----------
test('char / word / line / buffer motions', async () => {
  await setDoc(page, TEXT, 0);
  await keys(page, 'Control+f', 'Control+f', 'Control+b');
  assert.equal(await head(page), 1);
  await keys(page, 'Alt+f');
  assert.equal(await head(page), 5);
  await keys(page, 'Alt+f', 'Alt+b');
  assert.equal(await head(page), 6);
  await keys(page, 'Control+e');
  assert.equal(await head(page), 16);
  await keys(page, 'Control+a');
  assert.equal(await head(page), 0);
  await keys(page, 'Alt+Shift+Period');
  assert.equal(await head(page), TEXT.length);
  await keys(page, 'Alt+Shift+Comma');
  assert.equal(await head(page), 0);
});

test('C-n / C-p keep a goal column across short lines', async () => {
  await setDoc(page, TEXT, 12); // line 1, col 12
  await keys(page, 'Control+n');
  assert.equal(await head(page), 17 + 12);
  await keys(page, 'Control+n');          // line "x": clamped to col 1
  assert.equal(await head(page), 34 + 1);
  await keys(page, 'Control+n');          // back to col 12 on the long line
  assert.equal(await head(page), 36 + 12);
  await keys(page, 'Control+p', 'Control+p');
  assert.equal(await head(page), 17 + 12);
});

test('motions step over astral (surrogate-pair) characters', async () => {
  await setDoc(page, 'a𝒻b', 0);
  await keys(page, 'Control+f', 'Control+f');
  assert.equal(await head(page), 3);
  await keys(page, 'Control+b');
  assert.equal(await head(page), 1);
  await keys(page, 'Control+d');
  assert.equal(await doc(page), 'ab');
});

test('word motions understand Unicode identifiers', async () => {
  await setDoc(page, 'αβγ δ', 0);
  await keys(page, 'Alt+f');
  assert.equal(await head(page), 3);
});

// ---------- Prefix arguments ----------
test('C-u / M-digit prefix arguments survive releasing Ctrl between chords', async () => {
  await setDoc(page, 'x'.repeat(40), 0);
  await keys(page, 'Control+u', 'Control+f');
  assert.equal(await head(page), 4);
  await keys(page, 'Control+a', 'Control+u', 'Control+u', 'Control+f');
  assert.equal(await head(page), 16);
  await keys(page, 'Control+a', 'Control+u', '1', '2', 'Control+f');
  assert.equal(await head(page), 12);
  await keys(page, 'Control+a', 'Alt+5', 'Control+f');
  assert.equal(await head(page), 5);
  assert.equal(await doc(page), 'x'.repeat(40), 'prefix digits must not self-insert');
});

test('C-u n <char> self-inserts n copies; shifted digits are not digits', async () => {
  await setDoc(page, '', 0);
  await keys(page, 'Control+u', 'Shift+Digit9');
  assert.equal(await doc(page), '((((');
  await keys(page, 'Control+u', '3', 'x');
  assert.equal(await doc(page), '((((xxx');
});

test('M-m goes back to indentation; M-; toggles a comment', async () => {
  await setDoc(page, '    x = 1', 9);
  await keys(page, 'Alt+m');
  assert.equal(await head(page), 4);
  await keys(page, 'Alt+Semicolon');
  assert.match(await doc(page), /^\s*#\s*x = 1$/);
});

// ---------- Region, kill, yank ----------
test('mark + movement makes a region; C-w kills it; C-y yanks it back', async () => {
  await setDoc(page, TEXT, 0);
  await keys(page, 'Control+Space', 'Alt+f');
  assert.deepEqual(await sel(page), [0, 5]);
  await keys(page, 'Control+w');
  assert.equal(await doc(page), TEXT.slice(5));
  await keys(page, 'Control+e', 'Control+y');
  assert.equal((await doc(page)).split('\n')[0], ' beta gammaalpha');
});

test('M-w copies without deleting and deactivates the region', async () => {
  await setDoc(page, TEXT, 6);
  await keys(page, 'Control+Space', 'Alt+f', 'Alt+w');
  assert.equal(await doc(page), TEXT);
  assert.deepEqual(await sel(page), [10, 10]);
  await keys(page, 'Control+y');
  assert.equal((await doc(page)).split('\n')[0], 'alpha betabeta gamma');
});

test('consecutive C-k append into one kill-ring entry', async () => {
  await setDoc(page, 'one\ntwo\nthree', 0);
  await keys(page, 'Control+k', 'Control+k', 'Control+k');
  assert.equal(await doc(page), '\nthree');
  await keys(page, 'Alt+Shift+Period', 'Control+y');
  assert.equal(await doc(page), '\nthreeone\ntwo');
});

test('C-u n C-k kills n whole lines', async () => {
  await setDoc(page, 'one\ntwo\nthree', 0);
  await keys(page, 'Control+u', '2', 'Control+k');
  assert.equal(await doc(page), 'three');
});

test('M-d / M-DEL kill words; a following C-k joins the same entry', async () => {
  await setDoc(page, 'foo bar baz', 4);
  await keys(page, 'Alt+d');
  assert.equal(await doc(page), 'foo  baz');
  await keys(page, 'Alt+Backspace');
  assert.equal(await doc(page), ' baz');
  await keys(page, 'Control+e', 'Control+y');
  assert.equal(await doc(page), ' bazfoo bar');
});

test('M-y cycles the kill ring, only right after a yank', async () => {
  await setDoc(page, 'AAA BBB', 0);
  await keys(page, 'Alt+d', 'Control+f', 'Alt+d'); // two separate kills: "AAA", "BBB"
  assert.equal(await doc(page), ' ');
  await keys(page, 'Control+y');
  assert.equal(await doc(page), ' BBB');
  await keys(page, 'Alt+y');
  assert.equal(await doc(page), ' AAA');
  await keys(page, 'Control+f', 'Alt+y');           // streak broken → no-op
  assert.equal(await doc(page), ' AAA');
});

test('the mark follows edits made before it', async () => {
  await setDoc(page, 'abcdef', 4);
  await keys(page, 'Control+Space', 'Control+a', 'Control+d'); // delete "a"; mark 4 → 3
  await keys(page, 'Control+x', 'Control+x');                  // point ↔ mark
  assert.equal(await head(page), 3);
});

// ---------- Editing ----------
test('C-t transposes around point, and the two before point at end of line', async () => {
  await setDoc(page, 'abcd', 1);
  await keys(page, 'Control+t');
  assert.equal(await doc(page), 'bacd');
  assert.equal(await head(page), 2);
  await keys(page, 'Control+e', 'Control+t');
  assert.equal(await doc(page), 'badc');
});

test('M-u / M-l / M-c', async () => {
  await setDoc(page, 'hello wORLD again', 0);
  await keys(page, 'Alt+u', 'Alt+c', 'Alt+l');
  assert.equal(await doc(page), 'HELLO World again');
  await setDoc(page, 'MIXED', 0);
  await keys(page, 'Alt+l');
  assert.equal(await doc(page), 'mixed');
});

test('C-o opens a line leaving point put; C-j inserts a newline', async () => {
  await setDoc(page, 'ab', 1);
  await keys(page, 'Control+o');
  assert.equal(await doc(page), 'a\nb');
  assert.equal(await head(page), 1);
  await keys(page, 'Control+j');
  assert.equal(await doc(page), 'a\n\nb');
  assert.equal(await head(page), 2);
});

test('undo (C-/, C-x u) and redo (C-?) delegate to CodeMirror history', async () => {
  await setDoc(page, 'keep', 4);
  await page.keyboard.type(' typed');
  await page.waitForTimeout(600); // let CM close the history group
  await keys(page, 'Control+a', 'Control+k');
  assert.equal(await doc(page), '');
  await keys(page, 'Control+Slash');
  assert.equal(await doc(page), 'keep typed');
  await keys(page, 'Control+Shift+Slash');
  assert.equal(await doc(page), '');
  await keys(page, 'Control+x', 'u');
  assert.equal(await doc(page), 'keep typed');
});

test('plain typing passes through and replaces an active region', async () => {
  await setDoc(page, 'abc def', 0);
  await keys(page, 'Control+Space', 'Alt+f');
  await page.keyboard.type('X');
  assert.equal(await doc(page), 'X def');
  await keys(page, 'Control+f');               // mark must be gone
  assert.deepEqual(await sel(page), [2, 2]);
});

test('arrows / Delete stay native without a mark, extend the region with one', async () => {
  await setDoc(page, 'abcdef', 0);
  await keys(page, 'Shift+ArrowRight', 'Shift+ArrowRight');
  assert.deepEqual(await sel(page), [0, 2], 'shift-selection still works');
  await keys(page, 'Delete');
  assert.equal(await doc(page), 'cdef', 'Delete removes a native selection');
  await keys(page, 'Control+Space', 'ArrowRight', 'ArrowRight');
  assert.deepEqual(await sel(page), [0, 2]);
  await keys(page, 'Control+u', '3', 'ArrowRight');
  assert.deepEqual(await sel(page), [0, 4]);
});

// ---------- Echo area ----------
test('command messages stay visible in the echo area', async () => {
  await setDoc(page, 'abc', 0);
  await keys(page, 'Control+Space');
  assert.equal(await echoText(page), 'Mark set');
  await keys(page, 'Control+g');
  assert.equal(await echoText(page), 'Quit');
  await keys(page, 'Control+x');
  assert.equal(await echoText(page), 'C-x-');
  await keys(page, 'Control+g');
  assert.equal(await echoText(page), 'Quit');
});

// ---------- Two-chord prefixes ----------
test('C-x h, C-x C-x, and undefined sequences are swallowed', async () => {
  await setDoc(page, 'abc def', 3);
  await keys(page, 'Control+x', 'h');
  assert.deepEqual(await sel(page), [0, 7]);
  await keys(page, 'Control+g', 'Control+a', 'Control+Space', 'Control+e', 'Control+x', 'Control+x');
  assert.equal(await head(page), 0);
  await keys(page, 'Control+g', 'Control+x', 'z');
  assert.equal(await doc(page), 'abc def');
  assert.equal(await echoText(page), 'C-x z is undefined');
});

// ---------- Search & goto-line ----------
test('C-s: incremental, repeat, Enter accepts at match end', async () => {
  await setDoc(page, 'foo bar foo baz foo', 0);
  await keys(page, 'Control+s');
  await page.keyboard.type('foo');
  assert.deepEqual(await sel(page), [0, 3]);
  await keys(page, 'Control+s');
  assert.deepEqual(await sel(page), [8, 11]);
  await keys(page, 'Control+s', 'Control+s');       // → 16, then wraps → 0
  assert.deepEqual(await sel(page), [0, 3]);
  await keys(page, 'Control+s', 'Enter');
  assert.equal(await head(page), 11);
  assert.equal(await page.locator('.pluto-emacs-isearch').count(), 0);
});

test('C-r steps backward through matches instead of sticking', async () => {
  const t = 'foo bar foo baz foo';
  await setDoc(page, t, t.length);
  await keys(page, 'Control+r');
  await page.keyboard.type('foo');
  assert.deepEqual(await sel(page), [16, 19]);
  await keys(page, 'Control+r');
  assert.deepEqual(await sel(page), [8, 11]);
  await keys(page, 'Control+r');
  assert.deepEqual(await sel(page), [0, 3]);
  await keys(page, 'Control+g');
  assert.equal(await head(page), t.length, 'C-g restores the starting point');
});

test('isearch: lowercase query is case-insensitive; failed search leaves point alone', async () => {
  await setDoc(page, 'x Foo', 0);
  await keys(page, 'Control+s');
  await page.keyboard.type('foo');
  assert.deepEqual(await sel(page), [2, 5]);
  await keys(page, 'Control+g', 'Control+s');
  await page.keyboard.type('nomatch');
  await keys(page, 'Enter');
  assert.equal(await head(page), 0);
});

test('M-g g prompts for a line; with a prefix arg it jumps directly', async () => {
  await setDoc(page, TEXT, 0);
  await keys(page, 'Alt+g', 'g');
  await page.keyboard.type('3');
  await keys(page, 'Enter');
  assert.equal(await head(page), 34);
  await keys(page, 'Control+u', '2', 'Alt+g', 'Alt+g');
  assert.equal(await head(page), 17);
  assert.equal(await page.locator('.pluto-emacs-isearch').count(), 0);
});

// ---------- Completion popup ----------
test('with a completion popup open, C-n / C-p / C-g are replayed as Down / Up / Escape', async () => {
  await setDoc(page, 'a\nb\nc', 0);
  await page.evaluate(() => {
    window.__synthKeys = [];
    window.__synthSpy = (e) => { if (!e.isTrusted) window.__synthKeys.push(e.key); };
    window.addEventListener('keydown', window.__synthSpy, true);
  });
  await keys(page, 'Control+n');
  assert.deepEqual(await page.evaluate(() => window.__synthKeys), [], 'no popup: C-n is an ordinary motion');
  await page.evaluate(() => {
    const fake = document.createElement('div');
    fake.className = 'cm-tooltip-autocomplete';
    fake.id = 'fake-completion';
    document.body.appendChild(fake);
  });
  await keys(page, 'Control+n', 'Control+p', 'Control+g');
  assert.deepEqual(await page.evaluate(() => window.__synthKeys), ['ArrowDown', 'ArrowUp', 'Escape']);
  await page.evaluate(() => {
    document.getElementById('fake-completion').remove();
    window.removeEventListener('keydown', window.__synthSpy, true);
  });
});

// ---------- Enable / disable ----------
test('disable detaches everything; enable re-attaches', async () => {
  await setDoc(page, 'abc', 0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pluto-emacs-disable')));
  assert.equal(await page.locator('.pluto-emacs-badge').count(), 0);
  assert.equal(await page.locator('.cm-editor.pluto-emacs-active').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pluto-emacs-enable')));
  assert.equal(await page.locator('.pluto-emacs-badge').count(), 1);
  await keys(page, 'Control+f');
  assert.equal(await head(page), 1);
});

// ---------- Cell operations (need Pluto's UI; slowest, so last) ----------
test('C-c C-a / C-c C-o add cells, C-c C-n / C-c C-p move focus, C-c C-k deletes', { timeout: 300_000 }, async () => {
  await setDoc(page, 'first', 0);
  const n = await cellCount(page);
  await keys(page, 'Control+c', 'Control+a');
  await page.waitForFunction((n) => document.querySelectorAll('pluto-cell').length === n + 1, n);
  await page.waitForFunction(() => {
    const c = document.activeElement && document.activeElement.closest('pluto-cell');
    return c && Array.from(document.querySelectorAll('pluto-cell')).indexOf(c) === 1;
  });
  await keys(page, 'Control+c', 'Control+p');
  assert.equal(await focusedCell(page), 0);
  await keys(page, 'Control+c', 'Control+n');
  assert.equal(await focusedCell(page), 1);
  await page.keyboard.type('doomed');
  // Pluto asks for confirmation (and interrupts instead of deleting) while the
  // cell is queued or running, e.g. during Julia start-up — wait that out.
  await page.waitForFunction(() => !document.querySelector('pluto-cell.queued, pluto-cell.running'),
    null, { timeout: 240_000 });
  await keys(page, 'Control+c', 'Control+k');
  await page.waitForFunction((n) => document.querySelectorAll('pluto-cell').length === n, n);
  assert.equal(await doc(page, 0), 'first');
  // The engine hands focus to the neighbouring cell once Pluto has removed this one.
  await page.waitForFunction(() => document.activeElement && document.activeElement.closest('pluto-cell'));
  assert.equal(await focusedCell(page), 0);
  await keys(page, 'Control+c', 'Control+o');
  await page.waitForFunction((n) => document.querySelectorAll('pluto-cell').length === n + 1, n);
  assert.equal(await doc(page, 1), 'first', 'C-c C-o adds the new cell above');
});

test('C-c C-c evaluates the cell', { timeout: 300_000 }, async () => {
  await setDoc(page, '6 * 7', 0);
  await keys(page, 'Control+c', 'Control+c');
  await page.waitForFunction(() => {
    const out = document.querySelector('pluto-cell pluto-output');
    return out && out.textContent.trim() === '42';
  }, null, { timeout: 280_000 });
});

test('C-x C-s submits every edited cell (Pluto\'s Ctrl-S)', { timeout: 120_000 }, async () => {
  await setDoc(page, '100 + 1', 0, 0);
  await setDoc(page, '200 + 2', 0, 1);
  await keys(page, 'Control+x', 'Control+s');
  await page.waitForFunction(() => {
    const outs = Array.from(document.querySelectorAll('pluto-cell pluto-output')).map((o) => o.textContent.trim());
    return outs.includes('101') && outs.includes('202');
  }, null, { timeout: 100_000 });
});

test('C-n / C-p / C-g drive a real completion popup (skipped if Pluto offers none)', { timeout: 120_000 }, async (t) => {
  await setDoc(page, '', 0);
  await page.keyboard.type('printl');
  await page.keyboard.press('Backspace'); // "print": print, println, printstyled…
  await page.keyboard.press('Tab');
  const tip = page.locator('.cm-tooltip-autocomplete');
  try {
    await tip.waitFor({ timeout: 30_000 });
  } catch (_) {
    t.skip('completion popup did not open in this Pluto');
    return;
  }
  const selected = () => page.evaluate(() => {
    const li = document.querySelector('.cm-tooltip-autocomplete [aria-selected="true"]');
    return li ? li.textContent : null;
  });
  const first = await selected();
  await keys(page, 'Control+n');
  assert.notEqual(await selected(), first, 'C-n moves the completion selection');
  await keys(page, 'Control+p');
  assert.equal(await selected(), first);
  await keys(page, 'Control+g');
  await tip.waitFor({ state: 'detached', timeout: 5_000 });
});
