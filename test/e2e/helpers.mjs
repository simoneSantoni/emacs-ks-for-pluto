// Shared plumbing for the end-to-end tests: a Pluto server, a Firefox driven by
// Playwright, and a notebook page with the page-world engine injected.
//
// Playwright's Firefox cannot load WebExtensions, so these tests do what
// content.js does by hand — inject emacs-mode.js (+ content.css) into the page —
// and then exercise the engine with real, trusted keyboard events against real
// Pluto CodeMirror cells. background.js / content.js are covered by test/unit.
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- Pluto server ----------
// PLUTO_URL=http://localhost:1234  reuse an already-running server (it must have
//                                  been started with require_secret_for_access=false;
//                                  each run leaves a scratch notebook in that
//                                  server's new-notebooks directory)
// PLUTO_JULIA_PROJECT=/path        Julia project that has Pluto installed
//                                  (default: the global environment)
export async function startPluto() {
  if (process.env.PLUTO_URL) {
    return { url: process.env.PLUTO_URL.replace(/\/$/, ''), stop: async () => {} };
  }
  const port = 17000 + Math.floor(Math.random() * 2000);
  const args = [];
  if (process.env.PLUTO_JULIA_PROJECT) args.push(`--project=${process.env.PLUTO_JULIA_PROJECT}`);
  args.push('-e', `import Pluto; Pluto.run(port=${port}, launch_browser=false, ` +
    'require_secret_for_access=false, require_secret_for_open_links=false)');
  // `/new` saves a notebook file per run; keep those out of ~/.julia/pluto_notebooks.
  const notebooks = mkdtempSync(join(tmpdir(), 'pluto-emacs-test-'));
  const proc = spawn(process.env.JULIA_BIN || 'julia', args, {
    stdio: 'ignore',
    env: { ...process.env, JULIA_PLUTO_NEW_NOTEBOOKS_DIR: notebooks },
  });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (exited) throw new Error('julia exited before Pluto came up — is Pluto installed? (see PLUTO_JULIA_PROJECT)');
    if (Date.now() > deadline) { proc.kill(); throw new Error('timed out waiting for Pluto to start'); }
    try { if ((await fetch(url)).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, stop: async () => { proc.kill('SIGINT'); setTimeout(() => proc.kill('SIGKILL'), 3000).unref(); } };
}

// ---------- Browser ----------
// FIREFOX_BIN overrides the executable. Otherwise use Playwright's own build,
// falling back to any other Playwright Firefox already in the cache so a
// one-revision mismatch doesn't force a fresh download.
export async function launchFirefox() {
  const headless = process.env.HEADED ? false : true;
  if (process.env.FIREFOX_BIN) return firefox.launch({ headless, executablePath: process.env.FIREFOX_BIN });
  try {
    return await firefox.launch({ headless });
  } catch (err) {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
    const builds = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('firefox-')).sort().reverse() : [];
    for (const b of builds) {
      const exe = join(cache, b, 'firefox', 'firefox');
      if (existsSync(exe)) return firefox.launch({ headless, executablePath: exe });
    }
    throw new Error(`${err.message}\n\nNo Playwright Firefox found — run: npx playwright install firefox`);
  }
}

// ---------- Notebook page ----------
export async function openNotebook(browser, plutoUrl) {
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${plutoUrl}/new`);
  await page.waitForSelector('pluto-cell .cm-content', { timeout: 120_000 });

  // Independent view lookup for assertions (deliberately not the engine's own).
  await page.evaluate(() => {
    window.__testView = (cell = 0) => {
      const c = document.querySelectorAll('pluto-cell .cm-content')[cell];
      if (!c) return null;
      if (c.cmTile) return c.cmTile.root.view;   // newer @codemirror/view
      return c.cmView.view;                      // older releases
    };
  });

  await page.addStyleTag({ path: join(ROOT, 'content.css') });
  await page.addScriptTag({ path: join(ROOT, 'emacs-mode.js') });
  return page;
}

// Replace the cell's text, put the cursor at `cursor`, focus it, and C-g to
// drop any mark / prefix / kill-yank streak left over from the previous test.
export async function setDoc(page, text, cursor = 0, cell = 0) {
  await page.evaluate(([text, cursor, cell]) => {
    const v = window.__testView(cell);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: cursor } });
    v.focus();
  }, [text, cursor, cell]);
  await page.keyboard.press('Control+g');
}

export const doc = (page, cell = 0) => page.evaluate((c) => window.__testView(c).state.doc.toString(), cell);
export const head = (page, cell = 0) => page.evaluate((c) => window.__testView(c).state.selection.main.head, cell);
export const sel = (page, cell = 0) => page.evaluate((c) => {
  const s = window.__testView(c).state.selection.main;
  return [s.from, s.to];
}, cell);
export const echoText = (page) => page.evaluate(() => {
  const e = document.querySelector('.pluto-emacs-echo');
  return e && getComputedStyle(e).display !== 'none' ? e.textContent : '';
});
export const cellCount = (page) => page.evaluate(() => document.querySelectorAll('pluto-cell').length);
export const focusedCell = (page) => page.evaluate(() => {
  const c = document.activeElement && document.activeElement.closest('pluto-cell');
  return c ? Array.from(document.querySelectorAll('pluto-cell')).indexOf(c) : -1;
});

// Press a sequence of chords, e.g. keys(page, 'Control+u', '3', 'Control+f').
export async function keys(page, ...chords) {
  for (const c of chords) await page.keyboard.press(c);
}
