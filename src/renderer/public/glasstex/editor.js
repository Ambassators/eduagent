/* GlassTeX visual editor. Runs in the sandboxed editor frame; the host owns file IO and undo.
 *
 * Model. `doc.source` is the document and the only source of truth. Scanning it (tex.js)
 * gives `doc.tokens`: a flat, ordered list of source ranges for prose, math, code, and the
 * opening and closing delimiters of lists, tables and other blocks.
 *
 * View. render() builds the page from the tokens. Each editable token gets an "item": a
 * contenteditable element (prose, headings, code, raw source) or a MathLive field (math).
 *
 * Edits. The source changes in exactly two ways:
 *  - editInside(item, …): typing inside one item. The page stays as it is; the item's token
 *    grows or shrinks and every later token shifts by the same amount.
 *  - editStructure(…): everything else (deleting across items, removing an empty item,
 *    joining lines, inserting blocks). The source is rewritten, then the page is rendered
 *    again from it with the caret placed at a source offset.
 * Every change is posted to the host as a patch.
 */
(() => {
  'use strict';
  const T = window.TeX;
  const page = document.getElementById('page');
  const native = !!window.webkit?.messageHandlers?.editor;

  // ---------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------

  /** The document. tokens, body and macros are derived from source by render(). */
  const doc = { source: '', revision: 0, tokens: [], body: { start: 0, end: 0 }, macros: {} };
  /** The rendered page. items maps editable token ids to their editors, in no particular order;
   *  editableItems() gives document order. regions are the containers (lists, cells, blocks…). */
  const view = { items: new Map(), regions: [], rendering: false, layoutFrame: null, slotID: 0 };
  /** What the person is doing. */
  const ui = {
    active: null,          // the focused item
    preview: false,        // show KaTeX instead of editors
    verticalGoal: null,    // column kept across consecutive Up/Down presses
    conversion: null,      // the last automatic text-to-math conversion; Backspace undoes it
    autoMathTimer: null,
  };
  /** The local calculation worker and its latest suggestion. */
  const solver = { worker: null, url: null, request: 0, timer: null, watchdog: null, suggestion: null };
  let settings = { angleMode: 'radians', automatic: true, autoEquations: true, fontSize: 22, appearance: 'system', documentSpacing: 'compact' };
  let commands = window.COMMANDS || [];

  // Token kinds, by role.
  const CONTAINERS = { blockStart: 'blockEnd', listStart: 'listEnd', formatStart: 'formatEnd', tableStart: 'tableEnd', tableRowStart: 'tableRowEnd', tableCellStart: 'tableCellEnd' };
  const CLOSERS = new Set(Object.values(CONTAINERS));
  const TEXT_KINDS = new Set(['text', 'heading', 'raw', 'code']);
  /** Tokens that a stretch of whitespace before them cannot be seen next to. */
  const BLOCK_FOLLOWERS = new Set(['blockStart', 'blockEnd', 'listStart', 'listItem', 'listEnd', 'tableStart', 'tableEnd', 'tableRowEnd', 'tableCellEnd', 'code', 'heading', 'raw', 'linebreak', 'spacing', 'pagebreak']);
  /** Tokens that can sit between two items on the same line of prose. */
  const INLINE_GAP = new Set(['formatStart', 'formatEnd', 'literal', 'comment', 'metadata', 'text']);
  /** Tokens that one Backspace or Delete removes whole: forced line breaks, spaces, page breaks, …, \LaTeX. */
  const ATOMS = new Set(['linebreak', 'spacing', 'pagebreak', 'literal']);
  /** Algorithm statements that stand alone; control-flow lines (While … EndWhile) come in groups. */
  const STATEMENTS = new Set(['State', 'Statex', 'Require', 'Ensure']);

  // ---------------------------------------------------------------------------------------
  // Host messages
  // ---------------------------------------------------------------------------------------

  const post = (type, payload = {}) => {
    if (native) window.webkit.messageHandlers.editor.postMessage({ type, ...payload });
    else window.dispatchEvent(new CustomEvent('glasstex-message', { detail: { type, ...payload } }));
  };
  const report = message => post('notice', { message });
  const announce = message => { document.getElementById('live-region').textContent = message; };
  function fatal(message) {
    const el = document.getElementById('fatal');
    el.hidden = false; el.textContent = message;
    post('error', { message });
  }

  // ---------------------------------------------------------------------------------------
  // Source edits
  // ---------------------------------------------------------------------------------------

  let recoveryTimer = null;
  /** Replace source[start, end) and send the patch. False when nothing changed or the offsets are invalid. */
  function replaceSource(start, end, replacement) {
    let patch;
    try { patch = T.sourcePatch(doc.source, start, end, replacement, doc.revision); }
    catch {
      // Stale offsets must never edit the wrong text. Drop the edit and rebuild from source.
      recoveryTimer ??= setTimeout(() => {
        recoveryTimer = null; render();
        report('The page was out of date and has been refreshed. That last edit was not applied.');
      });
      return false;
    }
    if (patch.expected === replacement) return false;
    doc.source = T.applyPatch(doc.source, patch, doc.revision);
    doc.revision++;
    post('patch', { patch });
    return true;
  }
  const shift = (token, delta) => { token.start += delta; token.end += delta; token.contentStart += delta; token.contentEnd += delta; };
  /** Typing inside one item: only its own content changes, so the page stays valid. */
  function editInside(item, start, end, replacement) {
    const token = item.token;
    if (start < token.contentStart || end > token.contentEnd) throw new Error('Edit outside its item');
    if (!replaceSource(start, end, replacement)) return false;
    const delta = replacement.length - (end - start);
    token.contentEnd += delta; token.end += delta;
    // Token order, not offsets, decides what moves: zero-width tokens at the edit stay on their side.
    for (let i = doc.tokens.indexOf(token) + 1; i < doc.tokens.length; i++) shift(doc.tokens[i], delta);
    doc.body.end += delta;
    return true;
  }
  /** Any other edit: rewrite the source, then render the page again and place the caret (see placeFocus). */
  function editStructure(start, end, replacement, focus) {
    if (!replaceSource(start, end, replacement)) return false;
    render(focus);
    return true;
  }
  const lineEnding = () => doc.source.includes('\r\n') ? '\r\n' : '\n';
  /** Prose as TeX. A visible line break is a paragraph break; one source newline would only be a space. */
  const encodeProse = text => T.encodeText(text).replace(/\r\n|\r|\n/g, lineEnding() + lineEnding());
  /** Source length of each prefix of encodeProse(text): offsets[i] is where display character i starts. */
  function proseOffsets(text) {
    const offsets = [0], breakLength = 2 * lineEnding().length;
    for (let i = 0; i < text.length; i++) offsets.push(offsets[i] + (text[i] === '\n' ? breakLength : T.encodeText(text[i]).length));
    return offsets;
  }

  // ---------------------------------------------------------------------------------------
  // Items: text and caret positions
  // ---------------------------------------------------------------------------------------

  /** Editable items in document order. */
  const editableItems = () => doc.tokens.map(t => view.items.get(t.id)).filter(Boolean);
  function neighbor(item, forward) {
    const items = editableItems(), index = items.indexOf(item);
    return index < 0 ? null : items[index + (forward ? 1 : -1)] ?? null;
  }
  /** Tokens strictly between two items, in document order. */
  function tokensBetween(a, b) {
    const i = doc.tokens.indexOf(a.token), j = doc.tokens.indexOf(b.token);
    return doc.tokens.slice(Math.min(i, j) + 1, Math.max(i, j));
  }
  const proseText = el => el.innerText.replace(/\u00a0/g, ' ');
  /** What the person sees in an item. Code and raw source are plain text nodes (plus a placeholder
   *  <br>, see setLiteralText); prose can also hold <br> line breaks, which only innerText counts. */
  const itemText = item => item.mf ? item.mf.value : item.literal ? item.el.textContent : proseText(item.el);
  /** Index in itemText(item) of a DOM position inside the item, or null. */
  function textIndex(item, node, offset) {
    const el = item.el;
    if (!node || !el.contains(node)) return null;
    const before = document.createRange();
    before.selectNodeContents(el); before.setEnd(node, offset);
    if (item.literal || el.textContent.replace(/\u00a0/g, ' ') === proseText(el)) return before.toString().length;
    // A Range omits <br> line breaks. Measure a hidden clone with a marker at the position,
    // and require that removing the marker reproduces the live text exactly.
    const marker = '\uE000';
    if (el.textContent.includes(marker)) return null;
    const path = [];
    for (let n = node; n !== el; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
    const clone = el.cloneNode(true);
    clone.removeAttribute('contenteditable');
    clone.style.cssText += ';position:fixed;left:-100000px;opacity:0;pointer-events:none';
    let target = clone;
    for (const index of path) target = target.childNodes[index];
    const mark = document.createRange(); mark.setStart(target, offset); mark.collapse(true);
    mark.insertNode(document.createTextNode(marker));
    page.append(clone);
    try {
      const marked = proseText(clone), index = marked.indexOf(marker);
      return index >= 0 && marked.replace(marker, '') === proseText(el) ? index : null;
    } finally { clone.remove(); }
  }
  /** The collapsed caret's index in itemText(item), or null. */
  function caretIndex(item) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    return textIndex(item, selection.anchorNode, selection.anchorOffset);
  }
  /** Source offset of display index `index` in a text item. */
  function sourceOffsetAt(item, index) {
    const token = item.token;
    if (item.literal) {
      const prefix = item.el.textContent.slice(0, index);
      return token.contentStart + (lineEnding() === '\r\n' ? prefix.replace(/\r?\n/g, '\r\n') : prefix).length;
    }
    return token.contentStart + (item.presentation.offsets[index] ?? encodeProse(itemText(item).slice(0, index)).length);
  }
  /** Display index in a freshly rendered text item for a source offset. */
  function indexAtSource(item, offset) {
    const relative = Math.max(0, offset - item.token.contentStart);
    if (item.literal) return Math.min(relative, item.el.textContent.length);
    const index = item.presentation.offsets.findIndex(value => value >= relative);
    return index >= 0 ? index : item.presentation.text.length;
  }
  /** The DOM position of display index `index` in a text item. A prose <br> is one line break;
   *  the placeholder <br> after code or raw source is nothing. */
  function domPosition(item, index) {
    const walker = document.createTreeWalker(item.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => node.nodeType === Node.TEXT_NODE || (!item.literal && node.nodeName === 'BR') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    let node, left = index, last = null;
    while ((node = walker.nextNode())) {
      const length = node.nodeType === Node.TEXT_NODE ? node.length : 1;
      if (left < length || (left === length && node.nodeType === Node.TEXT_NODE)) {
        return node.nodeType === Node.TEXT_NODE ? [node, left] : [node.parentNode, Array.prototype.indexOf.call(node.parentNode.childNodes, node) + left];
      }
      left -= length; last = node;
    }
    if (last?.nodeType === Node.TEXT_NODE) return [last, last.length];
    return last ? [last.parentNode, Array.prototype.indexOf.call(last.parentNode.childNodes, last) + 1] : [item.el, 0];
  }
  /** Select [index, index + length) of an item's text. */
  function setCaret(item, index, length = 0) {
    const range = document.createRange();
    range.setStart(...domPosition(item, index)); range.setEnd(...domPosition(item, index + length));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  /** Where an item's visible text ends. Prose often ends in a source line break, which reads as a
   *  space or paragraph break. Before a block or at the end of a line nobody sees it, so the caret's
   *  end position is before it; before more prose or an inline equation on the line it is visible. */
  function visibleEnd(item) {
    const text = itemText(item), next = neighbor(item, true);
    if (item.literal || item.presentation?.text !== text || (next && sameLine(item, next))) return text.length;
    const { offsets } = item.presentation, content = doc.source.slice(item.token.contentStart, item.token.contentEnd);
    let end = text.length;
    while (end > 0 && /\n/.test(content.slice(offsets[end - 1], offsets[end]))) end--;
    return end;
  }
  function atBoundary(item, forward) {
    if (item.mf) return item.mf.selectionIsCollapsed && item.mf.position === (forward ? item.mf.lastOffset : 0);
    const caret = caretIndex(item);
    return caret !== null && (forward ? caret >= visibleEnd(item) : caret === 0);
  }
  function setActive(item) {
    clearTimeout(ui.autoMathTimer);
    if (ui.active && ui.active !== item) ui.conversion = null;
    ui.active = item;
    if (item.mf) { postActive(); scheduleAnalysis(); }
    else { clearSuggestion(); post('active', { latex: '', display: false, start: item.token.contentStart, end: item.token.contentEnd }); }
  }
  /** Focus an item with the caret at its start, or its end. */
  function focusEdge(item, end = false) {
    setActive(item);
    if (item.mf) { item.mf.focus(); item.mf.position = end ? item.mf.lastOffset : 0; return; }
    item.el.focus();
    setCaret(item, end ? visibleEnd(item) : 0);
  }
  /** Laid out on its own line rather than inline in prose. */
  const isBlockItem = item => item.token.kind === 'math' ? item.token.display : ['heading', 'code', 'raw'].includes(item.token.kind);
  const isWhitespace = token => (token.kind === 'text' || token.kind === 'metadata') && !doc.source.slice(token.start, token.end).trim();
  const isParagraphBreak = token => isWhitespace(token) && /\n[ \t]*\r?\n/.test(doc.source.slice(token.start, token.end));
  /** Whether two items are on one line of prose, with only inline source between them. */
  function sameLine(a, b) {
    if (isBlockItem(a) || isBlockItem(b)) return false;
    return tokensBetween(a, b).every(t => INLINE_GAP.has(t.kind) && !isParagraphBreak(t));
  }

  // ---------------------------------------------------------------------------------------
  // Regions: the containers around items (lists, list items, cells, blocks, formatting)
  // ---------------------------------------------------------------------------------------

  const regionRange = region => ({ start: region.first.start, end: region.before ? region.last.start : region.last.end });
  function addRegion(el, first, kind) {
    const region = { el, first, last: first, kind, before: false };
    view.regions.push(region);
    return region;
  }
  function closeRegion(region, last, before = false) { if (region) { region.last = last; region.before = before; } }
  /** The token list as a tree: each container holds the tokens between its opening and closing token. */
  function structureTree() {
    const root = { children: [] }, stack = [root];
    for (const token of doc.tokens) {
      if (CONTAINERS[token.kind]) {
        const node = { open: token, close: null, children: [], parent: stack.at(-1) };
        stack.at(-1).children.push(node); stack.push(node);
      } else if (CLOSERS.has(token.kind) && stack.length > 1) stack.pop().close = token;
      else stack.at(-1).children.push({ token, parent: stack.at(-1) });
    }
    return root;
  }
  /** The innermost container whose content holds `offset`. */
  function containerAt(node, offset) {
    for (const child of node.children) {
      if (child.open && child.close && child.open.end <= offset && offset <= child.close.start) return containerAt(child, offset);
    }
    return node;
  }

  // ---------------------------------------------------------------------------------------
  // Deleting
  // ---------------------------------------------------------------------------------------

  /**
   * The source to remove when Backspace or Delete is pressed in an empty item: the item itself
   * (an empty equation, heading or listing), or the largest empty container around it (a list
   * item, a statement, a formatting group, a whole table when deleting into it from outside).
   * A line of a control structure (for … do / end for) goes only with the whole structure, when
   * all of it is empty. Never a table cell, and never anything holding a comment.
   */
  function emptyRemovalRange(item, origin = item) {
    if (itemText(item) !== '') return null;
    const token = item.token;
    if (['math', 'heading', 'code', 'raw'].includes(token.kind)) return token.start < token.end ? { start: token.start, end: token.end } : null;
    const items = editableItems();
    const blank = inRange => items.filter(inRange).every(i => !itemText(i).trim());
    const usable = range => range.start < range.end && !doc.tokens.some(t => t.kind === 'comment' && t.start >= range.start && t.end <= range.end);
    const cell = item.el.closest('td'), table = cell?.closest('table');
    if (table && !table.contains(origin.el)) {
      const region = view.regions.find(r => r.kind === 'table' && r.el.contains(table));
      if (region && blank(i => table.contains(i.el)) && usable(regionRange(region))) return regionRange(region);
    }
    for (const region of view.regions) {
      if (['cell', 'row', 'table'].includes(region.kind) || !region.el.contains(item.el) || (cell && !cell.contains(region.el))) continue;
      let range = regionRange(region);
      const line = region.first;
      if (line.environment === 'algorithm-line' && !STATEMENTS.has(line.command)) {
        if (line.group === null) continue;
        // The whole structure: from its first line to its last, with everything nested in it.
        const lines = view.regions.filter(r => r.first.environment === 'algorithm-line' && r.first.group === line.group).map(regionRange);
        range = { start: Math.min(...lines.map(r => r.start)), end: Math.max(...lines.map(r => r.end)) };
        if (blank(i => i.token.start >= range.start && i.token.end <= range.end) && usable(range)) return range;
        continue;
      }
      if (blank(i => region.el.contains(i.el)) && usable(range)) return range;
    }
    return null;
  }
  /**
   * Backspace at the start of a list item joins it to the previous item; likewise for two
   * algorithm statements. Returns the edit, or null when the two items cannot be joined.
   */
  function joinEdit(earlier, later) {
    const gap = tokensBetween(earlier, later);
    const markers = gap.filter(t => t.kind === 'listItem');
    if (markers.length === 1 && gap.every(t => t.kind === 'listItem' || t.kind === 'comment' || isWhitespace(t))) {
      const earlierItem = earlier.el.closest('li'), laterItem = later.el.closest('li');
      if (earlierItem && laterItem?.previousElementSibling === earlierItem) {
        // The marker's own whitespace goes with it; keep one space between the joined words.
        const marker = markers[0], spaced = /\s$/.test(doc.source.slice(0, marker.start));
        return { start: marker.start, end: marker.end, replacement: spaced ? '' : ' ', caret: marker.start + (spaced ? 0 : 1) };
      }
    }
    if (gap.length === 2 && gap[0].kind === 'blockEnd' && gap[1].environment === 'algorithm-line' && STATEMENTS.has(gap[1].command)) {
      const line = view.regions.find(r => r.last === gap[0])?.first;
      if (line?.environment === 'algorithm-line' && STATEMENTS.has(line.command))
        return { start: gap[0].start, end: gap[1].end, replacement: ' ', caret: gap[0].start + 1 };
    }
    return null;
  }
  /**
   * Backspace (forward = false) or Delete with a collapsed caret at the edge of `item`.
   * In order:
   *  1. An empty item is removed (with any container it leaves empty).
   *  2. A line break, vertical space, page break or literal (…, \LaTeX) beside the caret is removed.
   *  3. Adjacent list items, or algorithm statements, are joined.
   *  4. An empty neighbour is removed.
   *  5. On the same line of prose, one character of the neighbour is deleted, as in one text box.
   *  6. Otherwise (a neighbour in another block, cell or line) the caret moves into the neighbour.
   *     Nothing in another block is deleted without the caret being there first.
   */
  function deleteAtBoundary(item, forward) {
    ui.conversion = null;
    const own = emptyRemovalRange(item);
    if (own) {
      // The caret continues where the deletion was heading: the end of the previous item, or the start of the next.
      let target = neighbor(item, forward);
      while (target && target.token.start >= own.start && target.token.end <= own.end) target = neighbor(target, forward);
      const focus = target ? edgeFocus(target, !forward, forward ? own.end - own.start : 0) : { offset: own.start, text: true };
      editStructure(own.start, own.end, '', focus);
      return;
    }
    let next = neighbor(item, forward);
    // Pass over empty insertion points on the same line, which hold nothing to delete.
    while (next && itemText(next) === '' && !emptyRemovalRange(next, item) && sameLine(item, next)) next = neighbor(next, forward);
    if (!next) return;
    // Removing something beside the item keeps the caret at the item's edge.
    const removeBeside = ({ start, end }) => editStructure(start, end, '', edgeFocus(item, forward, forward ? 0 : end - start));
    const gap = tokensBetween(item, next);
    for (const token of forward ? gap : gap.reverse()) {
      if (ATOMS.has(token.kind)) { removeBeside(token); return; }
      if (!INLINE_GAP.has(token.kind) || isParagraphBreak(token)) break;
    }
    const join = forward ? joinEdit(item, next) : joinEdit(next, item);
    if (join) { editStructure(join.start, join.end, join.replacement, { offset: join.caret, affinity: forward ? 'before' : 'after', text: true }); return; }
    const empty = emptyRemovalRange(next, item);
    if (empty) { removeBeside(empty); return; }
    focusEdge(next, !forward);
    if (!sameLine(item, next)) return;
    if (next.mf) { next.mf.executeCommand(forward ? 'deleteForward' : 'deleteBackward'); saveMath(next); }
    else document.execCommand(forward ? 'forwardDelete' : 'delete');
  }
  /** A focus (see render) for the start or end of `item` once `removedBefore` source characters before it are gone. */
  function edgeFocus(item, end, removedBefore = 0) {
    const token = item.token;
    if (item.mf) return { offset: token.start - removedBefore, mathPosition: end ? null : 0 };
    return { offset: (end ? sourceOffsetAt(item, visibleEnd(item)) : token.contentStart) - removedBefore, affinity: end ? 'before' : 'after', text: true };
  }
  /**
   * Replace source[start, end) — a selection across items — with `insert`. Everything in the
   * range goes, except what keeps the document well formed: the delimiters of containers the
   * range only partly covers, table cell separators (cells are cleared, never removed), and
   * the lines of a control structure that is not wholly selected. List items, and algorithm
   * statements, that the range starts and ends in are joined.
   */
  function replaceRange(start, end, insert) {
    const kept = [];
    const keep = (from, to) => { from = Math.max(from, start); to = Math.min(to, end); if (from < to) kept.push(doc.source.slice(from, to)); };
    const inside = (from, to) => from >= start && to <= end;
    const overlaps = (from, to) => from < end && to > start;
    const tree = structureTree();
    // Two statements joined by the range lose the end of the first and the start of the second.
    const dropped = new Set();
    const first = containerAt(tree, start), last = containerAt(tree, end);
    const statement = node => node.open?.environment === 'algorithm-line' && STATEMENTS.has(node.open.command);
    if (first !== last && first.parent === last.parent && statement(first) && statement(last)) { dropped.add(first.close); dropped.add(last.open); }
    const removable = node => {
      if (node.open.kind === 'tableCellStart') return false;
      if (node.open.environment !== 'algorithm-line' || node.open.group === null) return true;
      return node.parent.children.every(line => line.open?.group !== node.open.group || inside(line.open.start, line.close.end));
    };
    const visit = node => {
      // An item marker stays when the range starts before the list: the remaining text still needs its \item.
      const markers = node.open?.kind === 'listStart' ? node.children.filter(c => c.token?.kind === 'listItem').map(c => c.token) : [];
      const covered = markers.filter(m => inside(m.start, m.end));
      const keepMarker = covered.length && start < markers[0].end ? covered.at(-1) : null;
      for (const child of node.children) {
        if (child.token) {
          const t = child.token;
          if (!overlaps(t.start, t.end)) continue;
          if (inside(t.start, t.end)) { if (t === keepMarker) keep(t.start, t.end); continue; }
          keep(t.start, t.contentStart); keep(t.contentEnd, t.end);
          continue;
        }
        const { open, close } = child;
        if (!close || !overlaps(open.start, close.end)) continue;
        if (inside(open.start, close.end) && removable(child)) continue;
        if (!dropped.has(open)) keep(open.start, open.end);
        visit(child);
        if (!dropped.has(close)) keep(close.start, close.end);
      }
    };
    visit(tree);
    const replacement = insert + kept.join('');
    if (!editStructure(start, end, replacement, { offset: start + insert.length, affinity: 'before', text: true }))
      render({ offset: start, affinity: 'before', text: true });
  }
  /** Source offset of a document-selection point: a text position, or before/after an equation. */
  function pointOffset(point) {
    if (point.item.mf) return point.offset ? point.item.token.end : point.item.token.start;
    const index = textIndex(point.item, point.node, point.nodeOffset);
    return index === null ? null : sourceOffsetAt(point.item, index);
  }
  /** Delete a selection that spans items, or replace it with typed or pasted text. */
  function replaceSelection(span, text) {
    const start = pointOffset(span.start), end = pointOffset(span.end);
    if (start === null || end === null || end < start) { render(); return; }
    const literal = !span.start.item.mf && span.start.item.literal;
    const insert = literal ? (lineEnding() === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text) : encodeProse(text);
    replaceRange(start, end, insert);
  }

  // ---------------------------------------------------------------------------------------
  // Navigation between items
  // ---------------------------------------------------------------------------------------

  /** Make a zero-width prose item beside `item`, so the caret has somewhere to go. Typing there
   *  inserts into the source at that offset. Exiting a container places it outside the container. */
  function createTextNeighbor(item, forward, containerRegion = null) {
    let root = item.root || item.el;
    let offset = forward ? item.token.end : item.token.start;
    // Inline math exits into its surrounding prose. Exiting a whole text container
    // (a cell, list, quote, or formatting group) places prose outside that container.
    if (containerRegion || (!item.mf && item.token.kind === 'text')) {
      const outer = containerRegion || view.regions.find(r => r.el.contains(root));
      if (!outer) return null; // Ordinary prose already has a usable terminal caret.
      root = outer.el;
      const range = regionRange(outer);
      offset = forward ? range.end : range.start;
    }
    const slot = { id: `caret-${++view.slotID}`, kind: 'text', start: offset, end: offset, contentStart: offset, contentEnd: offset };
    // Zero-width closing markers belong before a trailing insertion point.
    let index = forward ? doc.tokens.findLastIndex(t => t.end <= offset) + 1 : doc.tokens.findIndex(t => t.start >= offset);
    if (index < 0) index = doc.tokens.length;
    doc.tokens.splice(index, 0, slot);
    const el = makeText(slot);
    if (forward) root.after(el); else root.before(el);
    return view.items.get(slot.id);
  }
  function moveBetweenItems(item, forward) {
    let next = neighbor(item, forward);
    // A leading newline has a DOM range after the equation, but the browser paints
    // its caret at the preceding line's start. Reuse the empty editing slot used at
    // document ends, without adding any characters to the source.
    if (forward && item.mf && next && !next.mf && itemText(next).startsWith('\n')) next = createTextNeighbor(item, true);
    else {
      while (next && !next.mf && /^\s*\n\s*$/.test(itemText(next))) {
        const following = neighbor(next, forward);
        if (!following) return true;
        next = following;
      }
      if (forward && next && !next.mf && itemText(next).startsWith('\n')) {
        focusEdge(next);
        // Crossing the paragraph boundary enters its first visible character.
        const selection = window.getSelection();
        if (selection.anchorNode?.nodeType === Node.TEXT_NODE) selection.collapse(selection.anchorNode, 1);
        return true;
      }
    }
    next ||= createTextNeighbor(item, forward);
    if (!next) return false;
    focusEdge(next, !forward);
    return true;
  }
  function atVerticalBoundary(item, down) {
    if (item.mf) return false; // MathLive emits move-out after navigating its structures.
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !item.el.contains(selection.anchorNode)) return false;
    if (atBoundary(item, down)) return true;
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    const content = document.createRange(); content.selectNodeContents(item.el);
    const lines = [...content.getClientRects()].filter(r => r.height && r.width);
    if (!caret.height || !lines.length) return false;
    const edge = down ? Math.max(...lines.map(r => r.bottom)) : Math.min(...lines.map(r => r.top));
    return down ? caret.bottom >= edge - 2 : caret.top <= edge + 2;
  }
  function leaveTable(item, forward) {
    const table = item.el.closest('table'), items = editableItems().filter(i => table.contains(i.el));
    const edge = forward ? items.at(-1) : items[0];
    const next = neighbor(edge, forward) || createTextNeighbor(edge, forward, view.regions.find(r => r.kind === 'table' && r.el.contains(table)));
    if (!next) return false;
    focusEdge(next, !forward);
    return true;
  }
  function moveTableCell(item, forward) {
    const cell = item.el.closest('td');
    if (!cell) return false;
    const cells = [...cell.closest('table').querySelectorAll('td')];
    const next = cells[cells.indexOf(cell) + (forward ? 1 : -1)];
    if (!next) return leaveTable(item, forward);
    const targets = editableItems().filter(i => next.contains(i.el));
    if (!targets.length) return false;
    focusEdge(forward ? targets[0] : targets.at(-1), !forward);
    return true;
  }
  function moveVertically(item, down) {
    const cell = item.el.closest('td');
    if (cell) {
      const row = cell.parentElement, next = down ? row.nextElementSibling : row.previousElementSibling;
      if (!next) return leaveTable(item, down);
      const target = next.children[[...row.children].indexOf(cell)];
      const items = editableItems().filter(i => target?.contains(i.el));
      if (!items.length) return false;
      focusEdge(down ? items[0] : items.at(-1), !down);
      return true;
    }
    return moveByLine(item, down) ?? moveBetweenItems(item, down);
  }
  /** Each visual line fragment of every editable item, in viewport coordinates. */
  function lineRects() {
    const result = [];
    for (const item of editableItems()) {
      let rects;
      if (item.mf) rects = [item.el.getBoundingClientRect()];
      else {
        const range = document.createRange(); range.selectNodeContents(item.el);
        rects = [...range.getClientRects()];
        if (!rects.length) rects = [...item.el.getClientRects()];
      }
      for (const rect of rects) if (rect.height) result.push({ item, rect });
    }
    return result;
  }
  const centerY = rect => rect.top + rect.height / 2;
  /** The fragments sharing the visual line nearest y, or the line just past `from` going up/down. */
  function visualLine(fragments, { y = null, from = null, down = true }) {
    const pool = from ? fragments.filter(f => down ? centerY(f.rect) > from.bottom : centerY(f.rect) < from.top) : fragments;
    if (!pool.length) return [];
    let anchor = pool[0];
    for (const f of pool) {
      const better = y !== null
        ? Math.max(f.rect.top - y, 0, y - f.rect.bottom) < Math.max(anchor.rect.top - y, 0, y - anchor.rect.bottom)
        : down ? f.rect.top < anchor.rect.top : f.rect.bottom > anchor.rect.bottom;
      if (better) anchor = f;
    }
    // Inline math is taller than text; overlap with the line's middle keeps it on the line.
    const middle = centerY(anchor.rect);
    return pool.filter(f => f.rect.top <= middle && f.rect.bottom >= middle);
  }
  function nearestFragment(line, x) {
    let best = null, distance = Infinity;
    for (const f of line) {
      const d = Math.max(f.rect.left - x, 0, x - f.rect.right);
      if (d < distance) { distance = d; best = f; }
    }
    return best;
  }
  /** Place the caret in `item` at a viewport point on the line `rect`. */
  function placeCaretAt(item, rect, x) {
    x = Math.max(rect.left + 1, Math.min(rect.right - 1, x));
    const y = centerY(rect);
    setActive(item);
    if (item.mf) {
      item.mf.focus();
      const offset = item.mf.getOffsetFromPoint?.(x, y, { bias: 0 });
      item.mf.position = Number.isInteger(offset) && offset >= 0 ? offset : x < (rect.left + rect.right) / 2 ? 0 : item.mf.lastOffset;
      return;
    }
    item.el.focus({ preventScroll: true });
    const caret = document.caretRangeFromPoint?.(x, y);
    if (!caret || !item.el.contains(caret.startContainer)) { focusEdge(item, x > (rect.left + rect.right) / 2); return; }
    caret.collapse(true);
    // A caret after the space at a soft wrap paints at the start of the next line.
    // Keep it on the line that was aimed at, before that space.
    const node = caret.startContainer, offset = caret.startOffset;
    if (node.nodeType === Node.TEXT_NODE && offset > 0 && offset < node.length && /[ \t]/.test(node.data[offset - 1])) {
      const following = document.createRange(); following.setStart(node, offset); following.setEnd(node, offset + 1);
      const next = following.getClientRects()[0];
      if (next && next.top > rect.bottom - 1) caret.setStart(node, offset - 1);
    }
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(caret);
  }
  function caretKey(item) {
    if (item.mf) return `${item.token.id}:${item.mf.position}`;
    return window.getSelection()?.rangeCount ? `${item.token.id}:${caretIndex(item)}` : null;
  }
  /**
   * Move to the visual line above or below, the way a single text box does, even when that
   * line belongs to a different text run or equation. Returns false to leave a move within the
   * same text run to the browser, and null when there is no line in that direction.
   */
  function moveByLine(item, down) {
    let caret;
    if (item.mf) {
      const bounds = item.mf.getElementInfo?.(item.mf.position)?.bounds, wrap = item.el.getBoundingClientRect();
      caret = { left: Number.isFinite(bounds?.right) ? bounds.right : wrap.left, top: wrap.top, bottom: wrap.bottom };
    } else {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return null;
      const range = selection.getRangeAt(0);
      // A collapsed range at a soft wrap has a rect on both lines; it paints on the later one.
      caret = [...range.getClientRects()].at(-1) || range.getBoundingClientRect();
      if (!caret.height) {
        const el = item.el.getBoundingClientRect();
        caret = { left: el.left, top: el.top, bottom: el.bottom };
      }
    }
    // Consecutive Up/Down presses aim at the column where the run of presses began.
    const key = caretKey(item);
    const x = ui.verticalGoal && ui.verticalGoal.key === key ? ui.verticalGoal.x : caret.left;
    const line = visualLine(lineRects(), { from: caret, down });
    if (!line.length) {
      const all = editableItems(), edge = down ? all.at(-1) : all[0];
      if (!edge || (edge === item && (item.mf || atBoundary(item, down)))) return null;
      if (edge === item) return false;
      focusEdge(edge, down); ui.verticalGoal = null;
      return true;
    }
    const target = nearestFragment(line, x);
    if (target.item === item && !item.mf) return false;
    placeCaretAt(target.item, target.rect, x);
    ui.verticalGoal = { x, key: caretKey(target.item) };
    return true;
  }
  function moveWithinMathScripts(mf, down, extend = false) {
    // MathLive 0.109.2's moveUp/moveDown handles above/below (fractions), but
    // emits move-out for superscript/subscript, including summation limits.
    // Consult its pinned atom tree before treating that as a document boundary.
    const model = mf._mathfield?.model;
    if (!model || mf.mode === 'latex') return false;
    const from = down ? 'superscript' : 'subscript', to = down ? 'subscript' : 'superscript';
    const current = model.at(mf.position);
    let owner = current, branch = owner?.branch(to);
    if (!branch) {
      let child = current;
      while (child && child.parentBranch !== from) child = child.parent;
      if (!child) return false;
      owner = child.parent; branch = owner.branch(to);
    }
    let offset = model.offsetOf(owner);
    if (branch?.length) {
      const x = mf.getElementInfo(mf.position)?.bounds?.right;
      let distance = Infinity;
      offset = model.offsetOf(branch.at(-1));
      for (const atom of branch) {
        const candidate = model.offsetOf(atom), bounds = mf.getElementInfo(candidate)?.bounds;
        const delta = bounds && Number.isFinite(x) ? Math.abs(bounds.right - x) : Infinity;
        if (delta < distance) { distance = delta; offset = candidate; }
      }
    }
    if (offset < 0 || offset === mf.position) return false;
    if (extend) {
      const anchor = model.anchor;
      mf.selection = { ranges: [[Math.min(anchor, offset), Math.max(anchor, offset)]], direction: offset < anchor ? 'backward' : 'forward' };
    } else {
      const atom = model.at(offset), placeholder = atom.type === 'placeholder' ? atom : atom.rightSibling?.type === 'placeholder' ? atom.rightSibling : null;
      if (placeholder) { const at = model.offsetOf(placeholder); mf.selection = { ranges: [[at - 1, at]] }; }
      else mf.position = offset;
    }
    return true;
  }
  /** Keys whose meaning depends on the caret being at an item's edge. True when handled. */
  function handleBoundaryKey(item, event) {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
    const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); return true; };
    if (event.key === 'Tab' && !item.mf && item.token.kind !== 'code' && moveTableCell(item, !event.shiftKey)) return consume();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const forward = event.key === 'Delete';
      if (!atBoundary(item, forward)) return false;
      consume(); deleteAtBoundary(item, forward);
      return true;
    }
    if (event.shiftKey) return false;
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (!vertical) ui.verticalGoal = null;
    // Text lines are laid out across runs and inline equations, so a line
    // move is decided by position on the page rather than source order.
    if (vertical && !item.mf && !item.el.closest('td') && window.getSelection()?.isCollapsed) {
      const moved = moveByLine(item, forward) ?? (atBoundary(item, forward) && moveBetweenItems(item, forward));
      return moved ? consume() : false;
    }
    if ((horizontal && atBoundary(item, forward)) || (vertical && atVerticalBoundary(item, forward))) {
      if (vertical ? moveVertically(item, forward) : moveBetweenItems(item, forward)) return consume();
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Text items: prose, headings, code listings and raw source
  // ---------------------------------------------------------------------------------------

  /** Code and raw source are one text node, plus a <br> when the text ends in a line break
   *  (or is empty): without it the browser cannot show a caret on that last, empty line. */
  function setLiteralText(item, text, caret = null) {
    const el = item.el, filler = text === '' || text.endsWith('\n');
    const normal = el.childNodes.length === (text ? 1 : 0) + (filler ? 1 : 0)
      && (!text || el.firstChild.nodeType === Node.TEXT_NODE) && (!filler || el.lastChild.nodeName === 'BR');
    if (normal) return;
    el.replaceChildren(...(text ? [document.createTextNode(text)] : []), ...(filler ? [document.createElement('br')] : []));
    if (caret !== null) setCaret(item, caret);
  }
  /** Insert text at the caret of a code or raw item, as plain text. */
  function insertLiteral(item, text) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !item.el.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    item.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text === '\n' ? 'insertLineBreak' : 'insertText', data: text }));
  }
  /** A line break in prose: a <br> now; encodeProse turns it into a paragraph break in the source. */
  function insertProseBreak(item) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!item.el.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // A terminal break needs a placeholder for the browser to place the next caret.
    if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent === '')) br.after(document.createElement('br'));
    range.setStartAfter(br); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    item.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
  }
  function makeText(token, raw = false) {
    const code = token.kind === 'code', literal = raw || code;
    const el = document.createElement(token.kind === 'heading' ? `h${token.level}` : literal ? 'pre' : 'span');
    el.className = code ? 'code-listing' : raw ? 'source-fragment' : 'text-run';
    el.contentEditable = 'true';
    el.spellcheck = !literal;
    el.setAttribute('aria-label', code ? 'Editable code listing' : raw ? 'LaTeX source fragment' : token.kind === 'heading' ? 'Section heading' : 'Document text');
    const content = doc.source.slice(token.contentStart, token.contentEnd);
    // presentation: the displayed prose and, for each display character, its source offset.
    const item = { token, el, root: el, mf: null, literal, presentation: literal ? null : T.textPresentation(content), dirty: false, pasting: false, gutter: null };
    if (literal) setLiteralText(item, content); else el.textContent = item.presentation.text;
    view.items.set(token.id, item);
    if (code) item.root = codeBlock(item);
    el.addEventListener('focus', () => setActive(item));
    el.addEventListener('paste', event => onTextPaste(item, event));
    el.addEventListener('beforeinput', event => onTextBeforeInput(item, event));
    el.addEventListener('keydown', event => onTextKeydown(item, event));
    el.addEventListener('compositionstart', () => clearTimeout(ui.autoMathTimer));
    el.addEventListener('input', event => { if (!view.rendering) (literal ? onLiteralInput : onProseInput)(item, event); });
    el.addEventListener('blur', () => {
      clearTimeout(ui.autoMathTimer);
      // Raw source can change the document's structure. Re-scan it after the edit, not mid-keystroke.
      if (token.kind === 'raw' && item.dirty && !view.rendering) setTimeout(() => { if (el.isConnected && !el.contains(document.activeElement)) render(); });
    });
    return item.root;
  }
  /** A listing with its line-number gutter. */
  function codeBlock(item) {
    const listing = T.listingPresentation(item.token.options);
    const block = document.createElement('div');
    block.className = 'code-block';
    if (listing.numbers !== 'none') {
      const gutter = document.createElement('pre');
      gutter.className = 'code-line-numbers'; gutter.setAttribute('aria-hidden', 'true'); gutter.contentEditable = 'false';
      block.classList.toggle('numbers-right', listing.numbers === 'right');
      block.append(gutter);
      item.gutter = { el: gutter, first: listing.firstNumber };
      updateLineNumbers(item);
    }
    block.append(item.el);
    return block;
  }
  function updateLineNumbers(item) {
    if (!item.gutter) return;
    const lines = item.el.textContent.split(/\r\n|\r|\n/).length;
    item.gutter.el.textContent = Array.from({ length: lines }, (_, i) => `${item.gutter.first + i}:`).join('\n');
  }
  function onTextPaste(item, event) {
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string') return;
    event.preventDefault();
    if (item.literal) { insertLiteral(item, text); return; }
    item.pasting = true;
    // execCommand keeps the browser's caret placement in prose.
    try { document.execCommand('insertText', false, text); } finally { item.pasting = false; }
  }
  function onTextBeforeInput(item, event) {
    clearTimeout(ui.autoMathTimer);
    if (event.isComposing || !event.cancelable) return;
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault();
      if (item.literal) insertLiteral(item, '\n'); else insertProseBreak(item);
    } else if ((event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward')) {
      const forward = event.inputType === 'deleteContentForward';
      if (atBoundary(item, forward)) { event.preventDefault(); deleteAtBoundary(item, forward); }
    }
  }
  function onTextKeydown(item, event) {
    if (handleBoundaryKey(item, event)) return;
    if (item.token.kind === 'code' && event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); insertLiteral(item, '\t');
    }
  }
  /** Code or raw source changed: patch the changed span of the source. */
  function onLiteralInput(item, event) {
    if (event.isComposing) return;
    const el = item.el, token = item.token;
    const caret = caretIndex(item);
    const text = el.textContent;
    setLiteralText(item, text, caret);
    updateLineNumbers(item);
    const next = lineEnding() === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
    const old = doc.source.slice(token.contentStart, token.contentEnd);
    let prefix = 0, suffix = 0;
    while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
    while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    if (editInside(item, token.contentStart + prefix, token.contentStart + old.length - suffix, next.slice(prefix, next.length - suffix))) item.dirty = true;
    clearSuggestion();
    ui.conversion = null;
  }
  /** Prose changed: encode the changed characters and patch only their span of the source,
   *  keeping untouched escapes and line endings around them. */
  function onProseInput(item, event) {
    const el = item.el, token = item.token;
    // The browser leaves a placeholder <br> after deleting the last character. It is an empty
    // editing surface, not a line break. The empty host keeps its own layout box (see
    // .text-run:empty) so the browser can still place the caret.
    if (event.inputType?.startsWith('delete') && el.childNodes.length === 1 && el.firstChild.nodeName === 'BR') {
      el.replaceChildren(); focusEdge(item);
    }
    const text = proseText(el), old = item.presentation;
    let prefix = 0, suffix = 0;
    while (prefix < old.text.length && prefix < text.length && old.text[prefix] === text[prefix]) prefix++;
    // Identical spaces can have different source spellings (e.g. a source newline), so the
    // diff alone cannot tell which one changed. The caret can: it ends after typed text, and
    // at the place where text was deleted.
    const changed = event.inputType === 'insertText' && typeof event.data === 'string' ? event.data.length
      : event.inputType?.startsWith('delete') ? 0 : null;
    const caret = changed === null ? null : caretIndex(item);
    if (caret !== null && caret >= changed) prefix = Math.min(prefix, caret - changed);
    while (suffix < old.text.length - prefix && suffix < text.length - prefix && old.text[old.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
    const inserted = text.slice(prefix, text.length - suffix), encoded = encodeProse(inserted);
    const start = old.offsets[prefix], end = old.offsets[old.text.length - suffix];
    // An empty \item or \State needs a space before its first typed character.
    const previous = doc.tokens[doc.tokens.indexOf(token) - 1];
    if (encoded && token.contentStart === token.contentEnd && previous?.end === token.contentStart
      && (previous.kind === 'listItem' || previous.environment === 'algorithm-line')
      && /\\(?:item|Statex?|Require|Ensure)$/.test(doc.source.slice(previous.start, previous.end))) {
      const at = token.contentStart;
      editStructure(at, at, ' ' + encoded, { offset: at + 1 + encoded.length, text: true });
      return;
    }
    // The live element can hold <br> line breaks; keep its text as the presentation rather than
    // re-decoding the source, which would lose the mapping of untouched characters.
    const delta = encoded.length - (end - start);
    item.presentation = { text, offsets: [...old.offsets.slice(0, prefix + 1),
      ...proseOffsets(inserted).slice(1).map(offset => start + offset),
      ...old.offsets.slice(old.text.length - suffix + 1).map(offset => offset + delta)] };
    if (editInside(item, token.contentStart + start, token.contentStart + end, encoded)) item.dirty = true;
    clearSuggestion();
    ui.conversion = null;
    clearTimeout(ui.autoMathTimer);
    if (!el.closest('code') && !item.pasting && !event.isComposing && event.inputType === 'insertText') autoConvertText(item);
  }
  /** Typing such as "1/2 " or "sqrt" in prose becomes an inline equation. */
  function autoConvertText(item, delayed = false) {
    if (ui.preview || ui.active !== item || document.activeElement !== item.el || !item.el.isConnected) return;
    const caret = caretIndex(item);
    if (caret === null) return;
    const text = itemText(item);
    const match = window.AutoMath.detectAutoMath(text, caret, settings.autoEquations);
    if (!match) return;
    if (match.delay && !delayed) {
      const revision = doc.revision;
      ui.autoMathTimer = setTimeout(() => { if (doc.revision === revision && caretIndex(item) === caret) autoConvertText(item, true); }, 350);
      return;
    }
    let latex;
    try {
      // Parse scripts with their operand so a/b^2 keeps the exponent in the denominator.
      latex = match.ascii && match.script
        ? window.MathLive.convertAsciiMathToLatex(match.ascii + match.script + '(?)').replace('?', '\\placeholder{}')
        : (match.ascii ? window.MathLive.convertAsciiMathToLatex(match.ascii) : '') + match.latex;
    } catch { return; }
    const start = sourceOffsetAt(item, match.start), end = sourceOffsetAt(item, match.end);
    const original = doc.source.slice(start, end), replacement = '\\(' + latex + '\\)';
    editStructure(start, end, replacement, { offset: start + 2, placeholder: latex.includes('\\placeholder') });
    ui.conversion = { revision: doc.revision, start, end: start + replacement.length, original };
    announce('Inline equation. Press Backspace to restore text.');
  }

  // ---------------------------------------------------------------------------------------
  // Math items
  // ---------------------------------------------------------------------------------------

  function safeMath(latex, element, displayMode) {
    try {
      if (!window.katex) throw new Error('KaTeX assets are missing.');
      window.katex.render(latex, element, { displayMode, throwOnError: false, trust: false, strict: 'warn', maxExpand: 200, maxSize: 20, macros: { ...doc.macros }, output: 'htmlAndMathml' });
    } catch { element.textContent = latex; }
  }
  /** MathLive keys omit the slash; KaTeX keys include it. */
  const mathLiveMacros = () => Object.fromEntries(Object.entries(doc.macros).map(([key, value]) => [key.replace(/^\\/, ''), value]));
  function preserveEdgeWhitespace(old, replacement) {
    const leading = old.match(/^\s*/)?.[0] || '', trailing = old.match(/\s*$/)?.[0] || '';
    if (!old.trim()) {
      const nl = old.includes('\r\n') ? '\r\n' : old.includes('\n') ? '\n' : '';
      return nl + replacement + nl;
    }
    return leading + replacement + trailing;
  }
  function saveMath(item) {
    if (view.rendering) return;
    ui.conversion = null;
    const token = item.token, old = doc.source.slice(token.contentStart, token.contentEnd);
    editInside(item, token.contentStart, token.contentEnd, preserveEdgeWhitespace(old, T.mathFromField(token, item.mf.value)));
    safeMath(item.mf.value, item.rendered, token.display);
    item.el.classList.toggle('empty', !item.mf.value);
    scheduleAnalysis();
  }
  function makeMath(token) {
    const latex = T.mathForField(token, doc.source);
    const metadata = /\\(?:label|tag|nonumber|notag)\b|(^|[^\\])%/.test(latex);
    let errors = [];
    try { errors = window.MathLive?.validateLatex?.(latex, { macros: mathLiveMacros() }) || []; } catch { errors = [{ code: 'invalid-command' }]; }
    if (metadata || errors.some(e => ['unknown-command', 'unknown-environment', 'invalid-command'].includes(e.code))) {
      // Protect labels, comments, package commands and unknown macros from normalization.
      Object.assign(token, { kind: 'raw', contentStart: token.start, contentEnd: token.end });
      return makeText(token, true);
    }
    const wrap = document.createElement(token.display ? 'div' : 'span');
    wrap.className = `math-wrap ${token.display ? 'display' : 'inline'}`;
    // Only an empty field needs a minimum click target; content sets its own width.
    wrap.classList.toggle('empty', !latex);
    const mf = new window.MathfieldElement();
    // MathLive's macros and shortcut accessors require a mounted field.
    mf.addEventListener('mount', () => {
      mf.mathVirtualKeyboardPolicy = 'manual'; mf.smartFence = true; mf.smartMode = false;
      mf.letterShapeStyle = 'tex'; mf.defaultMode = token.display ? 'math' : 'inline-math'; mf.inlineShortcutTimeout = 0;
      mf.macros = { ...mf.macros, ...mathLiveMacros() };
      mf.inlineShortcuts = { ...mf.inlineShortcuts,
        sum: '\\sum_{n=#?}^{#?}{#?}', prod: '\\prod_{n=#?}^{#?}{#?}',
        sqrt: '\\sqrt{#?}', int: '\\int_{#?}^{#?}{#?}\\,\\mathrm{d}x',
        lim: '\\lim_{x\\to #?}{#?}', infty: '\\infty', oo: '\\infty',
        alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', theta: '\\theta', pi: '\\pi' };
    }, { once: true });
    mf.setAttribute('aria-label', token.display ? 'Editable display equation' : 'Editable inline equation');
    mf.setAttribute('placeholder', token.display ? '\\text{Equation}' : '\\square');
    mf.setValue(latex, { silenceNotifications: true });
    const rendered = document.createElement('span');
    rendered.className = 'math-preview'; rendered.tabIndex = 0;
    rendered.setAttribute('aria-label', 'Equation preview. Press Enter to edit.');
    safeMath(latex, rendered, token.display);
    const ghost = document.createElement('span');
    ghost.className = 'ghost'; ghost.setAttribute('aria-hidden', 'true');
    wrap.append(mf, rendered, ghost);
    const item = { token, el: wrap, root: wrap, mf, rendered, ghost, navigationKey: null };
    view.items.set(token.id, item);
    mf.addEventListener('focus', () => setActive(item));
    mf.addEventListener('input', () => saveMath(item));
    mf.addEventListener('pointerdown', () => { ui.conversion = null; });
    mf.addEventListener('selection-change', () => { if (ui.active === item) updateGhost(); });
    mf.addEventListener('keydown', event => onMathKeydown(item, event), true);
    const edit = () => { setPreview(false); mf.focus(); mf.position = mf.lastOffset; setActive(item); };
    rendered.addEventListener('dblclick', edit);
    rendered.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); edit(); } });
    mf.addEventListener('move-out', event => {
      const direction = event.detail?.direction;
      const key = item.navigationKey, extend = !!(key?.eventPhase && key.shiftKey);
      if ((direction === 'upward' || direction === 'downward') && moveWithinMathScripts(mf, direction === 'downward', extend)) { event.preventDefault(); return; }
      if (['forward', 'backward', 'upward', 'downward'].includes(direction)
        && (direction === 'upward' || direction === 'downward' ? moveVertically(item, direction === 'downward') : moveBetweenItems(item, direction === 'forward'))) event.preventDefault();
    });
    return wrap;
  }
  function onMathKeydown(item, event) {
    const mf = item.mf;
    if (event.isComposing) return;
    // move-out carries no modifier keys. Keep the key event that caused it; its eventPhase
    // becomes NONE once dispatch ends, so later commands cannot reuse it.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') item.navigationKey = event;
    const conversion = ui.conversion;
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey && conversion?.revision === doc.revision) {
      event.preventDefault(); event.stopImmediatePropagation();
      editStructure(conversion.start, conversion.end, conversion.original, { offset: conversion.start + conversion.original.length, text: true });
      return;
    }
    ui.conversion = null;
    if (mf.mode !== 'latex' && handleBoundaryKey(item, event)) return;
    if (event.key === 'Tab' && !event.shiftKey && solver.suggestion && atEnd(mf)) {
      if (acceptSuggestion()) { event.preventDefault(); event.stopImmediatePropagation(); }
    } else if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && mf.mode !== 'latex') {
      event.preventDefault(); event.stopImmediatePropagation();
      const text = createTextNeighbor(item, true);
      focusEdge(text);
      insertProseBreak(text);
    } else if (event.key === 'Escape') clearSuggestion();
  }

  // ---------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------

  /** The caret as a source position that survives rendering, optionally across a source change. */
  function focusState(nextSource = doc.source) {
    const item = ui.active;
    if (!item) return null;
    const token = item.token;
    let offset = token.contentStart, text = !item.mf;
    if (!item.mf) { const caret = caretIndex(item); offset = caret === null ? token.contentStart : sourceOffsetAt(item, caret); }
    if (nextSource !== doc.source) {
      const source = doc.source;
      let start = 0, suffix = 0;
      while (start < source.length && start < nextSource.length && source[start] === nextSource[start]) start++;
      while (suffix < source.length - start && suffix < nextSource.length - start && source[source.length - 1 - suffix] === nextSource[nextSource.length - 1 - suffix]) suffix++;
      const end = source.length - suffix, newEnd = nextSource.length - suffix;
      if (item.mf && start <= token.start && end >= token.end) { offset = newEnd; text = true; }
      else if (offset >= end) offset += newEnd - end;
      else if (offset >= start) offset = newEnd;
      // Redo can turn prose back into a field. Focus that field at the same edit site.
      const created = T.scanDocument(nextSource).tokens.find(x => x.kind === 'math' && x.start >= start && x.end <= newEnd && x.end === offset);
      if (created) { offset = created.contentStart; text = false; }
    }
    return { offset, text, mathPosition: item.mf?.position ?? null };
  }
  /** Whitespace text with no visible effect: list and algorithm indentation, and line breaks
   *  just before a block. It is not given an editor, so the caret never lands in it. */
  function invisibleWhitespace(tokens) {
    const hidden = new Set(), open = [];
    tokens.forEach((token, index) => {
      if (CONTAINERS[token.kind]) open.push({ token, items: 0 });
      else if (CLOSERS.has(token.kind)) open.pop();
      else if (token.kind === 'listItem' && open.length) open.at(-1).items++;
      if (token.kind !== 'text') return;
      const text = doc.source.slice(token.start, token.end);
      if (!text || text.trim()) return;
      const parent = open.at(-1), next = tokens[index + 1];
      if ((parent?.token.kind === 'listStart' && !parent.items)
        || (parent?.token.kind === 'blockStart' && ['algorithm', 'algorithmic'].includes(parent.token.environment))
        || (text.includes('\n') && (!next || BLOCK_FOLLOWERS.has(next.kind) || (next.kind === 'math' && next.display)))) hidden.add(token);
    });
    return hidden;
  }
  /** Build the page from doc.tokens. Returns the scanner's warnings. */
  function buildPage(focus) {
    const scan = T.scanDocument(doc.source);
    doc.tokens = scan.tokens; doc.body = scan.body; doc.macros = T.readMacroDefinitions(doc.source);
    const hidden = invisibleWhitespace(doc.tokens);
    // Keep a prose insertion point where the caret should go but no text is, e.g. after
    // deleting the only equation. It is zero-width, so typing there is an ordinary patch.
    if (focus?.text && !doc.tokens.some(t => TEXT_KINDS.has(t.kind) && !hidden.has(t) && t.contentStart <= focus.offset && t.contentEnd >= focus.offset)) {
      const slot = { id: 'caret-slot', kind: 'text', start: focus.offset, end: focus.offset, contentStart: focus.offset, contentEnd: focus.offset };
      const index = doc.tokens.findIndex(t => t.start >= focus.offset);
      doc.tokens.splice(index < 0 ? doc.tokens.length : index, 0, slot);
    }
    const fragment = document.createDocumentFragment();
    const containers = [];
    let container = fragment;
    const enter = (context, element) => { containers.push({ parent: container, ...context }); container = element; };
    const leave = () => { const context = containers.pop(); container = context?.parent || fragment; return context; };
    const generated = (text, className) => {
      const el = document.createElement('span');
      el.className = className; el.textContent = text; el.contentEditable = 'false';
      return el;
    };
    for (const token of doc.tokens) {
      switch (token.kind) {
        case 'tableStart': {
          const wrap = document.createElement('div'); wrap.className = 'table-scroll';
          const table = document.createElement('table'); table.className = 'document-table'; table.setAttribute('aria-label', 'Editable table');
          const tbody = document.createElement('tbody');
          table.append(tbody); wrap.append(table); container.append(wrap);
          enter({ kind: 'table', rules: token.rules || [], region: addRegion(wrap, token, 'table') }, tbody);
          continue;
        }
        case 'tableRowStart': {
          const row = document.createElement('tr'); container.append(row);
          enter({ kind: 'row', rulesAbove: token.rulesAbove || 0, region: addRegion(row, token, 'row') }, row);
          continue;
        }
        case 'tableCellStart': {
          const cell = document.createElement('td');
          cell.style.textAlign = { l: 'left', c: 'center', r: 'right' }[token.alignment];
          // Draw the source's | and \hline rules; other cell edges are faint editing guides.
          const rules = containers.findLast(c => c.kind === 'table')?.rules || [], column = container.children.length;
          if (column === 0) addRule(cell, 'left', rules[0]);
          addRule(cell, 'right', rules[column + 1]);
          addRule(cell, 'top', containers.at(-1)?.rulesAbove);
          container.append(cell);
          enter({ kind: 'cell', region: addRegion(cell, token, 'cell') }, cell);
          continue;
        }
        case 'tableEnd':
          if (token.rulesBelow) for (const cell of container.lastElementChild?.children || []) addRule(cell, 'bottom', token.rulesBelow);
          closeRegion(leave()?.region, token);
          continue;
        case 'tableCellEnd': case 'tableRowEnd': case 'formatEnd':
          closeRegion(leave()?.region, token);
          continue;
        case 'blockStart': {
          const block = document.createElement('div'); block.className = 'document-' + token.environment;
          let content = block;
          if (token.environment === 'algorithm-caption') block.append(generated(token.label + '  ', 'algorithm-label'));
          if (token.environment === 'algorithm-line') {
            block.style.setProperty('--algorithm-indent', String(token.indent));
            const number = generated(token.lineNumber === null ? '' : token.lineNumber + ':', 'algorithm-line-number');
            number.setAttribute('aria-hidden', 'true'); block.append(number);
            content = document.createElement('span'); content.className = 'algorithm-line-content'; block.append(content);
            if (token.prefix) content.append(generated(token.prefix + ' ', 'algorithm-keyword'));
          }
          container.append(block);
          enter({ kind: 'block', suffix: token.suffix, region: addRegion(block, token, 'block') }, content);
          continue;
        }
        case 'blockEnd': {
          if (containers.at(-1)?.suffix) container.append(generated(' ' + containers.at(-1).suffix, 'algorithm-keyword'));
          closeRegion(leave()?.region, token);
          continue;
        }
        case 'linebreak': case 'pagebreak': case 'spacing': {
          const el = document.createElement('div');
          el.className = { linebreak: 'document-linebreak', pagebreak: 'document-pagebreak', spacing: 'document-vspace' }[token.kind];
          if (token.kind === 'linebreak') el.style.height = token.spacing;
          if (token.kind === 'spacing') { if (parseFloat(token.spacing) < 0) el.style.marginBottom = token.spacing; else el.style.height = token.spacing; }
          el.setAttribute('aria-hidden', 'true'); container.append(el);
          continue;
        }
        case 'listStart': {
          const list = document.createElement(token.environment === 'enumerate' ? 'ol' : 'ul');
          list.className = 'document-list';
          if (token.environment === 'description') list.classList.add('description-list');
          const start = /\bstart\s*=\s*(\d+)/.exec(token.options);
          if (start) list.start = Number(start[1]);
          container.append(list);
          enter({ kind: 'list', list, token, region: addRegion(list, token, 'list'), index: (start ? Number(start[1]) : 1) - 1 }, list);
          continue;
        }
        case 'listItem': {
          // An item marker belongs to the list directly around it (not, e.g., inside an open \bf).
          const context = containers.at(-1);
          if (context?.kind !== 'list') continue;
          closeRegion(context.itemRegion, token, true);
          const li = document.createElement('li'); context.list.append(li); context.index++;
          context.itemRegion = addRegion(li, token, 'listItem');
          let label = token.label, bold = context.token.environment === 'description';
          if (label === null && context.token.environment === 'enumerate') {
            const custom = T.listMarker(context.token.options, context.index);
            if (custom) { label = custom.text; bold = custom.bold; }
          }
          if (label !== null) {
            const marker = document.createElement(bold ? 'strong' : 'span');
            marker.className = 'list-label'; marker.textContent = T.decodeText(label); marker.contentEditable = 'false';
            li.classList.add('custom-label'); li.append(marker);
          }
          container = li;
          continue;
        }
        case 'listEnd': {
          const context = leave();
          closeRegion(context?.itemRegion, token, true); closeRegion(context?.region, token);
          continue;
        }
        case 'formatStart': {
          const tag = { textbf: 'strong', textit: 'em', emph: 'em', texttt: 'code', textrm: 'span', textsf: 'span', underline: 'u', textsuperscript: 'sup', textsubscript: 'sub' }[token.format] || 'span';
          const element = document.createElement(tag); element.className = 'format-' + token.format;
          container.append(element);
          enter({ kind: 'format', region: addRegion(element, token, 'format') }, element);
          continue;
        }
        case 'comment': case 'metadata':
          continue;
        case 'literal':
          container.append(generated(token.text, 'document-literal'));
          continue;
        case 'text':
          if (hidden.has(token)) continue;
          container.append(makeText(token));
          continue;
        case 'math':
          container.append(makeMath(token));
          continue;
        default:
          container.append(makeText(token, token.kind === 'raw'));
      }
    }
    // A container with nothing to type into gets an empty prose item (an empty list item, cell…).
    for (const region of [...view.regions].reverse()) {
      if (region.first.environment === 'algorithm-line' && !region.first.editableContent) continue;
      if (region.kind === 'table' || region.kind === 'row' || [...view.items.values()].some(i => region.el.contains(i.el))) continue;
      const offset = region.first.end;
      const slot = { id: `caret-${++view.slotID}`, kind: 'text', start: offset, end: offset, contentStart: offset, contentEnd: offset };
      doc.tokens.splice(doc.tokens.indexOf(region.first) + 1, 0, slot);
      const content = region.el.querySelector(':scope > .algorithm-line-content');
      if (content && region.first.suffix) content.insertBefore(makeText(slot), content.lastChild);
      else (content || region.el).append(makeText(slot));
    }
    if (!doc.tokens.some(t => t.kind === 'math' || (t.kind !== 'comment' && doc.source.slice(t.start, t.end).trim()))) {
      const hint = document.createElement('p');
      hint.className = 'empty-instruction';
      hint.textContent = 'Press ⌘↩ to start an equation, or add a text paragraph from the left sidebar.';
      fragment.append(hint);
    }
    page.replaceChildren(fragment);
    return scan.warnings;
  }
  function addRule(cell, side, count) {
    if (count) cell.classList.add(`rule-${side}`, ...(count > 1 ? [`rule-${side}-double`] : []));
  }
  /** Fallback when the page cannot be laid out: the whole body as one editable source fragment. */
  function renderAsSource() {
    view.items.clear(); view.regions = [];
    try { doc.body = T.bodyRange(doc.source); } catch { doc.body = { start: 0, end: doc.source.length, wrapped: false }; }
    doc.tokens = [{ id: 't0', kind: 'raw', start: doc.body.start, end: doc.body.end, contentStart: doc.body.start, contentEnd: doc.body.end }];
    page.replaceChildren(makeText(doc.tokens[0], true));
  }
  /**
   * Rebuild the page from the source. `focus` says where the caret goes afterwards:
   *  undefined  keep it where it is (by source position);
   *  null       nowhere;
   *  { offset,  a source offset;
   *    text,      prefer (or create) a prose item there rather than an equation;
   *    affinity,  'before' or 'after': at a boundary between two items, the one ending or starting there;
   *    select,    a number of characters to select from the caret;
   *    mathPosition, placeholder }  where the caret goes in an equation.
   */
  function render(focus = focusState()) {
    documentSelection.clear();
    clearTimeout(ui.autoMathTimer); ui.conversion = null;
    const scroll = { left: window.scrollX, top: window.scrollY, behavior: 'instant' };
    // MathLive's new fields lay out on animation frames. Keep the old page height
    // until then so the browser cannot clamp a viewport near the document bottom.
    cancelAnimationFrame(view.layoutFrame);
    page.style.minHeight = page.getBoundingClientRect().height + 'px';
    view.rendering = true;
    // Blur while the field is still mounted so MathLive can release its shared input.
    if (page.contains(document.activeElement)) document.activeElement.blur();
    clearSuggestion();
    view.items.clear(); view.regions = []; ui.active = null;
    let warnings;
    try { warnings = buildPage(focus); }
    catch (error) {
      // Never leave a half-built page: show the body as editable source instead.
      warnings = ['The page could not be laid out, so it is shown as source. ' + error.message];
      renderAsSource();
    } finally { view.rendering = false; }
    post('documentInfo', { equations: doc.tokens.filter(t => t.kind === 'math').length, rawBlocks: doc.tokens.filter(t => t.kind === 'raw').length, warnings });
    if (focus) placeFocus(focus);
    // Replacing mounted fields temporarily changes page height. Restore after
    // rebuilding and selecting the caret, regardless of which editor gets focus.
    window.scrollTo(scroll);
    view.layoutFrame = requestAnimationFrame(() => {
      view.layoutFrame = requestAnimationFrame(() => { page.style.minHeight = ''; view.layoutFrame = null; });
    });
  }
  function placeFocus({ offset, text = false, affinity = 'after', select = 0, mathPosition = null, placeholder = false }) {
    if (offset === undefined || offset === null) return;
    const items = editableItems();
    const prose = text ? items.filter(x => !x.mf && x.token.contentStart <= offset && x.token.contentEnd >= offset) : [];
    const item = (affinity === 'before' ? prose.find(x => x.token.contentStart < offset) : prose.find(x => x.token.contentEnd > offset)) || prose[0]
      || items.find(x => x.token.start <= offset && x.token.end > offset)
      || items.find(x => x.token.start >= offset)
      || items.at(-1);
    if (!item) return;
    if (!item.mf) {
      item.el.focus({ preventScroll: true });
      setCaret(item, indexAtSource(item, offset), select);
      return;
    }
    const revision = doc.revision;
    const focusField = () => {
      if (!item.el.isConnected || doc.revision !== revision || (ui.active && ui.active !== item)) return;
      const viewport = { left: window.scrollX, top: window.scrollY, behavior: 'instant' };
      item.mf.focus({ preventScroll: true });
      item.mf.position = mathPosition !== null ? Math.min(mathPosition, item.mf.lastOffset) : item.mf.lastOffset;
      if (placeholder) { item.mf.position = 0; item.mf.executeCommand('moveToNextPlaceholder'); }
      // Placeholder commands can scroll too. A later mount must preserve the
      // current viewport, including any scrolling since this render.
      window.scrollTo(viewport);
    };
    // New MathLive fields mount asynchronously; focus and placeholder commands need that mount.
    item.mf.addEventListener('mount', focusField, { once: true });
    focusField();
  }

  // ---------------------------------------------------------------------------------------
  // Selection across items, and clicks between them
  // ---------------------------------------------------------------------------------------

  const documentSelection = window.DocumentSelection.create({
    page, items: editableItems, source: () => doc.source,
    onSelect: () => { clearTimeout(ui.autoMathTimer); clearSuggestion(); ui.conversion = null; },
    onReplace: replaceSelection,
    selectAllInEditor,
  });
  /** Select All first selects the focused editor's own text. False when that is already selected
   *  (or empty), so that pressing it again selects the document. */
  function selectAllInEditor() {
    const item = ui.active;
    if (!item || !item.el.contains(document.activeElement)) return false;
    if (item.mf) {
      const [range] = item.mf.selection?.ranges ?? [];
      if (!item.mf.value || (range?.[0] === 0 && range?.[1] === item.mf.lastOffset)) return false;
      item.mf.executeCommand('selectAll');
      return true;
    }
    const selection = window.getSelection(), length = itemText(item).length;
    if (!length || !selection?.rangeCount) return false;
    const from = textIndex(item, selection.anchorNode, selection.anchorOffset), to = textIndex(item, selection.focusNode, selection.focusOffset);
    if (from !== null && to !== null && Math.min(from, to) === 0 && Math.max(from, to) === length) return false;
    setCaret(item, 0, length);
    return true;
  }
  page.addEventListener('click', event => {
    // Native hit testing in the blank part of a math-ending row can choose the
    // leading newline's broken caret. Share the keyboard's source-free slot.
    // Leave equation clicks, text selection and modified/multiple clicks native.
    if (ui.preview || event.button !== 0 || event.detail !== 1 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey
      || !window.getSelection()?.isCollapsed || page.classList.contains('has-document-selection')) return;
    const all = editableItems(), target = all.find(item => item.el.contains(event.target));
    if (target?.mf) return;
    for (let i = all.length - 1; i >= 0; i--) {
      const item = all[i];
      if (!item.mf || item.token.display) continue;
      const rect = item.mf.getBoundingClientRect();
      if (event.clientX < rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
      const next = all[i + 1], slot = next && !next.mf && !itemText(next) ? next : null;
      const after = slot ? all[i + 2] : next;
      if (!after || after.mf || !itemText(after).startsWith('\n')) continue;
      if (target && target !== slot && target !== after) continue;
      // Do not cross table cells or other separately laid-out containers.
      const region = item.el.closest('li,td,.document-algorithm-line') || page;
      if (!region.contains(event.target) || event.clientX > region.getBoundingClientRect().right) continue;
      documentSelection.clear();
      focusEdge(slot || createTextNeighbor(item, true));
      return;
    }
    // A click in the page's padding or the gaps between blocks focuses the
    // page itself, which cannot be typed into. Put the caret on the nearest
    // line instead, at the clicked column, as a single text box would.
    if (all.some(item => item.el.contains(document.activeElement))) return;
    const nearest = nearestFragment(visualLine(lineRects(), { y: event.clientY }), event.clientX);
    if (nearest) { ui.verticalGoal = null; placeCaretAt(nearest.item, nearest.rect, event.clientX); }
  });

  // ---------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------

  /** The source offset of the caret in the focused prose, or null. */
  function proseCaretOffset() {
    const item = ui.active;
    if (!item || item.mf || item.token.kind !== 'text') return null;
    const caret = caretIndex(item);
    return caret === null ? null : sourceOffsetAt(item, caret);
  }
  function insertEquation(latex = '', inline = false) {
    const nl = lineEnding();
    const at = (inline ? proseCaretOffset() : null) ?? T.blockInsertionOffset(doc.tokens, ui.active?.token, doc.body.end);
    const prefix = inline ? ' \\(' : `${nl}\\[${nl}`, suffix = inline ? '\\) ' : `${nl}\\]${nl}`;
    editStructure(at, at, prefix + latex + suffix, { offset: at + prefix.length });
  }
  function insertParagraph() {
    const nl = lineEnding(), at = proseCaretOffset() ?? ui.active?.token.end ?? doc.body.end, text = 'New paragraph.';
    editStructure(at, at, `${nl}${nl}${text}${nl}${nl}`, { offset: at + 2 * nl.length, text: true, select: text.length });
  }
  function insertCommand(command) {
    if (!command || typeof command.latex !== 'string') return;
    if (command.mode === 'document' || command.mode === 'preamble') {
      const preamble = command.mode === 'preamble';
      const at = preamble ? (doc.source.charCodeAt(0) === 0xfeff ? 1 : 0) : T.blockInsertionOffset(doc.tokens, ui.active?.token, doc.body.end);
      const nl = lineEnding(), template = command.latex.replace(/\r?\n/g, nl);
      const first = T.scanDocument(template).tokens.find(t => ['code', 'heading', 'math', 'text', 'raw'].includes(t.kind) && template.slice(t.contentStart, t.contentEnd).trim());
      setPreview(false);
      editStructure(at, at, nl + template + nl, preamble ? null : { offset: at + nl.length + (first?.contentStart ?? 0) });
      if (preamble) report('Inserted in the preamble. Use Source to edit it.');
      return;
    }
    setPreview(false);
    if (!ui.active?.mf) insertEquation();
    if (!ui.active?.mf) return;
    ui.active.mf.focus();
    ui.active.mf.insert(command.latex, { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' });
    // Some programmatic insertions do not dispatch input in every MathLive release.
    saveMath(ui.active);
  }
  function setPreview(value) {
    ui.preview = !!value;
    page.classList.toggle('preview', ui.preview);
    clearSuggestion();
    post('preview', { enabled: ui.preview });
  }
  function handleShortcut(event) {
    if (event.isComposing) return;
    const k = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && k === 'z') {
      event.preventDefault(); event.stopImmediatePropagation();
      post('request', { action: event.shiftKey ? 'redo' : 'undo' });
      return;
    }
    if (event.metaKey && !event.altKey && k === 'k') { event.preventDefault(); post('request', { action: 'palette' }); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); insertEquation('', event.shiftKey); return; }
    const bits = [];
    if (event.metaKey) bits.push('cmd');
    if (event.ctrlKey) bits.push('ctrl');
    if (event.altKey) bits.push('alt');
    if (event.shiftKey) bits.push('shift');
    // Physical key code avoids Option-modified characters such as ∑ and ƒ.
    bits.push(event.code?.startsWith('Key') ? event.code.slice(3).toLowerCase() : k);
    const command = commands.find(c => c.shortcut === bits.join('+'));
    if (command) { event.preventDefault(); event.stopImmediatePropagation(); insertCommand(command); }
  }
  document.addEventListener('keydown', handleShortcut, true);

  // ---------------------------------------------------------------------------------------
  // Local calculation
  // ---------------------------------------------------------------------------------------

  function postActive() {
    const item = ui.active;
    if (item?.mf) post('active', { latex: item.mf.value, display: item.token.display, start: item.token.contentStart, end: item.token.contentEnd });
  }
  function clearSuggestion() {
    solver.suggestion = null;
    for (const item of view.items.values()) item.ghost?.classList.remove('visible');
  }
  function resetWorker() {
    clearTimeout(solver.watchdog); solver.watchdog = null;
    solver.worker?.terminate(); solver.worker = null;
    if (solver.url) { URL.revokeObjectURL(solver.url); solver.url = null; }
  }
  function makeWorker() {
    resetWorker();
    if (!window.SOLVER_WORKER_SOURCE) return false;
    try {
      solver.url = URL.createObjectURL(new Blob([window.SOLVER_WORKER_SOURCE], { type: 'text/javascript' }));
      solver.worker = new Worker(solver.url);
      solver.worker.onmessage = event => {
        const msg = event.data, item = ui.active;
        if (msg.id !== solver.request || msg.revision !== doc.revision || !item || msg.latex !== item.mf?.value) return;
        clearTimeout(solver.watchdog); solver.watchdog = null;
        solver.suggestion = msg.result.append ? { ...msg.result, id: item.token.id, original: msg.latex, revision: doc.revision } : null;
        post('analysis', { ...msg.result, sourceRevision: doc.revision });
        updateGhost();
      };
      solver.worker.onerror = () => { resetWorker(); report('The local solver could not start. Equation editing and saving remain available.'); };
      return true;
    } catch (error) { report('Local solver unavailable: ' + error.message); return false; }
  }
  function scheduleAnalysis() {
    clearTimeout(solver.timer); clearTimeout(solver.watchdog); clearSuggestion();
    solver.request++;
    if (!ui.active?.mf) return;
    postActive();
    if (!settings.automatic) { post('analysis', { note: 'Automatic calculation is off.', latex: '', append: '', mathjson: '', javascript: '' }); return; }
    const id = solver.request, latex = ui.active.mf.value, revision = doc.revision;
    solver.timer = setTimeout(() => {
      if (!solver.worker && !makeWorker()) return;
      solver.worker.postMessage({ id, latex, revision, options: { angleMode: settings.angleMode } });
      solver.watchdog = setTimeout(() => {
        if (id !== solver.request) return;
        resetWorker(); clearSuggestion();
        post('analysis', { latex: '', append: '', mathjson: '', javascript: '', note: 'Calculation exceeded its time limit. Editing remains responsive.' });
      }, 650);
    }, 180);
  }
  const atEnd = mf => !!mf && mf.selectionIsCollapsed && mf.position === mf.lastOffset;
  function updateGhost() {
    for (const item of view.items.values()) item.ghost?.classList.remove('visible');
    const item = ui.active, suggestion = solver.suggestion;
    if (!suggestion || !item || ui.preview || suggestion.id !== item.token.id || !atEnd(item.mf)) return;
    const math = document.createElement('span');
    safeMath(suggestion.append, math, false);
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'tab';
    item.ghost.replaceChildren(math, hint); item.ghost.classList.add('visible');
  }
  function acceptSuggestion() {
    const item = ui.active, chosen = solver.suggestion;
    if (!chosen || !item?.mf || chosen.id !== item.token.id || chosen.revision !== doc.revision || item.mf.value !== chosen.original) return false;
    const mf = item.mf;
    if (/\\placeholder\b/.test(mf.value)) return false;
    clearSuggestion();
    if (chosen.replaceTrailingEquals) {
      mf.setValue(mf.value.replace(/=\s*$/, '') + chosen.append, { silenceNotifications: true });
      mf.position = mf.lastOffset;
    } else {
      mf.focus(); mf.position = mf.lastOffset;
      mf.insert(chosen.append, { insertionMode: 'insertAfter', selectionMode: 'after', format: 'latex' });
    }
    saveMath(item);
    announce('Result inserted. ' + chosen.note);
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Host interface
  // ---------------------------------------------------------------------------------------

  window.GlassTeX = {
    setDocument(payload) {
      if (typeof payload.source !== 'string' || !Number.isInteger(payload.revision)) return;
      if (!payload.force && doc.source === payload.source && doc.revision === payload.revision) return;
      const focus = payload.initial ? null : focusState(payload.source);
      doc.source = payload.source; doc.revision = payload.revision;
      render(focus);
      if (payload.initial) {
        const first = editableItems().find(i => i.mf && !i.mf.value.trim());
        if (first) { first.mf.focus(); first.mf.position = 0; }
      }
    },
    receive(message) {
      switch (message.action) {
        case 'insertCommand': insertCommand(message.command); break;
        case 'insertEquation': insertEquation('', !!message.inline); break;
        case 'insertParagraph': insertParagraph(); break;
        case 'accept': acceptSuggestion(); break;
        case 'preview': setPreview(message.enabled); break;
        case 'settings': applySettings(message.settings); break;
        case 'commands': commands = message.commands || commands; break;
        case 'focus': ui.active?.mf?.focus(); break;
        case 'selectAll': documentSelection.selectAll(); break;
        case 'sourceChanged': render(); break;
      }
    },
    snapshot: () => ({ source: doc.source, revision: doc.revision, tokens: doc.tokens.map(t => ({ ...t })), active: ui.active?.token.id || null, suggestion: solver.suggestion }),
  };
  function applySettings(next) {
    clearTimeout(ui.autoMathTimer);
    settings = { ...settings, ...next };
    const root = document.documentElement;
    root.dataset.appearance = ['light', 'dark'].includes(settings.appearance) ? settings.appearance : 'system';
    root.dataset.spacing = ['comfortable', 'spacious', 'custom'].includes(settings.documentSpacing) ? settings.documentSpacing : 'compact';
    for (const [key, property, min, max, fallback, unit] of [
      ['customLineSpacing', '--custom-line-spacing', 1.1, 2.2, 1.25, ''],
      ['customBlockSpacing', '--custom-block-spacing', 0, 2, .6, 'em'],
      ['customEquationSpacing', '--custom-equation-spacing', 0, 2, .4, 'em'],
      ['customListSpacing', '--custom-list-spacing', 0, 1.5, .35, 'em'],
    ]) {
      const value = Number.isFinite(settings[key]) ? Math.min(max, Math.max(min, settings[key])) : fallback;
      root.style.setProperty(property, value + unit);
    }
    root.style.setProperty('--math-size', (Number.isFinite(settings.fontSize) ? Math.max(14, Math.min(40, settings.fontSize)) : 22) + 'px');
    scheduleAnalysis();
  }

  if (!T || !window.MathfieldElement) {
    fatal('MathLive assets are missing. Run Build & Run.command to fetch the pinned editor dependencies, then build the app. Your .tex files have not been changed.');
    return;
  }
  window.MathfieldElement.fontsDirectory = new URL('vendor/mathlive/fonts/', window.location.href).href;
  window.MathfieldElement.soundsDirectory = null;
  // Do not let MathLive fetch a remote compute engine; the app has its own local worker.
  window.MathfieldElement.computeEngine = null;
  window.MathfieldElement.restoreFocusWhenDocumentFocused = false;
  post('ready');
  if (!native) {
    const starter = '\\documentclass[11pt]{article}\n\\usepackage{amsmath,amssymb}\n\\begin{document}\n\\section{A little room to think}\nA continuous page. Click an equation to edit it.\n\\[\n\\frac{1}{3}+\\frac{1}{6}\n\\]\n\\[\nx^2-5x+6=0\n\\]\n\\[\n\\sum_{n=1}^{10}n\n\\]\n\\[\n\n\\]\n\\end{document}\n';
    window.GlassTeX.setDocument({ source: starter, revision: 0, initial: true });
  }
})();
