const api = (typeof browser !== 'undefined') ? browser : chrome;
const checkbox = document.getElementById('enabled');

api.runtime.sendMessage({ type: 'getState' }).then((res) => {
  checkbox.checked = !!(res && res.enabled);
}).catch(() => {});

checkbox.addEventListener('change', () => {
  api.runtime.sendMessage({ type: 'setState', enabled: checkbox.checked });
});
