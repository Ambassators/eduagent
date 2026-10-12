/* Electron adapter. The frame receives document data, never the desktop IPC bridge. */
(() => {
  const channel = 'codex-glasstex';
  const pausedStyle = new CSSStyleSheet();
  pausedStyle.replaceSync(":host-context(html[data-render-active='false']) *, :host-context(html[data-render-active='false']) *::before, :host-context(html[data-render-active='false']) *::after { animation-play-state: paused !important; transition: none !important; }");
  function pauseMathFields() {
    for (const field of document.querySelectorAll('math-field')) {
      const root = field.shadowRoot;
      if (root && !root.adoptedStyleSheets.includes(pausedStyle)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, pausedStyle];
    }
  }
  const observer = new MutationObserver(pauseMathFields);
  window.webkit = { messageHandlers: { editor: { postMessage(message) {
    if (parent !== window) parent.postMessage({ channel, ...message }, '*');
  } } } };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data.type === 'document') window.GlassTeX?.setDocument(event.data.payload);
    if (event.data.type === 'command') window.GlassTeX?.receive(event.data.payload);
    if (event.data.type === 'renderActivity') {
      const active = event.data.payload === true;
      document.documentElement.dataset.renderActive = String(active);
      observer.disconnect();
      if (!active) { pauseMathFields(); observer.observe(document.body, { childList: true, subtree: true }); }
    }
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const action = key === 'o' ? 'open' : key === 's' ? event.shiftKey ? 'saveCopy' : 'save' : key === ',' ? 'settings'
      : key === 'k' ? 'palette' : event.shiftKey && key === 'l' ? 'source'
      : event.shiftKey && key === 'p' ? 'preview'
      : event.shiftKey && key === 't' ? 'paragraph' : event.altKey && event.code === 'KeyE' ? 'export' : null;
    if (!action) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.webkit.messageHandlers.editor.postMessage({ type: 'request', action });
  }, true);
})();
