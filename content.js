// Content script – detects Pluto notebooks and injects the Emacs mode engine.
// Runs in an isolated world; the actual Emacs logic lives in emacs-mode.js
// which is injected into the page context so it can access CodeMirror
// EditorView instances on the DOM.
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;

  function isPlutoPage() {
    return document.querySelector('pluto-notebook') !== null ||
           document.querySelector('pluto-editor') !== null;
  }

  function injectEmacsMode() {
    if (document.getElementById('pluto-emacs-mode-script')) return;
    const script = document.createElement('script');
    script.id = 'pluto-emacs-mode-script';
    script.src = api.runtime.getURL('emacs-mode.js');
    (document.head || document.documentElement).appendChild(script);
  }

  function removeEmacsMode() {
    // Tell the page-level script to tear down.
    window.dispatchEvent(new CustomEvent('pluto-emacs-disable'));
  }

  function enableEmacsMode() {
    window.dispatchEvent(new CustomEvent('pluto-emacs-enable'));
  }

  // Listen for state changes from the background worker / popup.
  api.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'emacsStateChanged') {
      if (msg.enabled) {
        injectEmacsMode();
        enableEmacsMode();
      } else {
        removeEmacsMode();
      }
    }
  });

  // Wait for Pluto to finish rendering, then inject if enabled.
  function boot() {
    if (!isPlutoPage()) return;

    api.runtime.sendMessage({ type: 'getState' }).then((res) => {
      if (res && res.enabled) {
        injectEmacsMode();
      }
    }).catch(() => {});
  }

  // Pluto can take a moment to build the DOM – wait for load, then rely on
  // a MutationObserver for late-loading pages.
  if (document.readyState === 'complete') {
    boot();
  } else {
    window.addEventListener('load', boot);
  }

  // Fallback observer: if Pluto loads asynchronously, detect it appearing.
  const observer = new MutationObserver(() => {
    if (isPlutoPage()) {
      observer.disconnect();
      boot();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
