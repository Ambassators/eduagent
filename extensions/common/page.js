// Fixed page operations shared by the embedded browser and both extensions.
// No model-provided JavaScript is evaluated.
globalThis.codexPageAction = function (args) {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const selector = el => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter(other => other.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return `html > ${parts.join(' > ')}`;
  };
  if (args.action === 'snapshot') {
    const clone = document.body?.cloneNode(true);
    clone?.querySelectorAll('script,style,noscript,input,textarea,[contenteditable], [hidden]').forEach(el => el.remove());
    return { url: location.href, title: document.title, text: (clone?.textContent || '').replace(/\s+/g, ' ').slice(0, 30000),
      elements: [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 200).map(el => ({
        selector: selector(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'),
        label: (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 200),
        value: el.type === 'password' ? '[redacted]' : typeof el.value === 'string' ? el.value.slice(0, 500) : undefined,
        href: el.tagName === 'A' ? el.href : undefined, disabled: !!el.disabled
      })) };
  }
  if (args.action === 'scroll') { window.scrollBy({ left: args.x || 0, top: args.y ?? 600, behavior: 'instant' }); return { scrolled: true }; }
  if (!['click', 'fill', 'select'].includes(args.action)) throw new Error('Unsupported page action.');
  const matches = document.querySelectorAll(args.selector);
  if (matches.length !== 1) throw new Error(`Selector matched ${matches.length} elements. Read a fresh snapshot and use a unique selector.`);
  const el = matches[0];
  if (!visible(el) || el.disabled) throw new Error('Element is hidden or disabled.');
  el.scrollIntoView({ block: 'center' }); el.focus();
  if (args.action === 'click') { el.click(); return { clicked: true }; }
  if (el.type === 'password' || el.type === 'file') throw new Error('Enter passwords and select files directly in the browser.');
  if (args.action === 'select') {
    if (!(el instanceof HTMLSelectElement) || ![...el.options].some(option => option.value === args.value)) throw new Error('Select value is unavailable.');
    el.value = args.value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, args.value);
  } else if (el.isContentEditable) el.textContent = args.value;
  else throw new Error('Element is not an editable field.');
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  return { updated: true };
};
