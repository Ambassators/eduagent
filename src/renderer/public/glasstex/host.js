/* Electron adapter. The frame receives document data, never the desktop IPC bridge. */
(() => {
  const channel = 'codex-glasstex';
  window.webkit = { messageHandlers: { editor: { postMessage(message) {
    if (parent !== window) parent.postMessage({ channel, ...message }, '*');
  } } } };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data.type === 'document') window.GlassTeX?.setDocument(event.data.payload);
    if (event.data.type === 'command') window.GlassTeX?.receive(event.data.payload);
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const action = key === 'o' ? 'open' : key === 's' ? event.shiftKey ? 'saveCopy' : 'save' : key === ',' ? 'settings'
      : key === 'k' ? 'palette' : event.shiftKey && key === 'l' ? 'source'
      : event.shiftKey && key === 'p' ? 'preview' : event.shiftKey && key === 'i' ? 'inspector'
      : event.shiftKey && key === 't' ? 'paragraph' : event.altKey && event.code === 'KeyE' ? 'export' : null;
    if (!action) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.webkit.messageHandlers.editor.postMessage({ type: 'request', action });
  }, true);
})();
