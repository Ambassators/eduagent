/* Selection across independent contenteditable hosts and MathLive shadow roots.
   Single-element gestures remain native; document selections copy visible prose
   and the original delimited LaTeX for equations. No source is rewritten. */
window.DocumentSelection = {
  create({page, items, source, onSelect}) {
    let selection=null, drag=null, frame=null;
    const layer=document.createElement('div');layer.className='document-selection';layer.setAttribute('aria-hidden','true');
    document.body.append(layer);page.tabIndex=-1;
    const length=item=>item.mf?1:item.el.textContent.length;
    const point=(item,offset)=>({item,offset:Math.max(0,Math.min(length(item),offset))});
    function boundary(p) {
      if(p.item.mf) {
        const node=p.item.el,parent=node.parentNode;
        return {node:parent,offset:[...parent.childNodes].indexOf(node)+(p.offset?1:0)};
      }
      const walker=document.createTreeWalker(p.item.el,NodeFilter.SHOW_TEXT);let left=p.offset,node;
      while((node=walker.nextNode())) {if(left<=node.length)return {node,offset:left};left-=node.length;}
      return {node:p.item.el,offset:p.item.el.childNodes.length};
    }
    function ordered() {
      if(!selection)return null;
      const all=items(),a=all.indexOf(selection.anchor.item),b=all.indexOf(selection.focus.item);
      if(a<0||b<0)return null;
      return a<b||(a===b&&selection.anchor.offset<=selection.focus.offset)
        ?{all,start:selection.anchor,end:selection.focus,first:a,last:b}
        :{all,start:selection.focus,end:selection.anchor,first:b,last:a};
    }
    function rangeFor(item,start,end) {
      const range=document.createRange(),a=boundary(point(item,start)),b=boundary(point(item,end));
      range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);return range;
    }
    function paint() {
      frame=null;layer.replaceChildren();const span=ordered();if(!span)return;
      for(let i=span.first;i<=span.last;i++) {
        const item=span.all[i],start=i===span.first?span.start.offset:0,end=i===span.last?span.end.offset:length(item);
        if(start===end)continue;
        const rects=item.mf?[item.el.getBoundingClientRect()]:rangeFor(item,start,end).getClientRects();
        for(const rect of rects) {
          if(!rect.width||!rect.height||rect.bottom<0||rect.top>innerHeight)continue;
          const mark=document.createElement('div');mark.style.cssText=`left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          layer.append(mark);
        }
      }
    }
    function repaint() {if(frame===null)frame=requestAnimationFrame(paint);}
    function clear() {
      selection=null;layer.replaceChildren();page.classList.remove('has-document-selection');
      cancelAnimationFrame(frame);frame=null;
    }
    function select(anchor,focus) {
      onSelect();selection={anchor,focus};
      // Focus the document so MathLive cannot retain its independent caret or
      // consume Copy. A DOM range also enables the native Edit > Copy command.
      page.focus({preventScroll:true});
      const span=ordered();if(!span){clear();return;}
      const a=boundary(span.start),b=boundary(span.end),range=document.createRange();
      range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);
      const nativeSelection=window.getSelection();nativeSelection.removeAllRanges();nativeSelection.addRange(range);
      page.classList.add('has-document-selection');paint();
    }
    function hit(x,y) {
      const all=items();if(!all.length)return null;
      const target=document.elementFromPoint(x,y);
      let item=all.find(item=>item.el===target||item.el.contains(target));
      if(!item) {
        // Whitespace between blocks and the document margins are selection space.
        let best=Infinity;
        for(const candidate of all)for(const rect of candidate.el.getClientRects()) {
          const dy=Math.max(rect.top-y,0,y-rect.bottom),dx=Math.max(rect.left-x,0,x-rect.right);
          const distance=dy*dy+dx*dx;
          if(distance<best){best=distance;item=candidate;}
        }
      }
      if(!item)return null;
      const rect=item.el.getBoundingClientRect();
      if(item.mf)return point(item,x<(rect.left+rect.right)/2?0:1);
      const caret=document.caretRangeFromPoint?.(x,y);
      if(caret&&item.el.contains(caret.startContainer)) {
        const range=document.createRange();range.selectNodeContents(item.el);range.setEnd(caret.startContainer,caret.startOffset);
        return point(item,range.toString().length);
      }
      return point(item,y<rect.top||(y<=rect.bottom&&x<rect.left)?0:length(item));
    }
    function copiedText() {
      const span=ordered();if(!span)return null;let result='';
      for(let i=span.first;i<=span.last;i++) {
        const item=span.all[i],start=i===span.first?span.start.offset:0,end=i===span.last?span.end.offset:length(item);
        if(start===end)continue;
        const previous=span.all[i-1];
        const block=item.token.display||['heading','code','raw'].includes(item.token.kind);
        const separate=previous&&(previous.token.display||['heading','code','raw'].includes(previous.token.kind)
          ||previous.el.closest('li,td,.document-algorithm-line')!==item.el.closest('li,td,.document-algorithm-line')
          ||/\\\\(?:\*|\[|\s|$)|\\vspace/.test(source().slice(previous.token.end,item.token.start)));
        if(result&&(block||separate)&&!result.endsWith('\n'))result+='\n';
        result+=item.mf?source().slice(item.token.start,item.token.end):item.el.textContent.slice(start,end);
      }
      return result;
    }
    function stop(event) {event.preventDefault();event.stopImmediatePropagation();}
    function nativeTextPoint(node,offset) {
      const item=items().find(i=>!i.mf&&i.el.contains(node));if(!item)return null;
      const range=document.createRange();range.selectNodeContents(item.el);range.setEnd(node,offset);
      return point(item,range.toString().length);
    }
    function step(p,forward) {
      const all=items();let item=p.item,offset=p.offset,index=all.indexOf(item);
      while(forward?offset===length(item):offset===0) {
        const next=all[index+(forward?1:-1)];if(!next)return point(item,offset);
        item=next;index+=forward?1:-1;offset=forward?0:length(item);
      }
      const text=item.mf?' ':item.el.textContent;
      // Step over a Unicode code point rather than half of a surrogate pair.
      const width=forward?(text.codePointAt(offset)>0xffff?2:1):(/^[\uDC00-\uDFFF]$/.test(text[offset-1])?2:1);
      return point(item,offset+(forward?width:-width));
    }
    document.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      if(!page.contains(event.target)){clear();drag=null;return;}
      const at=hit(event.clientX,event.clientY);if(!at)return;
      if(event.shiftKey) {
        let anchor=selection?.anchor;
        if(!anchor) {
          const nativeSelection=window.getSelection();
          const item=items().find(i=>!i.mf&&i.el.contains(nativeSelection?.anchorNode));
          if(item) {const range=document.createRange();range.selectNodeContents(item.el);range.setEnd(nativeSelection.anchorNode,nativeSelection.anchorOffset);anchor=point(item,range.toString().length);}
          else {const math=items().find(i=>i.mf===document.activeElement);if(math)anchor=point(math,0);}
        }
        if(anchor&&anchor.item!==at.item){stop(event);select(anchor,at);drag=null;return;}
      }
      clear();drag={anchor:at,x:event.clientX,y:event.clientY,id:event.pointerId,target:event.composedPath()[0],crossed:false};
    },true);
    document.addEventListener('pointermove',event=>{
      // WKWebView can report buttons=0 during a native mouse drag. Track
      // the gesture from pointerdown to pointerup instead of that bitmask.
      if(!drag||event.pointerId!==drag.id)return;
      const at=hit(event.clientX,event.clientY);if(!at)return;
      if(!drag.crossed&&(at.item===drag.anchor.item||Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<4))return;
      if(!drag.crossed) {
        drag.crossed=true;
        // End MathLive's own drag before taking ownership across editor roots.
        drag.target.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,composed:true,pointerId:drag.id}));
        if(drag.target.hasPointerCapture?.(drag.id))drag.target.releasePointerCapture(drag.id);
      }
      stop(event);
      const forward=items().indexOf(at.item)>=items().indexOf(drag.anchor.item);
      const anchor=drag.anchor.item.mf?point(drag.anchor.item,forward?0:1):drag.anchor;
      const focus=at.item.mf?point(at.item,forward?1:0):at;
      select(anchor,focus);
      if(event.clientY<24)window.scrollBy(0,-20);
      else if(event.clientY>innerHeight-24)window.scrollBy(0,20);
    },true);
    window.addEventListener('blur',()=>{drag=null;});
    document.addEventListener('pointerup',event=>{if(drag?.crossed)stop(event);drag=null;},true);
    document.addEventListener('pointercancel',event=>{if(drag&&!drag.crossed)drag=null;},true);
    document.addEventListener('copy',event=>{
      const text=copiedText();if(text===null)return;
      if(event.clipboardData){event.clipboardData.setData('text/plain',text);stop(event);}
    },true);
    // Document selections are for selection/copy. Never let a native edit splice
    // multiple independent editing hosts behind the source buffer's back.
    for(const name of ['beforeinput','cut','paste'])document.addEventListener(name,event=>{if(selection)stop(event);},true);
    document.addEventListener('keydown',event=>{
      if(!page.contains(event.target)&&event.target!==page)return;
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a') {
        const all=items();if(!all.length)return;stop(event);select(point(all[0],0),point(all.at(-1),length(all.at(-1))));return;
      }
      if(event.shiftKey&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&['ArrowLeft','ArrowRight'].includes(event.key)) {
        const forward=event.key==='ArrowRight';let anchor=selection?.anchor,focus=selection?.focus;
        if(!selection) {
          const s=window.getSelection();
          anchor=nativeTextPoint(s?.anchorNode,s?.anchorOffset);focus=nativeTextPoint(s?.focusNode,s?.focusOffset);
          const math=items().find(item=>item.mf===document.activeElement);
          if(math) {
            if(math.mf.position!==(forward?math.mf.lastOffset:0))return;
            anchor=point(math,forward?0:1);focus=point(math,forward?1:0);
          }
        }
        if(anchor&&focus) {
          const next=step(focus,forward);
          if(selection||next.item!==anchor.item){stop(event);select(anchor,next);return;}
        }
      }
      if(!selection)return;
      if(event.key==='Escape'){stop(event);clear();window.getSelection()?.removeAllRanges();return;}
      if(event.key.startsWith('Arrow')&&!event.shiftKey) {
        const span=ordered(),edge=['ArrowLeft','ArrowUp'].includes(event.key)?span.start:span.end;
        stop(event);clear();const item=edge.item;
        if(item.mf){item.mf.focus();item.mf.position=edge.offset?item.mf.lastOffset:0;}
        else {item.el.focus();const at=boundary(edge),range=document.createRange();range.setStart(at.node,at.offset);range.collapse(true);const s=window.getSelection();s.removeAllRanges();s.addRange(range);}
      } else if(!event.metaKey&&!event.ctrlKey&&!event.altKey)stop(event);
    },true);
    window.addEventListener('scroll',repaint,{passive:true});window.addEventListener('resize',repaint);
    return {clear,copyText:copiedText,selectAll(){const all=items();if(all.length)select(point(all[0],0),point(all.at(-1),length(all.at(-1))));}};
  }
};
