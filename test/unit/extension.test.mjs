// Unit tests for the two extension-side scripts, run in a vm sandbox with a
// fake `browser` API (and, for content.js, a fake DOM). No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (f) => readFileSync(resolve(ROOT, f), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- background.js ----------
function loadBackground(initialStore = {}) {
  const store = { ...initialStore };
  const sent = [];
  const listeners = {};
  const browser = {
    runtime: {
      onInstalled: { addListener: (f) => { listeners.installed = f; } },
      onMessage: { addListener: (f) => { listeners.message = f; } },
    },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => { Object.assign(store, o); },
      },
    },
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      sendMessage: (id, msg) => {
        sent.push({ id, msg });
        return id === 2 ? Promise.reject(new Error('no receiver')) : Promise.resolve();
      },
    },
  };
  vm.runInNewContext(src('background.js'), { browser });
  // Replies are created inside the vm realm; round-trip them through JSON so
  // deepStrictEqual compares plain objects from this realm.
  const send = (message) => new Promise((res) => {
    const reply = (r) => res(JSON.parse(JSON.stringify(r)));
    assert.equal(listeners.message(message, {}, reply), true, 'listener must return true (async response)');
  });
  return { store, sent, listeners, send };
}

test('background: first install seeds emacsEnabled = true', async () => {
  const bg = loadBackground();
  bg.listeners.installed({ reason: 'install' });
  await tick();
  assert.equal(bg.store.emacsEnabled, true);
});

test('background: update / reload keeps a disabled state', async () => {
  const bg = loadBackground({ emacsEnabled: false });
  bg.listeners.installed({ reason: 'update' });
  await tick();
  assert.equal(bg.store.emacsEnabled, false);
  bg.listeners.installed({ reason: 'install' }); // reinstall over existing data
  await tick();
  assert.equal(bg.store.emacsEnabled, false);
});

test('background: getState defaults to enabled when nothing is stored', async () => {
  assert.deepEqual(await loadBackground().send({ type: 'getState' }), { enabled: true });
  assert.deepEqual(await loadBackground({ emacsEnabled: false }).send({ type: 'getState' }), { enabled: false });
});

test('background: setState persists, replies, and broadcasts to every tab', async () => {
  const bg = loadBackground();
  assert.deepEqual(await bg.send({ type: 'setState', enabled: false }), { enabled: false });
  await tick();
  assert.equal(bg.store.emacsEnabled, false);
  assert.deepEqual(bg.sent.map((s) => s.id), [1, 2, 3], 'a tab without a receiver must not stop the broadcast');
  assert.deepEqual(JSON.parse(JSON.stringify(bg.sent[0].msg)), { type: 'emacsStateChanged', enabled: false });
});

// ---------- content.js ----------
function loadContent({ pluto, enabled }) {
  const appended = [];
  const events = [];
  let onMessage = null;
  const document = {
    readyState: 'complete',
    querySelector: (sel) => (pluto && /pluto-(notebook|editor)/.test(sel) ? {} : null),
    getElementById: (id) => appended.find((el) => el.id === id) || null,
    createElement: () => ({}),
    head: { appendChild: (el) => appended.push(el) },
    documentElement: {},
  };
  const window = {
    addEventListener: () => {},
    dispatchEvent: (ev) => { events.push(ev.type); },
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  class MutationObserver { observe() {} disconnect() {} }
  const browser = {
    runtime: {
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: { addListener: (f) => { onMessage = f; } },
      sendMessage: async () => ({ enabled }),
    },
  };
  vm.runInNewContext(src('content.js'), { browser, document, window, CustomEvent, MutationObserver, setTimeout });
  return { appended, events, onMessage: (m) => onMessage(m) };
}

test('content: injects the engine on a Pluto page when enabled', async () => {
  const c = loadContent({ pluto: true, enabled: true });
  await tick();
  assert.equal(c.appended.length, 1);
  assert.equal(c.appended[0].src, 'moz-extension://test/emacs-mode.js');
});

test('content: stays out of Pluto pages when disabled, and out of non-Pluto pages always', async () => {
  const off = loadContent({ pluto: true, enabled: false });
  const other = loadContent({ pluto: false, enabled: true });
  await tick();
  assert.equal(off.appended.length, 0);
  assert.equal(other.appended.length, 0);
  other.onMessage({ type: 'emacsStateChanged', enabled: true });
  assert.equal(other.appended.length, 0, 'a broadcast must not inject into a non-Pluto localhost page');
  assert.deepEqual(other.events, []);
});

test('content: state broadcasts toggle the engine without re-injecting', async () => {
  const c = loadContent({ pluto: true, enabled: false });
  await tick();
  c.onMessage({ type: 'emacsStateChanged', enabled: true });
  c.onMessage({ type: 'emacsStateChanged', enabled: false });
  c.onMessage({ type: 'emacsStateChanged', enabled: true });
  assert.equal(c.appended.length, 1, 'the <script> is injected once');
  assert.deepEqual(c.events, ['pluto-emacs-enable', 'pluto-emacs-disable', 'pluto-emacs-enable']);
});
