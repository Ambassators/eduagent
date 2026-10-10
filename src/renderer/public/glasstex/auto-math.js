(() => {
"use strict";
// Conservative prose triggers. Offsets use UTF-16, like DOM Range and SourceBuffer.
const templates = {
  sqrt:'\\sqrt{\\placeholder{}}', frac:'\\frac{\\placeholder{}}{\\placeholder{}}',
  sum:'\\sum_{\\placeholder{}}^{\\placeholder{}}', prod:'\\prod_{\\placeholder{}}^{\\placeholder{}}',
  int:'\\int_{\\placeholder{}}^{\\placeholder{}}', lim:'\\lim_{x\\to\\placeholder{}}',
  infty:'\\infty', alpha:'\\alpha', beta:'\\beta', gamma:'\\gamma',
  delta:'\\delta', theta:'\\theta', lambda:'\\lambda', sigma:'\\sigma', omega:'\\omega', pi:'\\pi',
};
const unicode = {'√':'sqrt','∑':'sum','∏':'prod','∫':'int','∞':'infty','π':'pi'};

// Accept a small arithmetic grammar, rejecting prose words and separated words such as "a b".
function arithmetic(text, unfinished=false) {
  const parts=text.match(/\d+(?:\.\d+)?|[A-Za-z]|[()+\-*/=<>]|\s+/g);
  if(!parts || parts.join('')!==text || /[A-Za-z]{2}|[A-Za-z0-9)]\s+[A-Za-z0-9(]/.test(text))return false;
  const ts=parts.filter(t=>!/^\s+$/.test(t));let i=0;
  function atom() {
    if(ts[i]==='+'||ts[i]==='-')i++;
    if(ts[i]==='('){i++;if(!expression()||ts[i++]!==')')return false;return true;}
    if(/^(?:\d+(?:\.\d+)?|[A-Za-z])$/.test(ts[i]||'')){i++;return true;}
    return false;
  }
  function expression() {
    if(!atom())return false;
    while(i<ts.length&&ts[i]!==')') {
      if(/^[+\-*/=<>]$/.test(ts[i])) {
        i++;if(unfinished&&i===ts.length)return true;
      }
      if(!atom())return false;
    }
    return true;
  }
  return expression()&&i===ts.length;
}
function mathSuffix(text, unfinished=false) {
  const limit=Math.max(0,text.length-256,text.lastIndexOf('\n')+1);
  for(let start=limit;start<text.length;start++) {
    if(start>0&&!/[\s:;,!?]/.test(text[start-1]))continue;
    if(/\s/.test(text[start]))continue;
    const value=text.slice(start).trimEnd();
    if(arithmetic(value,unfinished))return {start,ascii:value};
  }
  return null;
}

function detectAutoMath(text, caret, enabled=true) {
  if(!Number.isInteger(caret)||caret<0||caret>text.length)return null;
  const before=text.slice(0,caret), after=text.slice(caret);
  // fn is an explicit shortcut, independent of automatic recognition.
  const fn=/(^|[\s([{,:;])fn$/.exec(before);
  if(fn&&!/[\p{L}\p{N}_]/u.test(after[0]||''))
    return {start:caret-2,end:caret,ascii:'',latex:'',delay:false};
  if(!enabled)return null;
  const script=/(\\?[_^]|[=≤≥≠×])$/.exec(before);
  if(script) {
    const left=before.slice(0,-script[0].length), base=mathSuffix(left);
    if(!base&&left&&!/[\s([{,:;]$/.test(left))return null;
    const op=script[1].replace('\\','');
    if(!base&&!['^','_'].includes(op))return null;
    const latex=['^','_'].includes(op)?`${base?'':'\\placeholder{}'}${op}{\\placeholder{}}`
      :({'≤':'\\le ','≥':'\\ge ','≠':'\\ne ','×':'\\times '}[op]||op)+'\\placeholder{}';
    return {start:base?.start??left.length,end:caret,ascii:base?.ascii||'',latex,
      script:['^','_'].includes(op)?op:null,delay:false};
  }
  const word=/(\\?[a-z]+)([ (]?)$/.exec(before);
  const symbol=unicode[before.at(-1)];
  let name=symbol, start=caret-1, delay=false;
  if(!symbol) {
    if(!word)return null;
    name=word[1].replace('\\','');start=word.index;
    if(start>0&&/[\p{L}\p{N}_\\/.:@-]/u.test(before[start-1]))return null;
    if(!word[2]&&/[\p{L}\p{N}_]/u.test(after[0]||''))return null;
    delay=!word[2];
  }
  let latex=templates[name];
  if(!latex&&word?.[2]==='('&&['sin','cos','tan','log','ln','exp'].includes(name))
    latex=`\\${name}(\\placeholder{})`;
  if(!latex)return null;
  const left=before.slice(0,start);
  const base=/[+\-*/=<>]\s*$/.test(left)?mathSuffix(left,true):null;
  return {start:base?.start??start,end:caret,ascii:base?.ascii||'',latex,delay};
}

window.AutoMath = {detectAutoMath};
})();
