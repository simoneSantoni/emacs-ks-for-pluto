// Background event page for Emacs Keybindings for Pluto.
// Manages the enabled/disabled state and communicates with content scripts.
//
// Firefox's WebExtension APIs live under `browser` and return promises; the
// `chrome` alias exists too but is callback-based, so we normalise onto
// `browser` (falling back to `chrome` on Chromium-family browsers).
const api = (typeof browser !== 'undefined') ? browser : chrome;

// Seed the default on first install only. `onInstalled` also fires on updates
// and add-on reloads, where rewriting the key would undo the user's choice.
api.runtime.onInstalled.addListener((details) => {
  if (details && details.reason !== 'install') return;
  api.storage.local.get('emacsEnabled').then((result) => {
    if (result.emacsEnabled === undefined) api.storage.local.set({ emacsEnabled: true });
  });
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getState') {
    api.storage.local.get('emacsEnabled').then((result) => {
      sendResponse({ enabled: result.emacsEnabled !== false });
    });
    return true; // async response
  }

  if (message.type === 'setState') {
    api.storage.local.set({ emacsEnabled: message.enabled }).then(() => {
      // Broadcast to all tabs so active Pluto pages update immediately.
      api.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          api.tabs.sendMessage(tab.id, {
            type: 'emacsStateChanged',
            enabled: message.enabled,
          }).catch(() => {});
        }
      });
      sendResponse({ enabled: message.enabled });
    });
    return true;
  }
});
