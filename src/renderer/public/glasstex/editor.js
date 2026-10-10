/* Browser editing surface. Native shell owns document IO, undo, search and glass. */
(() => {
  'use strict';
  const T = window.TeX;
  const page = document.getElementById('page');
  const native = !!window.webkit?.messageHandlers?.editor;
  let source = '', revision = 0, tokens = [], regions = [], body = {start:0,end:0}, active = null;
  let macros = {}, preview = false, commands = window.COMMANDS || [];
  let settings = { angleMode:'radians', automatic:true, autoEquations:true, fontSize:22, appearance:'system', documentSpacing:'compact' };
  let autoMathTimer = null, lastConversion = null, caretSlotID = 0;
  let worker = null, workerURL = null, calculationTimer = null, watchdog = null, requestID = 0;
  let suggestion = null, suppress = false;
  let layoutFrame = null;
  const byID = new Map();
  const post = (type, payload = {}) => {
    if (native) window.webkit.messageHandlers.editor.postMessage({type,...payload});
    else window.dispatchEvent(new CustomEvent('glasstex-message',{detail:{type,...payload}}));
  };
  const report = message => post('notice',{message});
  const fatal = message => { const el=document.getElementById('fatal');el.hidden=false;el.textContent=message;post('error',{message}); };
  function clearSuggestion() {
    suggestion = null;
    for(const item of byID.values())if(item.ghost)item.ghost.classList.remove('visible');
  }
  function resetWorker() {
    clearTimeout(watchdog);watchdog=null;
    worker?.terminate();worker=null;
    if(workerURL){URL.revokeObjectURL(workerURL);workerURL=null;}
  }
  function makeWorker() {
    resetWorker();
    if(!window.SOLVER_WORKER_SOURCE)return false;
    try {
      workerURL=URL.createObjectURL(new Blob([window.SOLVER_WORKER_SOURCE],{type:'text/javascript'}));
      worker=new Worker(workerURL);
      worker.onmessage=event=> {
        const msg=event.data;
        if(msg.id!==requestID || msg.revision!==revision || !active || msg.latex!==active.mf?.value)return;
        clearTimeout(watchdog);watchdog=null;
        const result=msg.result;
        suggestion=result.append?{...result,id:active.token.id,original:msg.latex,revision}:null;
        post('analysis',{...result,sourceRevision:revision});
        updateGhost();
      };
      worker.onerror=()=>{resetWorker();report('The local solver could not start. Equation editing and saving remain available.');};
      return true;
    } catch(error){report('Local solver unavailable: '+error.message);return false;}
  }
  function scheduleAnalysis() {
    clearTimeout(calculationTimer);clearTimeout(watchdog);clearSuggestion();
    requestID++;
    if(!active?.mf)return;
    postActive();
    if(!settings.automatic){post('analysis',{note:'Automatic calculation is off.',latex:'',append:'',mathjson:'',javascript:''});return;}
    const id=requestID, latex=active.mf.value, sourceRevision=revision;
    calculationTimer=setTimeout(()=>{
      if(!worker&&!makeWorker())return;
      worker.postMessage({id,latex,revision:sourceRevision,options:{angleMode:settings.angleMode}});
      watchdog=setTimeout(()=>{
        if(id!==requestID)return;
        resetWorker();clearSuggestion();
        post('analysis',{latex:'',append:'',mathjson:'',javascript:'',note:'Calculation exceeded its time limit. Editing remains responsive.'});
      },650);
    },180);
  }
  function atEnd(mf) {
    return !!mf && mf.selectionIsCollapsed && mf.position===mf.lastOffset;
  }
  function updateGhost() {
    for(const item of byID.values())if(item.ghost)item.ghost.classList.remove('visible');
    if(!suggestion || !active || preview || suggestion.id!==active.token.id || !atEnd(active.mf))return;
    const ghost=active.ghost;
    ghost.replaceChildren();
    const math=document.createElement('span');
    safeMath(suggestion.append,math,false);
    const hint=document.createElement('span');hint.className='hint';hint.textContent='tab';
    ghost.append(math,hint);ghost.classList.add('visible');
  }
  function safeMath(latex,element,displayMode) {
    try {
      if(!window.katex)throw new Error('KaTeX assets are missing.');
      window.katex.render(latex,element,{displayMode,throwOnError:false,trust:false,strict:'warn',maxExpand:200,maxSize:20,macros:{...macros},output:'htmlAndMathml'});
    } catch(error) {element.textContent=latex;}
  }
  function postActive() {
    if(!active?.mf)return;
    post('active',{latex:active.mf.value,display:active.token.display,
      start:active.token.contentStart,end:active.token.contentEnd});
  }
  let recovery=null;
  function mutate(start,end,replacement,token=null) {
    let patch;
    try { patch=T.sourcePatch(source,start,end,replacement,revision); }
    catch {
      // Stale offsets must never edit the wrong text. Drop the edit and rebuild from source.
      if(!recovery)recovery=setTimeout(()=>{recovery=null;render();report('The page was out of date and has been refreshed. That last edit was not applied.');},0);
      return false;
    }
    if(patch.expected===replacement)return false;
    source=T.applyPatch(source,patch,revision);revision++;
    const delta=replacement.length-(end-start);
    if(token) {
      token.contentEnd+=delta;token.end+=delta;
      // Zero-length tokens at the edit end shift only when they follow the edited token.
      const index=tokens.indexOf(token);
      tokens.forEach((t,i)=>{
        if(t===token||t.start<end||(t.start===end&&i<index))return;
        t.start+=delta;t.end+=delta;t.contentStart+=delta;t.contentEnd+=delta;
      });
      body.end+=delta;
    }
    post('patch',{patch});
    return true;
  }
  function preserveEdgeWhitespace(old, replacement) {
    const leading=old.match(/^\s*/)?.[0]||'', trailing=old.match(/\s*$/)?.[0]||'';
    if(!old.trim())return (old.includes('\r\n')?'\r\n':old.includes('\n')?'\n':'')+replacement+(old.includes('\r\n')?'\r\n':old.includes('\n')?'\n':'');
    return leading+replacement+trailing;
  }
  function saveMath(item) {
    if(suppress)return;
    lastConversion=null;
    const t=item.token,old=source.slice(t.contentStart,t.contentEnd);
    const value=T.mathFromField(t,item.mf.value);
    mutate(t.contentStart,t.contentEnd,preserveEdgeWhitespace(old,value),t);
    safeMath(item.mf.value,item.rendered,t.display);
    item.el.classList.toggle('empty',!item.mf.value);
    scheduleAnalysis();
  }
  function setActive(item) {
    clearTimeout(autoMathTimer);
    if(active&&active!==item)lastConversion=null;
    active=item;
    if(item.mf){postActive();scheduleAnalysis();}
    else {clearSuggestion();post('active',{latex:'',display:false,start:item.token.contentStart,end:item.token.contentEnd});}
  }
  function editableItems() {return tokens.map(t=>byID.get(t.id)).filter(Boolean);}
  function neighboringItem(item,forward) {
    const items=editableItems(),index=items.indexOf(item);
    return index<0?null:items[index+(forward?1:-1)];
  }
  function itemText(item) {return item.mf?item.mf.value:item.el.innerText.replace(/\u00a0/g,' ');}
  function atBoundary(item,forward) {
    if(item.mf)return item.mf.selectionIsCollapsed&&item.mf.position===(forward?item.mf.lastOffset:0);
    const caret=textCaret(item);
    return caret!==null&&caret===(forward?itemText(item).length:0);
  }
  function focusEdge(item,end=false) {
    setActive(item);
    if(item.mf) {
      item.mf.focus();item.mf.position=end?item.mf.lastOffset:0;
    } else {
      item.el.focus();
      const range=document.createRange();
      let node=item.el;
      while(end?node.lastChild:node.firstChild)node=end?node.lastChild:node.firstChild;
      // Use text offsets when available so navigation and typing share a leaf position.
      if(node.nodeType===Node.TEXT_NODE){range.setStart(node,end?node.length:0);range.collapse(true);}
      else {range.selectNodeContents(item.el);range.collapse(!end);}
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    }
  }
  function regionRange(region) {
    return {start:region.first.start,end:region.before?region.last.start:region.last.end};
  }
  function addRegion(el,first,kind) {
    const region={el,first,last:first,kind,before:false};regions.push(region);return region;
  }
  function closeRegion(region,last,before=false) {if(region){region.last=last;region.before=before;}}
  function createTextNeighbor(item,forward,containerRegion=null) {
    let root=item.root||item.el;
    let offset=forward?item.token.end:item.token.start;
    // Inline math exits into its surrounding prose. Exiting a whole text container
    // (a cell, list, quote, or formatting group) places prose outside that container.
    if(containerRegion||(!item.mf&&item.token.kind==='text')) {
      const enclosing=regions.filter(r=>r.el.contains(root));
      const outer=containerRegion||enclosing[0];
      if(!outer)return null; // Ordinary prose already has a usable terminal caret.
      root=outer.el;const range=regionRange(outer);offset=forward?range.end:range.start;
    }
    const slot={id:`caret-${++caretSlotID}`,kind:'text',start:offset,end:offset,contentStart:offset,contentEnd:offset};
    // Zero-width closing markers belong before a trailing insertion point.
    let index=forward?tokens.findLastIndex(t=>t.end<=offset)+1:tokens.findIndex(t=>t.start>=offset);
    if(index<0)index=tokens.length;
    tokens.splice(index,0,slot);
    const el=makeText(slot);
    if(forward)root.after(el);else root.before(el);
    return byID.get(slot.id);
  }
  function moveBetweenItems(item,forward) {
    let next=neighboringItem(item,forward);
    // A leading newline has a DOM range after the equation, but WebKit paints
    // its native caret at the preceding line's start. Reuse the empty editing
    // slot used at document ends, without adding any characters to the source.
    if(forward&&item.mf&&next&&!next.mf&&itemText(next).startsWith('\n'))
      next=createTextNeighbor(item,true);
    else {
      while(next&&!next.mf&&/^\s*\n\s*$/.test(itemText(next))) {
        const following=neighboringItem(next,forward);
        if(!following)return true;
        next=following;
      }
      if(forward&&next&&!next.mf&&itemText(next).startsWith('\n')) {
        focusEdge(next);
        // Crossing the paragraph boundary enters its first visible character.
        const selection=window.getSelection();
        if(selection.anchorNode?.nodeType===Node.TEXT_NODE)selection.collapse(selection.anchorNode,1);
        return true;
      }
    }
    next ||= createTextNeighbor(item,forward);
    if(!next)return false;
    focusEdge(next,!forward);return true;
  }
  function emptyRemovalRange(item,origin=item) {
    if(itemText(item)!=='')return null;
    if(['math','heading','code','raw'].includes(item.token.kind))return item.token.start<item.token.end?{start:item.token.start,end:item.token.end}:null;
    // Cells remain cells: remove empty content, never their & or row delimiters.
    const cell=item.el.closest('td');
    const table=cell?.closest('table');
    if(table&&!table.contains(origin.el)) {
      const region=regions.find(r=>r.kind==='table'&&r.el.contains(table));
      if(region&&editableItems().filter(i=>table.contains(i.el)).every(i=>!itemText(i).trim())) {
        const range=regionRange(region);
        if(!tokens.some(t=>t.kind==='comment'&&t.start>=range.start&&t.end<=range.end))return range;
      }
    }
    for(const region of regions.filter(r=>r.kind!=='cell'&&r.kind!=='row'&&r.kind!=='table'&&r.el.contains(item.el)&&(!cell||cell.contains(r.el)))) {
      const range=regionRange(region);
      if(editableItems().filter(i=>region.el.contains(i.el)).every(i=>!itemText(i).trim())
        &&!tokens.some(t=>t.kind==='comment'&&t.start>=range.start&&t.end<=range.end))return range;
    }
    return null;
  }
  function removeEmptyItem(item,origin=item) {
    const range=emptyRemovalRange(item,origin);
    if(!range||range.start===range.end)return false;
    mutate(range.start,range.end,'');
    render({restore:false,focusOffset:range.start,focusText:true});return true;
  }
  function deleteAcrossBoundary(item,forward,event) {
    if((event.type==='beforeinput'&&!event.cancelable)||!atBoundary(item,forward))return false;
    const consume=()=>{event.preventDefault();event.stopImmediatePropagation();lastConversion=null;};
    if(emptyRemovalRange(item)) {consume();if(removeEmptyItem(item))return true;}
    let next=neighboringItem(item,forward);
    const index=tokens.indexOf(item.token),other=next?tokens.indexOf(next.token):(forward?tokens.length:-1);
    const gap=forward?tokens.slice(index+1,other):tokens.slice(other+1,index);
    const line=forward?gap.find(t=>t.kind==='linebreak'):gap.findLast(t=>t.kind==='linebreak');
    if(line) {
      consume();mutate(line.start,line.end,'');
      render({restore:false,focusOffset:line.start,focusText:true});return true;
    }
    while(next&&itemText(next)===''&&!emptyRemovalRange(next,item))next=neighboringItem(next,forward);
    if(!next)return false;
    consume();
    if(removeEmptyItem(next,item))return true;
    focusEdge(next,!forward);
    if(next.mf) {next.mf.executeCommand(forward?'deleteForward':'deleteBackward');saveMath(next);}
    else document.execCommand(forward?'forwardDelete':'delete');
    return true;
  }
  function atVerticalBoundary(item,down) {
    if(item.mf)return false; // MathLive emits move-out after navigating its structures.
    const selection=window.getSelection();
    if(!selection?.rangeCount||!selection.isCollapsed||!item.el.contains(selection.anchorNode))return false;
    if(atBoundary(item,down))return true;
    const caret=selection.getRangeAt(0).getBoundingClientRect();
    const content=document.createRange();content.selectNodeContents(item.el);
    const lines=[...content.getClientRects()].filter(r=>r.height&&r.width);
    if(!caret.height||!lines.length)return false;
    const edge=down?Math.max(...lines.map(r=>r.bottom)):Math.min(...lines.map(r=>r.top));
    return down?caret.bottom>=edge-2:caret.top<=edge+2;
  }
  function leaveTable(item,forward) {
    const table=item.el.closest('table'),items=editableItems().filter(i=>table.contains(i.el));
    const edge=forward?items.at(-1):items[0];
    const next=neighboringItem(edge,forward)||createTextNeighbor(edge,forward,regions.find(r=>r.kind==='table'&&r.el.contains(table)));
    if(!next)return false;focusEdge(next,!forward);return true;
  }
  function moveTableCell(item,forward) {
    const cell=item.el.closest('td');if(!cell)return false;
    const table=cell.closest('table'),cells=[...table.querySelectorAll('td')];
    const next=cells[cells.indexOf(cell)+(forward?1:-1)];
    if(next) {
      const targets=editableItems().filter(i=>next.contains(i.el));
      if(!targets.length)return false;
      focusEdge(forward?targets[0]:targets.at(-1),!forward);return true;
    }
    return leaveTable(item,forward);
  }
  function moveVertically(item,down) {
    const cell=item.el.closest('td');
    if(cell) {
      const row=cell.parentElement,next=down?row.nextElementSibling:row.previousElementSibling;
      if(!next)return leaveTable(item,down);
      const column=[...row.children].indexOf(cell),target=next.children[column];
      const items=editableItems().filter(i=>target?.contains(i.el));
      if(!items.length)return false;
      focusEdge(down?items[0]:items.at(-1),!down);return true;
    }
    return moveByLine(item,down)??moveBetweenItems(item,down);
  }
  /** Each visual line fragment of every editable item, in viewport coordinates. */
  function lineRects() {
    const result=[];
    for(const item of editableItems()) {
      let rects;
      if(item.mf)rects=[item.el.getBoundingClientRect()];
      else {
        const range=document.createRange();range.selectNodeContents(item.el);
        rects=[...range.getClientRects()];
        if(!rects.length)rects=[...item.el.getClientRects()];
      }
      for(const rect of rects)if(rect.height)result.push({item,rect});
    }
    return result;
  }
  const centerY=rect=>rect.top+rect.height/2;
  /** The fragments sharing the visual line nearest y, or the line just past `from` going up/down. */
  function visualLine(fragments,{y=null,from=null,down=true}) {
    let pool=fragments;
    if(from)pool=fragments.filter(f=>down?centerY(f.rect)>from.bottom:centerY(f.rect)<from.top);
    if(!pool.length)return [];
    let anchor=pool[0];
    for(const f of pool) {
      const better=y!==null?Math.max(f.rect.top-y,0,y-f.rect.bottom)<Math.max(anchor.rect.top-y,0,y-anchor.rect.bottom)
        :down?f.rect.top<anchor.rect.top:f.rect.bottom>anchor.rect.bottom;
      if(better)anchor=f;
    }
    // Inline math is taller than text; overlap with the line's middle keeps it on the line.
    const middle=centerY(anchor.rect);
    return pool.filter(f=>f.rect.top<=middle&&f.rect.bottom>=middle);
  }
  function nearestFragment(line,x) {
    let best=null,distance=Infinity;
    for(const f of line) {
      const d=Math.max(f.rect.left-x,0,x-f.rect.right);
      if(d<distance){distance=d;best=f;}
    }
    return best;
  }
  /** Place the caret in `item` at a viewport point on the line `rect`. */
  function placeCaretAt(item,rect,x) {
    x=Math.max(rect.left+1,Math.min(rect.right-1,x));
    const y=centerY(rect);
    setActive(item);
    if(item.mf) {
      item.mf.focus();
      const offset=item.mf.getOffsetFromPoint?.(x,y,{bias:0});
      item.mf.position=Number.isInteger(offset)&&offset>=0?offset:x<(rect.left+rect.right)/2?0:item.mf.lastOffset;
      return;
    }
    item.el.focus({preventScroll:true});
    const caret=document.caretRangeFromPoint?.(x,y);
    if(!caret||!item.el.contains(caret.startContainer)){focusEdge(item,x>(rect.left+rect.right)/2);return;}
    caret.collapse(true);
    // A caret after the space at a soft wrap paints at the start of the next line.
    // Keep it on the line that was aimed at, before that space.
    const node=caret.startContainer,offset=caret.startOffset;
    if(node.nodeType===Node.TEXT_NODE&&offset>0&&offset<node.length&&/[ \t]/.test(node.data[offset-1])) {
      const following=document.createRange();following.setStart(node,offset);following.setEnd(node,offset+1);
      const next=following.getClientRects()[0];
      if(next&&next.top>rect.bottom-1)caret.setStart(node,offset-1);
    }
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(caret);
  }
  // Consecutive Up/Down presses aim at the column where the run of presses began.
  let verticalGoal=null;
  function caretKey(item) {
    if(item.mf)return `${item.token.id}:${item.mf.position}`;
    const s=window.getSelection();
    return s?.rangeCount?`${item.token.id}:${textCaret(item)}`:null;
  }
  /**
   * Move to the visual line above or below, the way a single text box does,
   * even when that line belongs to a different text run or equation.
   * Returns false to leave a move within the same text run to the browser,
   * and null when there is no line in that direction.
   */
  function moveByLine(item,down) {
    let caret;
    if(item.mf) {
      const bounds=item.mf.getElementInfo?.(item.mf.position)?.bounds,wrap=item.el.getBoundingClientRect();
      caret={left:Number.isFinite(bounds?.right)?bounds.right:wrap.left,top:wrap.top,bottom:wrap.bottom};
    } else {
      const selection=window.getSelection();
      if(!selection?.rangeCount)return null;
      const range=selection.getRangeAt(0),rects=[...range.getClientRects()];
      // A collapsed range at a soft wrap has a rect on both lines; it paints on the later one.
      caret=rects.at(-1)||range.getBoundingClientRect();
      if(!caret.height) {
        const el=item.el.getBoundingClientRect();
        caret={left:el.left,top:el.top,bottom:el.bottom};
      }
    }
    const key=caretKey(item);
    const x=verticalGoal&&verticalGoal.key===key?verticalGoal.x:caret.left;
    const line=visualLine(lineRects(),{from:caret,down});
    if(!line.length) {
      const all=editableItems(),edge=down?all.at(-1):all[0];
      if(!edge||(edge===item&&(item.mf||atBoundary(item,down))))return null;
      if(edge===item)return false;
      focusEdge(edge,down);verticalGoal=null;return true;
    }
    const target=nearestFragment(line,x);
    if(target.item===item&&!item.mf)return false;
    placeCaretAt(target.item,target.rect,x);
    verticalGoal={x,key:caretKey(target.item)};
    return true;
  }
  function moveWithinMathScripts(mf,down,extend=false) {
    // MathLive 0.109.2's moveUp/moveDown handles above/below (fractions), but
    // emits move-out for superscript/subscript, including summation limits.
    // Consult its pinned atom tree before treating that as a document boundary.
    const model=mf._mathfield?.model;
    if(!model||mf.mode==='latex')return false;
    const from=down?'superscript':'subscript',to=down?'subscript':'superscript';
    const current=model.at(mf.position);
    let owner=current,branch=owner?.branch(to);
    if(!branch) {
      let child=current;
      while(child&&child.parentBranch!==from)child=child.parent;
      if(!child)return false;
      owner=child.parent;branch=owner.branch(to);
    }
    let offset=model.offsetOf(owner);
    if(branch?.length) {
      const x=mf.getElementInfo(mf.position)?.bounds?.right;
      let distance=Infinity;
      offset=model.offsetOf(branch.at(-1));
      for(const atom of branch) {
        const candidate=model.offsetOf(atom),bounds=mf.getElementInfo(candidate)?.bounds;
        const delta=bounds&&Number.isFinite(x)?Math.abs(bounds.right-x):Infinity;
        if(delta<distance){distance=delta;offset=candidate;}
      }
    }
    if(offset<0||offset===mf.position)return false;
    if(extend) {
      const anchor=model.anchor;
      mf.selection={ranges:[[Math.min(anchor,offset),Math.max(anchor,offset)]],direction:offset<anchor?'backward':'forward'};
    } else {
      const atom=model.at(offset),placeholder=atom.type==='placeholder'?atom:atom.rightSibling?.type==='placeholder'?atom.rightSibling:null;
      if(placeholder){const end=model.offsetOf(placeholder);mf.selection={ranges:[[end-1,end]]};}
      else mf.position=offset;
    }
    return true;
  }
  function handleBoundaryKey(item,event) {
    if(event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return false;
    if(event.key==='Tab'&&!item.mf&&item.token.kind!=='code'&&moveTableCell(item,!event.shiftKey)) {
      event.preventDefault();event.stopImmediatePropagation();return true;
    }
    if(event.shiftKey)return false;
    if(event.key==='Backspace'||event.key==='Delete')return deleteAcrossBoundary(item,event.key==='Delete',event);
    const forward=event.key==='ArrowRight'||event.key==='ArrowDown';
    const horizontal=event.key==='ArrowRight'||event.key==='ArrowLeft';
    const vertical=event.key==='ArrowDown'||event.key==='ArrowUp';
    if(!vertical)verticalGoal=null;
    // Text lines are laid out across runs and inline equations, so a line
    // move is decided by position on the page rather than source order.
    if(vertical&&!item.mf&&!item.el.closest('td')&&window.getSelection()?.isCollapsed) {
      const moved=moveByLine(item,forward)??(atBoundary(item,forward)&&moveBetweenItems(item,forward));
      if(moved){event.preventDefault();event.stopImmediatePropagation();return true;}
      return false;
    }
    if((horizontal&&atBoundary(item,forward))||(vertical&&atVerticalBoundary(item,forward))) {
      if(vertical?moveVertically(item,forward):moveBetweenItems(item,forward)){event.preventDefault();event.stopImmediatePropagation();return true;}
    }
    return false;
  }
  function plaintextPaste(event) {
    const text=event.clipboardData?.getData('text/plain');
    if(typeof text!=='string')return;
    event.preventDefault();
    // Native undo is authoritative; execCommand here preserves contenteditable caret placement.
    document.execCommand('insertText',false,text);
  }
  function encodeProse(text) {
    // A visible prose break needs a TeX paragraph boundary. A single source
    // newline is only whitespace and disappears when equation insertion renders.
    const nl=source.includes('\r\n')?'\r\n':'\n';
    return T.encodeText(text).replace(/\r\n|\r|\n/g,nl+nl);
  }
  function proseOffsets(text) {
    const offsets=[0],breakLength=source.includes('\r\n')?4:2;
    for(let i=0;i<text.length;i++)offsets.push(offsets[i]+(text[i]==='\n'?breakLength:T.encodeText(text[i]).length));
    return offsets;
  }
  function makeText(token,raw=false) {
    const code=token.kind==='code';
    const literal=raw||code;
    const el=document.createElement(token.kind==='heading'?`h${token.level}`:literal?'pre':'span');
    el.className=code?'code-listing':raw?'source-fragment':'text-run';el.contentEditable='true';el.spellcheck=!literal;
    el.setAttribute('aria-label',code?'Editable code listing':raw?'LaTeX source fragment':token.kind==='heading'?'Section heading':'Document text');
    const presentation=literal?null:T.textPresentation(source.slice(token.contentStart,token.contentEnd));
    el.textContent=literal?source.slice(token.contentStart,token.contentEnd):presentation.text;
    const item={token,el,mf:null,presentation,dirty:false};byID.set(token.id,item);
    let block=el, gutter=null;
    const listing=code?T.listingPresentation(token.options):null;
    function updateLineNumbers(text) {
      if(gutter)gutter.textContent=Array.from({length:text.split(/\r\n|\r|\n/).length},(_,i)=>`${listing.firstNumber+i}:`).join('\n');
    }
    if(code) {
      block=document.createElement('div');block.className='code-block';
      if(listing.numbers!=='none') {
        gutter=document.createElement('pre');gutter.className='code-line-numbers';
        gutter.setAttribute('aria-hidden','true');gutter.contentEditable='false';
        block.classList.toggle('numbers-right',listing.numbers==='right');
        block.append(gutter);updateLineNumbers(el.textContent);
      }
      block.append(el);
    }
    item.root=block;
    el.addEventListener('focus',()=>setActive(item));
    el.addEventListener('paste',event=>{
      item.pasting=true;
      try { plaintextPaste(event); } finally { item.pasting=false; }
    });
    el.addEventListener('beforeinput',event=>{
      clearTimeout(autoMathTimer);
      if(!literal&&!event.isComposing&&['insertParagraph','insertLineBreak'].includes(event.inputType)&&event.cancelable) {
        const selection=window.getSelection();
        if(!selection?.rangeCount)return;
        const range=selection.getRangeAt(0);
        if(!el.contains(range.commonAncestorContainer))return;
        event.preventDefault();range.deleteContents();
        const br=document.createElement('br');range.insertNode(br);
        // A terminal break needs a placeholder for WebKit to place the next caret.
        if(!br.nextSibling||br.nextSibling.nodeType===Node.TEXT_NODE&&br.nextSibling.textContent==='')br.after(document.createElement('br'));
        range.setStartAfter(br);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertLineBreak'}));return;
      }
      if(!event.isComposing&&['deleteContentBackward','deleteContentForward'].includes(event.inputType))
        deleteAcrossBoundary(item,event.inputType==='deleteContentForward',event);
    });
    el.addEventListener('keydown',event=>handleBoundaryKey(item,event));
    el.addEventListener('compositionstart',()=>clearTimeout(autoMathTimer));
    if(code)el.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&!event.isComposing&&!event.metaKey&&!event.ctrlKey&&!event.altKey) {
        event.preventDefault();
        const selection=window.getSelection();
        if(!selection?.rangeCount)return;
        const range=selection.getRangeAt(0);
        if(!el.contains(range.commonAncestorContainer))return;
        range.deleteContents();
        const newline=document.createTextNode('\n');range.insertNode(newline);
        range.setStartAfter(newline);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertLineBreak'}));return;
      }
      if(event.key==='Tab'&&!event.shiftKey&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
        event.preventDefault();document.execCommand('insertText',false,'\t');
      }
    });
    el.addEventListener('input',event=>{
      if(suppress)return;
      // WebKit leaves a placeholder <br> after deleting the last text character.
      // It is an empty editing surface, not a new source line between equations.
      // The empty host must retain its own layout box (see .text-run:empty) so
      // WebKit's native reveal-selection step can still locate the caret.
      if(event.inputType?.startsWith('delete')&&el.childNodes.length===1&&el.firstChild.nodeName==='BR') {
        el.replaceChildren();focusEdge(item);
      }
      let text=el.innerText.replace(/\u00a0/g,' ');
      if(literal&&source.includes('\r\n'))text=text.replace(/\r?\n/g,'\r\n');
      if(code)updateLineNumbers(text);
      let replacement=literal?text:encodeProse(text);
      let presentation=null;
      if(!literal&&item.presentation) {
        // Retain untouched escapes and line endings around the edited characters.
        const old=item.presentation, content=source.slice(token.contentStart,token.contentEnd);
        let prefix=0,suffix=0;
        while(prefix<old.text.length&&prefix<text.length&&old.text[prefix]===text[prefix])prefix++;
        // Identical spaces can have different source spellings (e.g. a source
        // newline). Anchor typed text to the actual caret before matching suffixes.
        if(event.inputType==='insertText'&&typeof event.data==='string') {
          const caret=textCaret(item);
          if(caret!==null&&caret>=event.data.length)prefix=Math.min(prefix,caret-event.data.length);
        }
        while(suffix<old.text.length-prefix&&suffix<text.length-prefix&&old.text[old.text.length-1-suffix]===text[text.length-1-suffix])suffix++;
        const inserted=text.slice(prefix,text.length-suffix),encoded=encodeProse(inserted);
        const start=old.offsets[prefix],end=old.offsets[old.text.length-suffix];
        replacement=content.slice(0,start)+encoded+content.slice(end);
        presentation={text,offsets:[...old.offsets.slice(0,prefix+1),
          ...proseOffsets(inserted).slice(1).map(offset=>start+offset),
          ...old.offsets.slice(old.text.length-suffix+1).map(offset=>offset+encoded.length-(end-start))]};
      }
      if(!literal&&!presentation)presentation={text,offsets:proseOffsets(text)};
      // Empty control words still need a lexical separator when first populated.
      const previous=tokens[tokens.indexOf(token)-1];
      if(replacement&&token.contentStart===token.contentEnd&&(previous?.kind==='listItem'||previous?.environment==='algorithm-line')
        &&previous.end===token.contentStart&&/\\(?:item|Statex?|Require|Ensure)$/.test(source.slice(previous.start,previous.end))) {
        const start=token.contentStart;
        mutate(start,start,' '+replacement);
        render({restore:false,focusOffset:start+1+replacement.length,focusText:true});return;
      }
      if(mutate(token.contentStart,token.contentEnd,replacement,token))item.dirty=true;
      // The live contenteditable may contain div/br nodes. Use its current text when inserting.
      // Keep the live DOM mapping even while WebKit has extra placeholder breaks.
      // Re-decoding TeX would collapse those and lose untouched source offsets.
      item.presentation=presentation;
      clearSuggestion();
      lastConversion=null;
      clearTimeout(autoMathTimer);
      if(!literal&&!el.closest('code')&&!item.pasting&&!event.isComposing&&event.inputType==='insertText')
        autoConvertText(item);
    });
    el.addEventListener('blur',()=>{
      clearTimeout(autoMathTimer);
      // Re-scan raw source after a completed edit, not in the middle of a keystroke.
      if(raw&&item.dirty&&!suppress)setTimeout(()=>{if(el.isConnected&&!el.contains(document.activeElement))render();},0);
    });
    return block;
  }
  function textCaret(item) {
    const sel=window.getSelection();
    if(!sel?.rangeCount||!sel.isCollapsed||!item.el.contains(sel.anchorNode))return null;
    if(item.el.textContent.replace(/\u00a0/g,' ')!==item.el.innerText.replace(/\u00a0/g,' ')) {
      // A detached Range omits div/br line breaks. Measure a hidden clone with a caret marker,
      // then require that removing the marker reproduces the live rendered text exactly.
      const marker='\uE000';
      if(item.el.textContent.includes(marker))return null;
      const path=[];
      for(let node=sel.anchorNode;node!==item.el;node=node.parentNode)
        path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes,node));
      const clone=item.el.cloneNode(true);clone.removeAttribute('contenteditable');
      clone.style.cssText+=';position:fixed;left:-100000px;opacity:0;pointer-events:none';
      let target=clone;for(const index of path)target=target.childNodes[index];
      const mark=document.createRange();mark.setStart(target,sel.anchorOffset);mark.collapse(true);
      mark.insertNode(document.createTextNode(marker));
      page.append(clone);
      try {
        const marked=clone.innerText.replace(/\u00a0/g,' '), index=marked.indexOf(marker);
        return index>=0&&marked.replace(marker,'')===item.el.innerText.replace(/\u00a0/g,' ')?index:null;
      } finally {clone.remove();}
    }
    const range=document.createRange();range.selectNodeContents(item.el);range.setEnd(sel.anchorNode,sel.anchorOffset);
    return range.toString().length;
  }
  function autoConvertText(item, delayed=false) {
    if(preview||active!==item||document.activeElement!==item.el||!item.el.isConnected)return;
    const caret=textCaret(item);
    if(caret===null)return;
    const text=item.el.innerText.replace(/\u00a0/g,' ');
    const match=window.AutoMath.detectAutoMath(text,caret,settings.autoEquations);
    if(!match)return;
    if(match.delay&&!delayed) {
      const expectedRevision=revision;
      autoMathTimer=setTimeout(()=>{
        if(revision===expectedRevision&&textCaret(item)===caret)autoConvertText(item,true);
      },350);
      return;
    }
    const t=item.token, content=source.slice(t.contentStart,t.contentEnd);
    // Input has already saved this text. Require an exact source mapping before replacement.
    const mapping=item.presentation?.text===text?item.presentation.offsets:null;
    if(!mapping&&content!==encodeProse(text))return;
    let latex;
    try {
      // Parse scripts with their operand so a/b^2 keeps the exponent in the denominator.
      latex=match.ascii&&match.script
        ?window.MathLive.convertAsciiMathToLatex(match.ascii+match.script+'(?)').replace('?', '\\placeholder{}')
        :(match.ascii?window.MathLive.convertAsciiMathToLatex(match.ascii):'')+match.latex;
    }
    catch { return; }
    const start=t.contentStart+(mapping?.[match.start]??encodeProse(text.slice(0,match.start)).length);
    const end=t.contentStart+(mapping?.[match.end]??encodeProse(text.slice(0,match.end)).length);
    const original=source.slice(start,end), replacement='\\('+latex+'\\)';
    mutate(start,end,replacement);
    render({restore:false,focusOffset:start+2,focusPlaceholder:latex.includes('\\placeholder')});
    lastConversion={revision,start,end:start+replacement.length,original};
    document.getElementById('live-region').textContent='Inline equation. Press Backspace to restore text.';
  }
  function addRule(cell,side,count) {
    if(count)cell.classList.add(`rule-${side}`,...(count>1?[`rule-${side}-double`]:[]));
  }
  function makeMath(token) {
    const latex=T.mathForField(token,source);
    const envHasMetadata=/\\(?:label|tag|nonumber|notag)\b|(^|[^\\])%/.test(latex);
    let errors=[];
    try { errors=window.MathLive?.validateLatex?.(latex,{macros:mathLiveMacros()})||[]; } catch {errors=[{code:'invalid-command'}];}
    if(envHasMetadata || errors.some(e=>['unknown-command','unknown-environment','invalid-command'].includes(e.code))) {
      // Protect labels, comments, package commands and unknown macros from normalization.
      const rawToken={...token,kind:'raw',contentStart:token.start,contentEnd:token.end};
      Object.assign(token,rawToken);
      return makeText(token,true);
    }
    const wrap=document.createElement(token.display?'div':'span');wrap.className=`math-wrap ${token.display?'display':'inline'}`;
    // Only an empty field needs a minimum click target; content sets its own width.
    wrap.classList.toggle('empty',!latex);
    const mf=new window.MathfieldElement();
    // MathLive's macros and shortcut accessors require a mounted field.
    mf.addEventListener('mount',()=>{
      mf.mathVirtualKeyboardPolicy='manual';mf.smartFence=true;mf.smartMode=false;
      mf.letterShapeStyle='tex';mf.defaultMode=token.display?'math':'inline-math';mf.inlineShortcutTimeout=0;
      mf.macros={...mf.macros,...mathLiveMacros()};
      mf.inlineShortcuts={...mf.inlineShortcuts,
        sum:'\\sum_{n=#?}^{#?}{#?}',prod:'\\prod_{n=#?}^{#?}{#?}',
        sqrt:'\\sqrt{#?}',int:'\\int_{#?}^{#?}{#?}\\,\\mathrm{d}x',
        lim:'\\lim_{x\\to #?}{#?}',infty:'\\infty',oo:'\\infty',
        alpha:'\\alpha',beta:'\\beta',gamma:'\\gamma',theta:'\\theta',pi:'\\pi'
      };
    },{once:true});
    mf.setAttribute('aria-label',token.display?'Editable display equation':'Editable inline equation');
    mf.setAttribute('placeholder',token.display?'\\text{Equation}':'\\square');
    mf.setValue(latex,{silenceNotifications:true});
    const rendered=document.createElement('span');rendered.className='math-preview';rendered.tabIndex=0;
    rendered.setAttribute('aria-label','Equation preview. Press Enter to edit.');safeMath(latex,rendered,token.display);
    const ghost=document.createElement('span');ghost.className='ghost';ghost.setAttribute('aria-hidden','true');
    wrap.append(mf,rendered,ghost);
    const item={token,el:wrap,mf,rendered,ghost};byID.set(token.id,item);
    mf.addEventListener('focus',()=>setActive(item));
    mf.addEventListener('input',()=>saveMath(item));
    mf.addEventListener('pointerdown',()=>{lastConversion=null;});
    mf.addEventListener('selection-change',()=>{if(active===item)updateGhost();});
    mf.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='ArrowUp'||event.key==='ArrowDown') {
        // move-out has no modifier information. Keep the dispatching key event;
        // eventPhase becomes NONE afterward, so later commands cannot reuse it.
        item.mathNavigationEvent=event;
      }
      if(event.key==='Backspace'&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&lastConversion?.revision===revision) {
        event.preventDefault();event.stopImmediatePropagation();
        const undo=lastConversion;lastConversion=null;
        mutate(undo.start,undo.end,undo.original);
        render({restore:false,focusOffset:undo.start+undo.original.length,focusText:true});
        return;
      }
      lastConversion=null;
      if(mf.mode!=='latex'&&handleBoundaryKey(item,event))return;
      if(event.key==='Tab'&&!event.shiftKey&&suggestion&&atEnd(mf)) {
        if(acceptSuggestion()){event.preventDefault();event.stopImmediatePropagation();}
      } else if(event.key==='Enter'&&!event.shiftKey&&!event.metaKey&&!event.ctrlKey&&mf.mode!=='latex') {
        event.preventDefault();event.stopImmediatePropagation();insertEquation();
      } else if(event.key==='Escape') {
        clearSuggestion();
      }
    },true);
    const edit=()=>{setPreview(false);mf.focus();mf.position=mf.lastOffset;setActive(item);};
    rendered.addEventListener('dblclick',edit);
    rendered.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();edit();}});
    mf.addEventListener('move-out',event=>{
      const dir=event.detail?.direction;
      const key=item.mathNavigationEvent,extend=!!(key?.eventPhase&&key.shiftKey);
      if((dir==='upward'||dir==='downward')&&moveWithinMathScripts(mf,dir==='downward',extend)) {
        event.preventDefault();return;
      }
      if(['forward','backward','upward','downward'].includes(dir)
        &&(dir==='upward'||dir==='downward'?moveVertically(item,dir==='downward'):moveBetweenItems(item,dir==='forward')))event.preventDefault();
    });
    return wrap;
  }
  function mathLiveMacros() {
    // MathLive keys omit the slash; KaTeX keys include it.
    return Object.fromEntries(Object.entries(macros).map(([key,value])=>[key.replace(/^\\/,''),value]));
  }
  function focusState(nextSource=source) {
    if(!active)return null;
    const t=active.token;
    const caret=active.mf?null:textCaret(active);
    let offset=active.mf?t.contentStart:t.contentStart+(active.presentation?.offsets[caret]??caret??0);
    let focusText=!active.mf;
    if(nextSource!==source) {
      let start=0,suffix=0;
      while(start<source.length&&start<nextSource.length&&source[start]===nextSource[start])start++;
      while(suffix<source.length-start&&suffix<nextSource.length-start&&source[source.length-1-suffix]===nextSource[nextSource.length-1-suffix])suffix++;
      const end=source.length-suffix,newEnd=nextSource.length-suffix;
      if(active.mf&&start<=t.start&&end>=t.end) {
        offset=newEnd;focusText=true;
      } else if(offset>=end)offset+=newEnd-end;
      else if(offset>=start)offset=newEnd;
      // Redo can turn prose back into a field. Focus that field at the same edit site.
      const created=T.scanDocument(nextSource).tokens.find(x=>x.kind==='math'&&x.start>=start&&x.end<=newEnd&&x.end===offset);
      if(created){offset=created.contentStart;focusText=false;}
    }
    return {focusOffset:offset,focusText,mathPosition:active.mf?.position??null};
  }
  const documentSelection=window.DocumentSelection.create({page,items:editableItems,source:()=>source,
    onSelect:()=>{clearTimeout(autoMathTimer);clearSuggestion();lastConversion=null;}});
  page.addEventListener('click',event=>{
    // Native hit testing in the blank part of a math-ending row can choose the
    // leading newline's broken caret. Share the keyboard's source-free slot.
    // Leave equation clicks, text selection and modified/multiple clicks native.
    if(preview||event.button!==0||event.detail!==1||event.shiftKey||event.metaKey||event.ctrlKey||event.altKey
      ||!window.getSelection()?.isCollapsed||page.classList.contains('has-document-selection'))return;
    const all=editableItems(),target=all.find(item=>item.el.contains(event.target));
    if(target?.mf)return;
    for(let i=all.length-1;i>=0;i--) {
      const item=all[i];
      if(!item.mf||item.token.display)continue;
      const rect=item.mf.getBoundingClientRect();
      if(event.clientX<rect.right||event.clientY<rect.top||event.clientY>rect.bottom)continue;
      const next=all[i+1],slot=next&&!next.mf&&!itemText(next)?next:null;
      const after=slot?all[i+2]:next;
      if(!after||after.mf||!itemText(after).startsWith('\n'))continue;
      if(target&&target!==slot&&target!==after)continue;
      // Do not cross table cells or other separately laid-out containers.
      const region=item.el.closest('li,td,.document-algorithm-line')||page;
      if(!region.contains(event.target)||event.clientX>region.getBoundingClientRect().right)continue;
      documentSelection.clear();focusEdge(slot||createTextNeighbor(item,true));
      return;
    }
    // A click in the page's padding or the gaps between blocks focuses the
    // page itself, which cannot be typed into. Put the caret on the nearest
    // line instead, at the clicked column, as a single text box would.
    if(all.some(item=>item.el.contains(document.activeElement)))return;
    const fragments=lineRects(),line=visualLine(fragments,{y:event.clientY});
    const nearest=nearestFragment(line,event.clientX);
    if(nearest){verticalGoal=null;placeCaretAt(nearest.item,nearest.rect,event.clientX);}
  });
  /** Rebuild the page from source; returns the scanner's warnings. */
  function buildPage(focusText,focusOffset) {
    const scan=T.scanDocument(source);tokens=scan.tokens;body=scan.body;macros=T.readMacroDefinitions(source);
    // Keep a prose insertion point when deleting the only field, or one between fields.
    // It is a zero-length source token, so typing here still produces an ordinary patch.
    if(focusText&&focusOffset!==null&&!tokens.some(t=>['text','heading','raw','code'].includes(t.kind)&&t.contentStart<=focusOffset&&t.contentEnd>=focusOffset)) {
      const slot={id:'caret-slot',kind:'text',start:focusOffset,end:focusOffset,contentStart:focusOffset,contentEnd:focusOffset};
      const index=tokens.findIndex(t=>t.start>=focusOffset);
      tokens.splice(index<0?tokens.length:index,0,slot);
    }
    const fragment=document.createDocumentFragment();
    let container=fragment;
    const containers=[];
    for(const token of tokens) {
      if(token.kind==='tableStart') {
        const wrap=document.createElement('div');wrap.className='table-scroll';
        const table=document.createElement('table');table.className='document-table';table.setAttribute('aria-label','Editable table');
        const tbody=document.createElement('tbody');table.append(tbody);wrap.append(table);container.append(wrap);
        containers.push({kind:'table',parent:container,table:tbody,rules:token.rules||[],region:addRegion(wrap,token,'table')});container=tbody;continue;
      }
      if(token.kind==='tableRowStart') {
        const row=document.createElement('tr');container.append(row);
        containers.push({kind:'row',parent:container,rulesAbove:token.rulesAbove||0,region:addRegion(row,token,'row')});container=row;continue;
      }
      if(token.kind==='tableCellStart') {
        const cell=document.createElement('td');cell.style.textAlign={l:'left',c:'center',r:'right'}[token.alignment];
        // Draw the source's | and \hline rules; other cell edges are faint editing guides.
        const rules=containers.findLast(c=>c.kind==='table')?.rules||[],column=container.children.length;
        if(column===0)addRule(cell,'left',rules[0]);
        addRule(cell,'right',rules[column+1]);
        addRule(cell,'top',containers.at(-1)?.rulesAbove);
        container.append(cell);containers.push({kind:'cell',parent:container,region:addRegion(cell,token,'cell')});container=cell;continue;
      }
      if(token.kind==='tableEnd'&&token.rulesBelow)for(const cell of container.lastElementChild?.children||[])addRule(cell,'bottom',token.rulesBelow);
      if(['tableCellEnd','tableRowEnd','tableEnd'].includes(token.kind)) {const context=containers.pop();closeRegion(context?.region,token);container=context?.parent||fragment;continue;}
      if(token.kind==='blockStart') {
        const block=document.createElement('div');block.className='document-'+token.environment;
        let content=block;
        const generated=(text,className)=>{const el=document.createElement('span');el.className=className;el.textContent=text;el.contentEditable='false';return el;};
        if(token.environment==='algorithm-caption')block.append(generated(token.label+'  ','algorithm-label'));
        if(token.environment==='algorithm-line') {
          block.style.setProperty('--algorithm-indent',String(token.indent));
          const number=generated(token.lineNumber===null?'':token.lineNumber+':','algorithm-line-number');number.setAttribute('aria-hidden','true');block.append(number);
          content=document.createElement('span');content.className='algorithm-line-content';block.append(content);
          if(token.prefix)content.append(generated(token.prefix+' ','algorithm-keyword'));
        }
        container.append(block);containers.push({kind:'block',parent:container,suffix:token.suffix,region:addRegion(block,token,'block')});container=content;continue;
      }
      if(token.kind==='blockEnd') {
        const context=containers.pop();
        if(context?.suffix){const suffix=document.createElement('span');suffix.className='algorithm-keyword';suffix.contentEditable='false';suffix.textContent=' '+context.suffix;container.append(suffix);}
        closeRegion(context?.region,token);container=context?.parent||fragment;continue;
      }
      if(token.kind==='linebreak') {
        const line=document.createElement('div');line.className='document-linebreak';line.style.height=token.spacing;
        line.setAttribute('aria-hidden','true');container.append(line);continue;
      }
      if(token.kind==='pagebreak') {
        const pageBreak=document.createElement('div');pageBreak.className='document-pagebreak';
        pageBreak.setAttribute('aria-hidden','true');container.append(pageBreak);continue;
      }
      if(token.kind==='spacing') {
        const space=document.createElement('div');space.className='document-vspace';
        if(parseFloat(token.spacing)<0)space.style.marginBottom=token.spacing;
        else space.style.height=token.spacing;
        space.setAttribute('aria-hidden','true');container.append(space);continue;
      }
      if(token.kind==='listStart') {
        const list=document.createElement(token.environment==='enumerate'?'ol':'ul');
        list.className='document-list';
        if(token.environment==='description')list.classList.add('description-list');
        const start=/\bstart\s*=\s*(\d+)/.exec(token.options);
        if(start)list.start=Number(start[1]);
        container.append(list);
        containers.push({kind:'list',parent:container,list,token,region:addRegion(list,token,'list'),index:(start?Number(start[1]):1)-1});
        container=list;continue;
      }
      if(token.kind==='listItem') {
        const context=containers.at(-1);
        if(context?.kind!=='list')continue;
        closeRegion(context.itemRegion,token,true);
        const item=document.createElement('li');context.list.append(item);context.index++;
        context.itemRegion=addRegion(item,token,'listItem');
        let label=token.label;
        let bold=context.token.environment==='description';
        if(label===null && context.token.environment==='enumerate') {
          const custom=T.listMarker(context.token.options,context.index);
          if(custom){label=custom.text;bold=custom.bold;}
        }
        if(label!==null) {
          const marker=document.createElement(bold?'strong':'span');marker.className='list-label';
          marker.textContent=T.decodeText(label);marker.contentEditable='false';
          item.classList.add('custom-label');item.append(marker);
        }
        container=item;continue;
      }
      if(token.kind==='listEnd') {
        const context=containers.pop();closeRegion(context?.itemRegion,token,true);closeRegion(context?.region,token);container=context?.parent||fragment;continue;
      }
      if(token.kind==='formatStart') {
        const tag={textbf:'strong',textit:'em',emph:'em',texttt:'code',textrm:'span',textsf:'span',underline:'u',textsuperscript:'sup',textsubscript:'sub'}[token.format]||'span';
        const element=document.createElement(tag);element.className='format-'+token.format;
        container.append(element);containers.push({kind:'format',parent:container,region:addRegion(element,token,'format')});container=element;continue;
      }
      if(token.kind==='formatEnd') {const context=containers.pop();closeRegion(context?.region,token);container=context?.parent||fragment;continue;}
      if(token.kind==='comment'||token.kind==='metadata')continue;
      if(token.kind==='literal'){const el=document.createElement('span');el.className='document-literal';el.contentEditable='false';el.textContent=token.text;container.append(el);continue;}
      // Whitespace between inline fields is an editable part of the document too.
      // Only omit list-container indentation, which is outside any list item.
      if(token.kind==='text'&&!source.slice(token.start,token.end).trim()&&(container.tagName==='OL'||container.tagName==='UL'||container.matches?.('.document-algorithm,.document-algorithmic')))continue;
      const element=token.kind==='math'?makeMath(token):makeText(token,token.kind==='raw');
      container.append(element);
    }
    for(const region of [...regions].reverse()) {
      if(region.first.environment==='algorithm-line'&&!region.first.editableContent)continue;
      if(['table','row'].includes(region.kind)||[...byID.values()].some(i=>region.el.contains(i.el)))continue;
      const offset=region.first.end;
      const slot={id:`caret-${++caretSlotID}`,kind:'text',start:offset,end:offset,contentStart:offset,contentEnd:offset};
      tokens.splice(tokens.indexOf(region.first)+1,0,slot);
      const content=region.el.querySelector(':scope > .algorithm-line-content');
      if(content&&region.first.suffix)content.insertBefore(makeText(slot),content.lastChild);
      else (content||region.el).append(makeText(slot));
    }
    if(!tokens.some(t=>t.kind==='math'||(t.kind!=='comment'&&source.slice(t.start,t.end).trim()))) {
      const hint=document.createElement('p');hint.className='empty-instruction';hint.textContent='Press ⌘↩ to start an equation, or add a text paragraph from the left sidebar.';fragment.append(hint);
    }
    page.replaceChildren(fragment);
    return scan.warnings;
  }
  function renderAsSource() {
    byID.clear();regions=[];
    try { body=T.bodyRange(source); } catch { body={start:0,end:source.length,wrapped:false}; }
    tokens=[{id:'t0',kind:'raw',start:body.start,end:body.end,contentStart:body.start,contentEnd:body.end}];
    page.replaceChildren(makeText(tokens[0],true));
  }
  function render({restore=true,focusOffset=null,selectText=null,caretText=null,focusPlaceholder=false,focusText=false,mathPosition=null}={}) {
    documentSelection.clear();
    clearTimeout(autoMathTimer);lastConversion=null;
    if(restore&&focusOffset===null) {
      const saved=focusState();
      if(saved)({focusOffset,focusText,mathPosition}=saved);
    }
    const scroll={left:window.scrollX,top:window.scrollY,behavior:'instant'};
    // MathLive's new fields lay out on animation frames. Keep the old page height
    // until then so the browser cannot clamp a viewport near the document bottom.
    cancelAnimationFrame(layoutFrame);
    page.style.minHeight=page.getBoundingClientRect().height+'px';
    suppress=true;
    // Blur while the field is still mounted so MathLive can release its shared input.
    if(page.contains(document.activeElement))document.activeElement.blur();
    clearSuggestion();byID.clear();regions=[];active=null;
    let warnings;
    try { warnings=buildPage(focusText,focusOffset); }
    catch(error) {
      // Never leave a half-built page: show the body as editable source instead.
      warnings=['The page could not be laid out, so it is shown as source. '+error.message];
      renderAsSource();
    } finally { suppress=false; }
    post('documentInfo',{equations:tokens.filter(t=>t.kind==='math').length,rawBlocks:tokens.filter(t=>t.kind==='raw').length,warnings});
    const offset=focusOffset;
    if(offset!==undefined&&offset!==null) {
      const items=[...byID.values()];
      const item=(focusText&&items.find(x=>!x.mf&&x.token.contentStart<=offset&&x.token.contentEnd>=offset))
        ||items.find(x=>x.token.start<=offset&&x.token.end>offset)
        ||items.find(x=>x.token.start>=offset)
        ||items.at(-1);
      if(item) {
        if(item.mf) {
          const expectedRevision=revision;
          const focus=()=>{
            if(!item.el.isConnected||revision!==expectedRevision||(active&&active!==item))return;
            const viewport={left:window.scrollX,top:window.scrollY,behavior:'instant'};
            item.mf.focus({preventScroll:true});
            item.mf.position=mathPosition!==null?Math.min(mathPosition,item.mf.lastOffset):item.mf.lastOffset;
            if(focusPlaceholder){item.mf.position=0;item.mf.executeCommand('moveToNextPlaceholder');}
            // Placeholder commands can scroll too. A later mount must preserve the
            // current viewport, including any scrolling since this render.
            window.scrollTo(viewport);
          };
          // New MathLive fields mount asynchronously; focus/placeholder commands need that mount.
          item.mf.addEventListener('mount',focus,{once:true});focus();
        }
        else {
          item.el.focus({preventScroll:true});
          const relative=Math.max(0,offset-item.token.contentStart);
          const mapped=item.presentation?.offsets.findIndex(value=>value>=relative);
          const index=caretText??(selectText?item.el.textContent.lastIndexOf(selectText):mapped>=0?mapped:relative);
          const node=item.el.firstChild||item.el;
          const length=node.nodeType===Node.TEXT_NODE?node.length:0;
          const range=document.createRange();range.setStart(node,Math.min(Math.max(0,index),length));
          range.setEnd(node,Math.min(Math.max(0,index)+(selectText?selectText.length:0),length));
          const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
        }
      }
    }
    // Replacing mounted fields temporarily changes page height. Restore after
    // rebuilding and selecting the caret, regardless of which editor gets focus.
    window.scrollTo(scroll);
    layoutFrame=requestAnimationFrame(()=>{
      layoutFrame=requestAnimationFrame(()=>{
        page.style.minHeight='';layoutFrame=null;
      });
    });
  }
  function proseCaretOffset() {
    if(!active || active.mf || active.token.kind!=='text')return null;
    const caret=textCaret(active);
    if(caret===null)return null;
    const text=itemText(active),content=source.slice(active.token.contentStart,active.token.contentEnd);
    // Use an exact mapping only when DOM text and its source presentation still agree.
    const presentation=active.presentation;
    if(presentation && text===presentation.text && caret<presentation.offsets.length)
      return active.token.contentStart+presentation.offsets[caret];
    // Text changed in this editing session: encode precisely the current prefix.
    const encoded=encodeProse(text.slice(0,caret));
    if(content.startsWith(encoded))return active.token.contentStart+encoded.length;
    return null;
  }
  function insertEquation(latex='',inline=false) {
    const nl=source.includes('\r\n')?'\r\n':'\n';
    const pos=(inline?proseCaretOffset():null)??T.blockInsertionOffset(tokens,active?.token,body.end);
    const prefix=inline?' \\(':`${nl}\\[${nl}`;
    const suffix=inline?'\\) ':`${nl}\\]${nl}`;
    mutate(pos,pos,prefix+latex+suffix);
    render({restore:false,focusOffset:pos+prefix.length});
  }
  function insertParagraph() {
    const pos=T.blockInsertionOffset(tokens,active?.token,body.end),nl=source.includes('\r\n')?'\r\n':'\n';
    mutate(pos,pos,`${nl}${nl}New paragraph.${nl}${nl}`);
    render({restore:false,focusOffset:pos+2*nl.length,selectText:'New paragraph.'});
  }
  function insertCommand(command) {
    if(!command||typeof command.latex!=='string')return;
    if(command.mode==='document'||command.mode==='preamble') {
      const pos=command.mode==='preamble'?(source.charCodeAt(0)===0xfeff?1:0):T.blockInsertionOffset(tokens,active?.token,body.end);
      const nl=source.includes('\r\n')?'\r\n':'\n';
      const template=command.latex.replace(/\r?\n/g,nl);
      const first=T.scanDocument(template).tokens.find(t=>['code','heading','math','text','raw'].includes(t.kind)&&template.slice(t.contentStart,t.contentEnd).trim());
      mutate(pos,pos,nl+template+nl);
      setPreview(false);
      render({restore:false,focusOffset:command.mode==='preamble'?null:pos+nl.length+(first?.contentStart??0)});
      if(command.mode==='preamble')report('Inserted in the preamble. Use Source to edit it.');
      return;
    }
    setPreview(false);
    if(!active?.mf)insertEquation();
    if(!active?.mf)return;
    active.mf.focus();
    active.mf.insert(command.latex,{insertionMode:'replaceSelection',selectionMode:'placeholder',format:'latex'});
    // Some programmatic insertions do not dispatch input in every MathLive release.
    saveMath(active);
  }
  function acceptSuggestion() {
    if(!suggestion||!active?.mf||suggestion.id!==active.token.id||suggestion.revision!==revision||active.mf.value!==suggestion.original)return false;
    const chosen=suggestion,mf=active.mf;
    if(/\\placeholder\b/.test(mf.value))return false;
    clearSuggestion();
    if(chosen.replaceTrailingEquals) {
      mf.setValue(mf.value.replace(/=\s*$/,'')+chosen.append,{silenceNotifications:true});
      mf.position=mf.lastOffset;saveMath(active);
    } else {
      mf.focus();mf.position=mf.lastOffset;
      mf.insert(chosen.append,{insertionMode:'insertAfter',selectionMode:'after',format:'latex'});saveMath(active);
    }
    document.getElementById('live-region').textContent='Result inserted. '+chosen.note;
    return true;
  }
  function setPreview(value) {
    preview=!!value;page.classList.toggle('preview',preview);clearSuggestion();post('preview',{enabled:preview});
  }
  function handleShortcut(event) {
    if(event.isComposing)return;
    const k=event.key.toLowerCase();
    if((event.metaKey||event.ctrlKey)&&k==='z') {
      event.preventDefault();event.stopImmediatePropagation();post('request',{action:event.shiftKey?'redo':'undo'});return;
    }
    if(event.metaKey&&!event.altKey&&k==='k'){event.preventDefault();post('request',{action:'palette'});return;}
    if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();insertEquation('',event.shiftKey);return;}
    const bits=[];if(event.metaKey)bits.push('cmd');if(event.ctrlKey)bits.push('ctrl');if(event.altKey)bits.push('alt');if(event.shiftKey)bits.push('shift');
    // Physical key code avoids Option-modified characters such as ∑ and ƒ.
    const key=event.code?.startsWith('Key')?event.code.slice(3).toLowerCase():k;
    bits.push(key);
    const combo=bits.join('+');
    const command=commands.find(c=>c.shortcut===combo);
    if(command){event.preventDefault();event.stopImmediatePropagation();insertCommand(command);}
  }
  document.addEventListener('keydown',handleShortcut,true);
  window.GlassTeX={
    setDocument(payload) {
      if(typeof payload.source!=='string'||!Number.isInteger(payload.revision))return;
      if(!payload.force&&source===payload.source&&revision===payload.revision)return;
      const saved=payload.initial?null:focusState(payload.source);
      source=payload.source;revision=payload.revision;
      render({restore:false,...saved});
      if(payload.initial) {
        const first=[...byID.values()].find(i=>i.mf&&!i.mf.value.trim());
        if(first){first.mf.focus();first.mf.position=0;}
      }
    },
    receive(message) {
      switch(message.action) {
        case 'insertCommand':insertCommand(message.command);break;
        case 'insertEquation':insertEquation('',!!message.inline);break;
        case 'insertParagraph':insertParagraph();break;
        case 'accept':acceptSuggestion();break;
        case 'preview':setPreview(message.enabled);break;
        case 'settings':
          clearTimeout(autoMathTimer);
          settings={...settings,...message.settings};
          document.documentElement.dataset.appearance=['light','dark'].includes(settings.appearance)?settings.appearance:'system';
          document.documentElement.dataset.spacing=['comfortable','spacious','custom'].includes(settings.documentSpacing)?settings.documentSpacing:'compact';
          for(const [key,property,min,max,fallback,unit] of [
            ['customLineSpacing','--custom-line-spacing',1.1,2.2,1.25,''],
            ['customBlockSpacing','--custom-block-spacing',0,2,.6,'em'],
            ['customEquationSpacing','--custom-equation-spacing',0,2,.4,'em'],
            ['customListSpacing','--custom-list-spacing',0,1.5,.35,'em']
          ]) {
            const value=Number.isFinite(settings[key])?Math.min(max,Math.max(min,settings[key])):fallback;
            document.documentElement.style.setProperty(property,value+unit);
          }
          document.documentElement.style.setProperty('--math-size',(Number.isFinite(settings.fontSize)?Math.max(14,Math.min(40,settings.fontSize)):22)+'px');scheduleAnalysis();break;
        case 'commands':commands=message.commands||commands;break;
        case 'focus':active?.mf?.focus();break;
        case 'selectAll':documentSelection.selectAll();break;
        case 'sourceChanged':render();break;
      }
    },
    snapshot:()=>({source,revision,tokens:tokens.map(t=>({...t})),active:active?.token.id||null,suggestion}),
  };
  if(!T || !window.MathfieldElement) {
    fatal('MathLive assets are missing. Run Build & Run.command to fetch the pinned editor dependencies, then build the app. Your .tex files have not been changed.');
    return;
  }
  window.MathfieldElement.fontsDirectory=new URL('vendor/mathlive/fonts/',window.location.href).href;
  window.MathfieldElement.soundsDirectory=null;
  // Do not let MathLive fetch a remote compute engine; the app has its own local worker.
  window.MathfieldElement.computeEngine=null;
  window.MathfieldElement.restoreFocusWhenDocumentFocused=false;
  post('ready');
  if(!native) {
    const starter='\\documentclass[11pt]{article}\n\\usepackage{amsmath,amssymb}\n\\begin{document}\n\\section{A little room to think}\nA continuous page. Click an equation to edit it.\n\\[\n\\frac{1}{3}+\\frac{1}{6}\n\\]\n\\[\nx^2-5x+6=0\n\\]\n\\[\n\\sum_{n=1}^{10}n\n\\]\n\\[\n\n\\]\n\\end{document}\n';
    window.GlassTeX.setDocument({source:starter,revision:0,initial:true});
  }
})();
