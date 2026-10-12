(() => {
"use strict";
/** Lossless range scanner, not a TeX interpreter. All offsets are UTF-16. */
const MATH_ENVIRONMENTS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math'
]);
const VERBATIM = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment']);
const FONT_DECLARATIONS = {bf:'textbf',bfseries:'textbf',it:'textit',itshape:'textit',em:'emph',tt:'texttt',ttfamily:'texttt',rm:'textrm',rmfamily:'textrm',sf:'textsf',sffamily:'textsf',normalfont:'textrm'};
const FONT_SIZES = new Set(['tiny','scriptsize','footnotesize','small','normalsize','large','Large','LARGE','huge','Huge']);
// Argument-free text commands that typeset a fixed string.
const LITERALS = {LaTeX:'LaTeX',TeX:'TeX',Return:'return',True:'true',False:'false',ldots:'…',dots:'…',textellipsis:'…',textendash:'–',textemdash:'—'};
const SKIPS = {smallskip:'3pt',medskip:'6pt',bigskip:'12pt'};
const BLANK_LINE = /\n[ \t]*\r?\n/y;

/** The inline or display math delimiter opening at i, if any. */
function mathDelimiter(s, i) {
  if (escaped(s, i)) return null;
  if (s.startsWith('\\[', i)) return {open:'\\[', close:'\\]', display:true};
  if (s.startsWith('\\(', i)) return {open:'\\(', close:'\\)', display:false};
  if (s.startsWith('$$', i)) return {open:'$$', close:'$$', display:true};
  if (s[i] === '$') return {open:'$', close:'$', display:false};
  return null;
}

// Parse the standard algpseudocode statements, without expanding package macros.
// Unrecognized or unbalanced control flow keeps the entire environment as source.
function algorithmLines(source, start, end) {
  const controls = {While:['while','do','While'],If:['if','then','If'],For:['for','do','For'],ForAll:['for all','do','For'],Loop:['loop','','Loop'],Repeat:['repeat','','Repeat']};
  const endings = {EndWhile:['end while','While'],EndIf:['end if','If'],EndFor:['end for','For'],EndLoop:['end loop','Loop'],Until:['until','Repeat']};
  const names = new Set(['State','Statex','Require','Ensure','Else','ElsIf',...Object.keys(controls),...Object.keys(endings)]);
  const markers=[];
  for(let i=start;i<end;i++) {
    if(source[i]==='%'&&!escaped(source,i)){i=commentEnd(source,i,end)-1;continue;}
    if(escaped(source,i))continue;
    if(source[i]==='{'){const g=balanced(source,i);if(!g||g.after>end)return null;i=g.after-1;continue;}
    const delimiter=mathDelimiter(source,i);
    if(delimiter){const at=closingDelimiter(source,i+delimiter.open.length,delimiter.close,end);if(at<0)return null;i=at+delimiter.close.length-1;continue;}
    const command=/^\\([A-Za-z]+)/.exec(source.slice(i));
    if(command&&names.has(command[1])){markers.push({start:i,after:i+command[0].length,name:command[1]});i+=command[0].length-1;}
  }
  const trivia=s=>!s.replace(/%[^\n]*(?:\n|$)/g,'').trim();
  if(!markers.length||!trivia(source.slice(start,markers[0].start)))return null;
  // Each open control structure, with the index of its first row. Every row of
  // one structure (While … EndWhile, If … Else … EndIf) shares that group.
  const stack=[],rows=[];let number=0;
  for(let i=0;i<markers.length;i++) {
    const m=markers[i],limit=markers[i+1]?.start??end;
    let contentStart=m.after,contentEnd=limit,prefix='',suffix='',indent=stack.length,group=null;
    while(/\s/.test(source[contentStart]||'')&&contentStart<limit)contentStart++;
    if(endings[m.name]){const [label,expected]=endings[m.name],open=stack.pop();if(open?.name!==expected)return null;prefix=label;indent=stack.length;group=open.group;}
    if(m.name==='Else'||m.name==='ElsIf'){if(stack.at(-1)?.name!=='If')return null;indent--;prefix=m.name==='Else'?'else':'else if';suffix=m.name==='ElsIf'?'then':'';group=stack.at(-1).group;}
    if(controls[m.name]){[prefix,suffix]=controls[m.name];group=rows.length;stack.push({name:controls[m.name][2],group});}
    const hasArgument=['While','If','For','ForAll','ElsIf','Until'].includes(m.name);
    if(hasArgument){const arg=balanced(source,contentStart);if(!arg||arg.after>limit||!trivia(source.slice(arg.after,limit)))return null;contentStart=arg.start;contentEnd=arg.end;}
    else if(m.name!=='State'&&m.name!=='Statex'&&m.name!=='Require'&&m.name!=='Ensure'){
      if(!trivia(source.slice(contentStart,limit)))return null;contentEnd=contentStart;
    } else {
      contentEnd=limit-source.slice(contentStart,limit).match(/\s*$/)[0].length;
      // An empty statement is edited right after its command, not at the next line's start.
      if(contentStart===contentEnd)contentStart=contentEnd=m.after;
      if(m.name==='Require')prefix='Require:';
      if(m.name==='Ensure')prefix='Ensure:';
    }
    const numbered=!['Statex','Require','Ensure'].includes(m.name);
    if(numbered)number++;
    rows.push({...m,end:limit,contentStart,contentEnd,prefix,suffix,indent,group,editableContent:hasArgument||['State','Statex','Require','Ensure'].includes(m.name),number:numbered?number:null});
  }
  return stack.length?null:rows;
}
function escaped(s, i) {
  let n = 0; while (i > 0 && s[--i] === '\\') n++;
  return n % 2 === 1;
}
function commentEnd(s, i, end = s.length) {
  const p = s.indexOf('\n', i); return p < 0 ? end : Math.min(end, p + 1);
}
function balanced(s, start, open = '{', close = '}') {
  if (s[start] !== open) return null;
  let depth = 1;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '%' && !escaped(s, i)) { i = commentEnd(s, i) - 1; continue; }
    if (escaped(s, i)) continue;
    if (s[i] === open) depth++;
    if (s[i] === close) {
      depth--;
      if (depth === 0) return { start: start + 1, end: i, after: i + 1 };
    }
  }
  return null;
}
function skipVerb(s, i) {
  const m = /^\\verb\*?([^A-Za-z\s])/.exec(s.slice(i));
  if (!m) return null;
  const end = s.indexOf(m[1], i + m[0].length);
  return end < 0 ? commentEnd(s, i) : end + 1;
}
function environmentEnd(s, start, name, end = s.length) {
  const close = `\\end{${name}}`;
  if (VERBATIM.has(name)) {
    const p = s.indexOf(close, start);
    return p >= 0 && p < end ? { start: p, end: p + close.length } : null;
  }
  let depth = 1;
  for (let i = start; i < end; i++) {
    if (s[i] === '%' && !escaped(s, i)) { i = commentEnd(s, i, end) - 1; continue; }
    if (s[i] !== '\\' || escaped(s, i)) continue;
    const verb = skipVerb(s, i);
    if (verb) { i = verb - 1; continue; }
    const m = /^\\(begin|end)\{([^}]+)\}/.exec(s.slice(i));
    if (!m) continue;
    if (m[1] === 'begin' && VERBATIM.has(m[2])) {
      const v = environmentEnd(s, i + m[0].length, m[2], end);
      if (v) i = v.end - 1;
      continue;
    }
    if (m[2] === name) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (!depth) return { start: i, end: i + m[0].length };
    }
    i += m[0].length - 1;
  }
  return null;
}
function bodyRange(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && !escaped(s, i)) { i = commentEnd(s, i) - 1; continue; }
    if (s[i] !== '\\' || escaped(s, i)) continue;
    const verb = skipVerb(s, i); if (verb) { i = verb - 1; continue; }
    const m = /^\\begin\{([^}]+)\}/.exec(s.slice(i));
    if (!m) continue;
    if (m[1] === 'document') {
      const close = environmentEnd(s, i + m[0].length, 'document');
      return { start: i + m[0].length, end: close ? close.start : s.length, wrapped: true };
    }
    if (VERBATIM.has(m[1])) {
      const close = environmentEnd(s, i + m[0].length, m[1]);
      if (close) i = close.end - 1;
    }
  }
  return { start: s.charCodeAt(0) === 0xfeff ? 1 : 0, end: s.length, wrapped: false };
}
function closingDelimiter(s, start, delimiter, end) {
  let braces = 0;
  for (let i = start; i < end; i++) {
    if (s[i] === '%' && !escaped(s, i)) { i = commentEnd(s, i, end) - 1; continue; }
    if (escaped(s, i)) continue;
    if (s[i] === '{') braces++;
    if (s[i] === '}') braces = Math.max(0, braces - 1);
    if (braces === 0 && s.startsWith(delimiter, i)) {
      if (delimiter === '$' && s[i + 1] === '$') { i++; continue; }
      return i;
    }
  }
  return -1;
}
// A bounded subset of tabular: l/c/r columns with optional | rules, \hline rules
// between rows, and ordinary cells, including math. Other column types and
// spanning or partial rules stay as an intact source block.
function simpleTable(source, start, end) {
  while (/\s/.test(source[start] || '') && start < end) start++;
  const spec = balanced(source, start);
  if (!spec || spec.after > end) return null;
  const layout = source.slice(spec.start, spec.end).replace(/\s/g, '');
  if (!/^\|*(?:[lcr]\|*){1,32}$/.test(layout)) return null;
  const columns = layout.replace(/\|/g, '');
  // rules[i] counts the vertical rules before column i; rules[n] follows the last.
  const rules = layout.split(/[lcr]/).map(bars => bars.length);
  // \hline runs at a row boundary belong to the row (or table end) that follows.
  const hlines = at => {
    let count = 0;
    for (let m; (m = /^\s*\\hline(?![A-Za-z])/.exec(source.slice(at, end))); count++) at += m[0].length;
    return {after:at, count};
  };
  const rows = [];
  let above = hlines(spec.after), rowStart = spec.after, cellStart = above.after, cells = [];
  for (let i = cellStart; i <= end; i++) {
    if (i === end || (!escaped(source, i) && (source[i] === '&' || source.startsWith('\\\\', i)))) {
      if (i === end && !cells.length && !source.slice(cellStart, end).trim()) break;
      const rowEnd = i === end || source.startsWith('\\\\', i);
      const after = i === end ? i : i + (rowEnd ? 2 : 1);
      if (source[after] === '[' && rowEnd && i !== end) return null;
      cells.push({start:cellStart, end:i, after:rowEnd ? i : after});
      if (rowEnd) {
        if (cells.length !== columns.length || rows.length >= 1000) return null;
        rows.push({start:rowStart, end:after, cells, rulesAbove:above.count});
        cells = []; rowStart = after; above = hlines(after);
      }
      cellStart = rowEnd ? above.after : after; i = cellStart - 1;
      if (rowEnd && after === end) break;
      continue;
    }
    if (source[i] === '%' && !escaped(source, i)) { i=commentEnd(source,i,end)-1;continue; }
    if (escaped(source, i)) continue;
    if (source[i] === '{') {
      const group=balanced(source,i);if(!group || group.after>end)return null;
      i=group.after-1;continue;
    }
    if (/^\\(?:hline|cline|multicolumn|multirow|toprule|midrule|bottomrule|noalign|omit|span)\b/.test(source.slice(i))) return null;
    const env=/^\\begin\{([^}]+)\}/.exec(source.slice(i));
    if (env) {
      const close=environmentEnd(source,i+env[0].length,env[1],end);
      if(!close)return null;i=close.end-1;continue;
    }
    const delimiter=mathDelimiter(source,i);
    if(delimiter) {
      const at=closingDelimiter(source,i+delimiter.open.length,delimiter.close,end);
      if(at<0)return null;i=at+delimiter.close.length-1;
    }
  }
  return rows.length ? {start:spec.after, columns:[...columns], rules, rows, rulesBelow:above.count} : null;
}

// Recognize direct, argument-free layout aliases without expanding arbitrary TeX.
// Inspect declarations only in the preamble; comments and grouped definitions
// cannot accidentally turn document commands into layout instructions.
function noIndentAliases(source, body) {
  const aliases = new Set();
  if (!body.wrapped) return aliases;
  for (let i = 0; i < body.start; i++) {
    if (source[i] === '%' && !escaped(source, i)) { i = commentEnd(source, i) - 1; continue; }
    if (escaped(source, i)) continue;
    if (source[i] === '{') { const group = balanced(source, i); if (group) i = group.after - 1; continue; }
    const declaration = /^(?:\\def\s*(\\[A-Za-z]+)|\\(?:newcommand|renewcommand|providecommand)\*?\s*(?:\{(\\[A-Za-z]+)\}|(\\[A-Za-z]+)))\s*(\[[0-9]+\])?\s*/.exec(source.slice(i));
    if (!declaration) continue;
    const name = (declaration[1] || declaration[2] || declaration[3]).slice(1);
    aliases.delete(name);
    const arg = balanced(source, i + declaration[0].length);
    if (arg && arg.after <= body.start) {
      if ((!declaration[4] || declaration[4] === '[0]') && source.slice(arg.start, arg.end).trim() === '\\noindent') aliases.add(name);
      i = arg.after - 1;
    }
  }
  return aliases;
}

function scanDocument(source) {
  const body = bodyRange(source), tokens = [], warnings = [];
  const noIndent = noIndentAliases(source, body);
  let algorithmNumber=0;
  const push = (kind, start, end, more = {}) => tokens.push({
    id: `t${tokens.length}`, kind, start, end, contentStart: start, contentEnd: end, ...more
  });
  // lineStart: TeX is between paragraphs or at a forced line start, where
  // source whitespace has no visible effect. That whitespace is metadata, not
  // prose, so it cannot render as stray indentation or empty lines.
  function scanRange(start, limit, inList = false, depth = 0, inAlgorithm = false, lineStart = true) {
    let cursor = start, plainStart = cursor;
    let declarations=[];
    // Spaces after a control word are skipped; a blank line still ends the paragraph
    // unless TeX is already between paragraphs.
    const skipAfterCommand = at => {
      const rest = source.slice(at, limit);
      return at + (lineStart ? /^\s*/ : /^[ \t]*(?:\r?\n(?![ \t]*\r?\n)[ \t]*)?/).exec(rest)[0].length;
    };
    const flush = end => {
      if (end > plainStart) {
        const text = source.slice(plainStart, end);
        // Unknown source is never flattened into a lossy rich-text approximation.
        const raw = /\\(?![%$&#_{} ]|textbackslash\{\}|textasciitilde\{\}|textasciicircum\{\})/.test(text);
        push(raw ? 'raw' : 'text', plainStart, end);
      }
    };
    while (cursor < limit) {
      const c = source[cursor];
      if (lineStart && cursor === plainStart && /\s/.test(c)) {
        const after = cursor + /^\s+/.exec(source.slice(cursor, limit))[0].length;
        push('metadata', cursor, after); cursor = plainStart = after; continue;
      }
      if (c === '{' && !escaped(source, cursor) && depth < 64) {
        let group = balanced(source, cursor);
        // A common imported-document error is an unclosed {\large ... group.
        // Recover only this recognizable declaration group, retaining its bytes.
        if ((!group || group.after > limit) && body.wrapped) {
          const declaration = /^\s*\\([A-Za-z]+)/.exec(source.slice(cursor + 1, limit));
          if (declaration && (FONT_SIZES.has(declaration[1]) || FONT_DECLARATIONS[declaration[1]])) {
            group = {start:cursor + 1, end:limit, after:limit};
            warnings.push('Unclosed font group; preview extends it to the end of its container. Source is unchanged.');
          }
        }
        if (group && group.after <= limit) {
          flush(cursor);
          push('formatStart', cursor, group.start, {format:'group'});
          lineStart = scanRange(group.start, group.end, inList, depth + 1, inAlgorithm, lineStart);
          push('formatEnd', group.end, group.after);
          cursor = plainStart = group.after; continue;
        }
      }
      if (c === '%' && !escaped(source, cursor)) {
        flush(cursor); const end = commentEnd(source, cursor, limit);
        push('comment', cursor, end); cursor = plainStart = end;
        // A comment ends its source line. TeX skips the next line's indentation,
        // and an empty next line ends the paragraph.
        if (!lineStart && end < limit && source[end - 1] === '\n') {
          const indent = /^[ \t]*/.exec(source.slice(end, limit))[0].length;
          if (/^\r?\n/.test(source.slice(end + indent, limit))) {
            const after = end + /^\s*/.exec(source.slice(end, limit))[0].length;
            push('linebreak', end, after, {spacing:'0px'}); lineStart = true; cursor = plainStart = after;
          } else if (indent) { push('metadata', end, end + indent); cursor = plainStart = end + indent; }
        }
        continue;
      }
      if (c === '\\' && !escaped(source, cursor)) {
        // Text escapes are prose; their {} must not be split off as a group.
        const textEscape = /^\\(?:textbackslash|textasciitilde|textasciicircum)\{\}/.exec(source.slice(cursor, limit));
        if (textEscape) { lineStart = false; cursor += textEscape[0].length; continue; }
        const layoutCommand = /^\\([A-Za-z]+)[ \t]*/.exec(source.slice(cursor));
        if (layoutCommand && (layoutCommand[1] === 'noindent' || noIndent.has(layoutCommand[1]))) {
          flush(cursor); const after = skipAfterCommand(cursor + layoutCommand[0].length);
          push('metadata', cursor, after); cursor = plainStart = after; continue;
        }
        // Vertical space and page breaks end the line: the surrounding whitespace
        // and paragraph breaks belong to them rather than rendering as empty lines.
        const verticalBreak = (kind, end, more) => {
          let from = cursor - /\s*$/.exec(source.slice(plainStart, cursor))[0].length;
          if (escaped(source, from)) from++;
          flush(from); lineStart = true;
          const after = skipAfterCommand(end);
          push(kind, from, after, more);
          cursor = plainStart = after;
        };
        const vspace = /^\\vspace\*?\s*/.exec(source.slice(cursor));
        if (vspace) {
          const arg = balanced(source, cursor + vspace[0].length);
          if (arg && arg.after <= limit) {
            const dimension = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(em|ex|pt|px|cm|mm|in|pc)$/.exec(source.slice(arg.start, arg.end).trim());
            if (dimension && Math.abs(Number(dimension[1])) <= 1000) {
              verticalBreak('spacing', arg.after, {spacing:Number(dimension[1]) + dimension[2]}); continue;
            }
            flush(cursor); push('raw', cursor, arg.after); lineStart = false;
            cursor = plainStart = arg.after; continue;
          }
        }
        const skip = /^\\(smallskip|medskip|bigskip)(?![A-Za-z])/.exec(source.slice(cursor));
        if (skip) { verticalBreak('spacing', cursor + skip[0].length, {spacing:SKIPS[skip[1]]}); continue; }
        const pageBreak = /^\\(?:newpage|clearpage|cleardoublepage|pagebreak(?:\s*\[[0-4]\])?)(?![A-Za-z])/.exec(source.slice(cursor));
        if (pageBreak) { verticalBreak('pagebreak', cursor + pageBreak[0].length); continue; }
        const declaration=/^\\([A-Za-z]+)(?![A-Za-z])[ \t]*/.exec(source.slice(cursor));
        if(declaration&&(FONT_SIZES.has(declaration[1])||FONT_DECLARATIONS[declaration[1]])) {
          flush(cursor);
          const format=FONT_SIZES.has(declaration[1])?'size-'+declaration[1]:FONT_DECLARATIONS[declaration[1]];
          const family=format.startsWith('size-')?'size':'font';
          for(let i=declarations.length;i>0;i--)push('formatEnd',cursor,cursor);
          declarations=declarations.filter(d=>d.family!==family);
          for(const d of declarations)push('formatStart',cursor,cursor,{format:d.format});
          const after=skipAfterCommand(cursor+declaration[0].length);
          push('formatStart',cursor,after,{format});declarations.push({format,family});
          cursor=plainStart=after;continue;
        }
        const metadata=/^\\(?:pagestyle|thispagestyle)\s*\{[^{}]*\}/.exec(source.slice(cursor));
        if(metadata){flush(cursor);const after=cursor+metadata[0].length;push('metadata',cursor,after);cursor=plainStart=after;continue;}
        const literal=/^\\([A-Za-z]+)(?![A-Za-z])(?:\{\})?/.exec(source.slice(cursor));
        if(literal&&Object.hasOwn(LITERALS,literal[1])){flush(cursor);lineStart=false;const after=cursor+literal[0].length;push('literal',cursor,after,{text:LITERALS[literal[1]]});cursor=plainStart=after;continue;}
        const caption=inAlgorithm&&/^\\caption\s*/.exec(source.slice(cursor));
        if(caption&&depth<64){const arg=balanced(source,cursor+caption[0].length);if(arg&&arg.after<=limit){flush(cursor);lineStart=false;push('blockStart',cursor,arg.start,{environment:'algorithm-caption',label:`Algorithm ${algorithmNumber}`});scanRange(arg.start,arg.end,false,depth+1);push('blockEnd',arg.end,arg.after);cursor=plainStart=arg.after;continue;}}
        const linebreak = /^(?:\\\\\*?|\\newline(?![A-Za-z]))/.exec(source.slice(cursor));
        if (linebreak) {
          let after = cursor + linebreak[0].length, spacing = '0px', supported = true;
          if (source[after] === '[' && linebreak[0].startsWith('\\\\')) {
            const option = balanced(source, after, '[', ']');
            if (option && option.after <= limit) {
              const value = source.slice(option.start, option.end).trim();
              supported = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|pt|px|cm|mm|in|pc)$/.test(value) && parseFloat(value) <= 1000;
              if (supported) spacing = value.replace(/^\+/, '');
              after = option.after;
            } else supported = false;
          }
          flush(cursor);
          // \\ looks ahead past spaces for * and [; the next line starts after them.
          lineStart = supported;
          if (supported) after = skipAfterCommand(after);
          push(supported ? 'linebreak' : 'raw', cursor, after, {spacing});
          cursor = plainStart = after; continue;
        }
        const verb = skipVerb(source, cursor);
        if (verb) {
          flush(cursor); push('raw', cursor, verb); lineStart = false; cursor = plainStart = verb; continue;
        }
        const env = /^\\begin\{([^}]+)\}/.exec(source.slice(cursor));
        if (env && env[1] !== 'document') {
          const close = environmentEnd(source, cursor + env[0].length, env[1], limit);
          if (close) {
            // Every environment except inline math renders as its own block.
            flush(cursor); lineStart = env[1] !== 'math';
            if(['algorithm','algorithmic'].includes(env[1])&&depth<64) {
              let inner=cursor+env[0].length,options='';
              const optionAt=inner+source.slice(inner,close.start).match(/^\s*/)[0].length;
              if(source[optionAt]==='['){const opt=balanced(source,optionAt,'[',']');if(opt&&opt.after<=close.start){options=source.slice(opt.start,opt.end);inner=opt.after;}}
              const rows=env[1]==='algorithmic'?algorithmLines(source,inner,close.start):null;
              if(env[1]==='algorithm'||rows) {
                if(env[1]==='algorithm')algorithmNumber++;
                push('blockStart',cursor,inner,{environment:env[1]});
                if(rows){
                  if(rows[0].start>inner)push('metadata',inner,rows[0].start);
                  const frequency=/^\d+$/.test(options.trim())?Number(options):0;
                  for(const row of rows){
                    // command and group let editing remove a statement without
                    // unbalancing the control structure it sits in.
                    push('blockStart',row.start,row.contentStart,{environment:'algorithm-line',command:row.name,group:row.group===null?null:`${cursor}:${row.group}`,indent:row.indent,lineNumber:frequency&&row.number&&row.number%frequency===0?row.number:null,prefix:row.prefix,suffix:row.suffix,editableContent:row.editableContent});
                    scanRange(row.contentStart,row.contentEnd,false,depth+1);
                    push('blockEnd',row.contentEnd,row.end);
                  }
                } else scanRange(inner,close.start,false,depth+1,true);
                push('blockEnd',close.start,close.end);cursor=plainStart=close.end;continue;
              }
            }
            if (env[1] === 'tabular' && depth < 64) {
              const table=simpleTable(source,cursor+env[0].length,close.start);
              if(table) {
                push('tableStart',cursor,table.start,{columns:table.columns,rules:table.rules});
                for(const row of table.rows) {
                  push('tableRowStart',row.start,row.cells[0].start,{rulesAbove:row.rulesAbove});
                  row.cells.forEach((cell,index)=>{
                    const text=source.slice(cell.start,cell.end);
                    // Text typed into a blank cell goes after one separating space: "& x &".
                    const first=text.trim()?cell.start+text.length-text.trimStart().length:cell.start+Math.min(1,text.length);
                    const last=Math.max(first,cell.end-(text.length-text.trimEnd().length));
                    push('tableCellStart',cell.start,first,{alignment:table.columns[index]});
                    if(first===last)push('text',first,last);
                    else scanRange(first,last,false,depth+1);
                    push('tableCellEnd',last,cell.after);
                  });
                  push('tableRowEnd',row.cells.at(-1).after,row.end);
                }
                push('tableEnd',table.rows.at(-1).end,close.end,{rulesBelow:table.rulesBelow});
                cursor=plainStart=close.end;continue;
              }
            }
            if (['center','flushleft','flushright','quote'].includes(env[1]) && depth < 64) {
              push('blockStart', cursor, cursor + env[0].length, {environment:env[1]});
              scanRange(cursor + env[0].length, close.start, false, depth + 1);
              push('blockEnd', close.start, close.end);
              cursor = plainStart = close.end; continue;
            }
            if (['enumerate','itemize','description'].includes(env[1]) && depth < 64) {
              let inner = cursor + env[0].length, options = '';
              let optionStart = inner;
              while (/\s/.test(source[optionStart] || '') && optionStart < close.start) optionStart++;
              if (source[optionStart] === '[') {
                const option = balanced(source, optionStart, '[', ']');
                if (option && option.after <= close.start) { options = source.slice(option.start, option.end); inner = option.after; }
              }
              push('listStart', cursor, inner, {environment:env[1], options});
              scanRange(inner, close.start, true, depth + 1);
              push('listEnd', close.start, close.end);
              cursor = plainStart = close.end; continue;
            }
            if (['lstlisting','verbatim','verbatim*'].includes(env[1])) {
              let contentStart = cursor + env[0].length, options = '';
              if (env[1] === 'lstlisting') {
                let optionStart = contentStart;
                while (/[ \t]/.test(source[optionStart] || '') && optionStart < close.start) optionStart++;
                if (source[optionStart] === '[') {
                  const option = balanced(source, optionStart, '[', ']');
                  if (option && option.after <= close.start) { contentStart = option.after; options = source.slice(option.start, option.end); }
                }
              }
              // Keep the environment's boundary newlines outside editable code.
              const openingLine = /^[ \t]*(?:\r\n|\n)/.exec(source.slice(contentStart, close.start));
              if (openingLine) contentStart += openingLine[0].length;
              let contentEnd = close.start;
              const closingLine = /(?:\r\n|\n)[ \t]*$/.exec(source.slice(contentStart, contentEnd));
              if (closingLine) contentEnd -= closingLine[0].length;
              push('code', cursor, close.end, {contentStart,contentEnd,environment:env[1],options});
              cursor = plainStart = close.end; continue;
            }
            const math = MATH_ENVIRONMENTS.has(env[1]);
            // alignat has an extra argument: source mode is safer than guessing columns.
            const editableMath = math && !env[1].startsWith('alignat');
            push(editableMath ? 'math' : 'raw', cursor, close.end, {
              contentStart: editableMath ? cursor + env[0].length : cursor,
              contentEnd: editableMath ? close.start : close.end,
              display: env[1] !== 'math', environment: env[1]
            });
            cursor = plainStart = close.end; continue;
          }
          warnings.push(`Unclosed ${env[1]} environment; retained as source.`);
        }
        const item = inList && /^\\item(?![A-Za-z])/.exec(source.slice(cursor));
        if (item) {
          flush(cursor);
          let after = cursor + item[0].length, label = null, labelStart = after;
          while (/\s/.test(source[labelStart] || '') && labelStart < limit) labelStart++;
          if (source[labelStart] === '[') {
            const option = balanced(source, labelStart, '[', ']');
            if (option && option.after <= limit) { label = source.slice(option.start, option.end); after = option.after; }
          }
          // The separator belongs to the command, so deleting item text cannot make \\itemword.
          after += /^\s*/.exec(source.slice(after,limit))[0].length;
          push('listItem', cursor, after, {label}); lineStart = true; cursor = plainStart = after; continue;
        }
        const format = /^\\(textbf|textit|emph|texttt|textrm|textsf|underline|textsuperscript|textsubscript)(?![A-Za-z])\s*/.exec(source.slice(cursor));
        if (format && depth < 64) {
          const arg = balanced(source, cursor + format[0].length);
          if (arg && arg.after <= limit) {
            flush(cursor);
            push('formatStart', cursor, arg.start, {format:format[1]});
            lineStart = scanRange(arg.start, arg.end, false, depth + 1, false, lineStart);
            push('formatEnd', arg.end, arg.after);
            cursor = plainStart = arg.after; continue;
          }
        }
        const heading = /^\\(section|subsection|subsubsection|chapter|paragraph)\*?/.exec(source.slice(cursor));
        if (heading) {
          let argStart = cursor + heading[0].length;
          while (/\s/.test(source[argStart] || '') && argStart < limit) argStart++;
          if (source[argStart] === '[') { const opt = balanced(source, argStart, '[', ']'); if (opt) argStart = opt.after; }
          const arg = balanced(source, argStart);
          if (arg && arg.after <= limit) {
            flush(cursor); lineStart = true;
            const content = source.slice(arg.start, arg.end);
            const simple = !/\\(?![%$&#_{} ])|[$^]/.test(content);
            push(simple ? 'heading' : 'raw', cursor, arg.after, {
              contentStart: simple ? arg.start : cursor, contentEnd: simple ? arg.end : arg.after,
              level: ['chapter', 'section'].includes(heading[1]) ? 1 : heading[1] === 'subsection' ? 2 : 3
            });
            cursor = plainStart = arg.after; continue;
          }
        }
      }
      const delimiter = mathDelimiter(source, cursor);
      if (delimiter) {
        const {open, close, display} = delimiter;
        const p = closingDelimiter(source, cursor + open.length, close, limit);
        if (p >= 0) {
          // TeX ignores the spaces after a display; the next line starts below it.
          flush(cursor); lineStart = display;
          push('math', cursor, p + close.length, {contentStart: cursor + open.length, contentEnd: p, display, delimiter: open});
          cursor = plainStart = p + close.length; continue;
        }
        warnings.push(`Unclosed ${open} delimiter; retained as text.`);
        // Consume both characters of an unmatched $$ instead of reinterpreting the second $.
        lineStart = false; cursor += open.length; continue;
      }
      if (!/\s/.test(c)) lineStart = false;
      // A blank line ends the paragraph: what follows starts a new line.
      else if (c === '\n') { BLANK_LINE.lastIndex = cursor; if (BLANK_LINE.test(source) && BLANK_LINE.lastIndex <= limit) lineStart = true; }
      cursor++;
    }
    flush(limit);
    for(let i=declarations.length;i>0;i--)push('formatEnd',limit,limit);
    return lineStart;
  }
  scanRange(body.start, body.end);
  return { tokens, body, warnings: [...new Set(warnings)] };
}
function mathForField(token, source) {
  const content = source.slice(token.contentStart, token.contentEnd).trim();
  if (/^align/.test(token.environment || '')) return `\\begin{aligned}${content}\\end{aligned}`;
  if (/^(gather|multline)/.test(token.environment || '')) return `\\begin{gathered}${content}\\end{gathered}`;
  return content;
}
function mathFromField(token, latex) {
  const env = /^align/.test(token.environment || '') ? 'aligned'
    : /^(gather|multline)/.test(token.environment || '') ? 'gathered' : null;
  if (env) {
    const prefix = `\\begin{${env}}`, suffix = `\\end{${env}}`;
    const value = latex.trim();
    if (value.startsWith(prefix) && value.endsWith(suffix)) return value.slice(prefix.length, -suffix.length);
  }
  return latex;
}
function sourcePatch(source, start, end, replacement, revision) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length)
    throw new Error('Invalid source range');
  return { start, end, expected: source.slice(start, end), replacement, revision };
}
function applyPatch(source, patch, revision) {
  if (patch.revision !== revision) throw new Error('Stale revision');
  if (patch.start < 0 || patch.end < patch.start || patch.end > source.length) throw new Error('Invalid range');
  if (source.slice(patch.start, patch.end) !== patch.expected) throw new Error('Source mismatch');
  return source.slice(0, patch.start) + patch.replacement + source.slice(patch.end);
}
function decodeText(source) {
  return source.replace(/\\(?:textbackslash\{\}|textasciitilde\{\}|textasciicircum\{\}|[%$&#_{} ])/g,
    c => ({'\\textbackslash{}':'\\','\\textasciitilde{}':'~','\\textasciicircum{}':'^'}[c] ?? c.slice(1)));
}
// Source spellings that display differently, tried in order at each position:
// escapes; a paragraph break (blank or space-only lines and the indentation
// around them); a single line ending with its indentation, which reads as one
// space; and the input ligatures of the default text fonts. Runs of plain spaces
// keep one display character each, so carets between them map exactly.
const PRESENTATION = /(\\(?:textbackslash\{\}|textasciitilde\{\}|textasciicircum\{\}|[%$&#_{} ]))|([ \t]*\r?\n(?:[ \t]*\r?\n)+[ \t]*)|([ \t]*\r?\n[ \t]*)|(``|''|---|--|[`'"~])/y;
const LIGATURES = {'``':'“',"''":'”','---':'—','--':'–','`':'‘',"'":'’','"':'”','~':' '};
/** Display text with source-boundary offsets; avoids guessing around escaped TeX and CRLF. */
function textPresentation(source) {
  let text='', offsets=[0];
  for(let i=0;i<source.length;) {
    PRESENTATION.lastIndex=i;
    const m=PRESENTATION.exec(source);
    if(m) {
      text+=m[1]?decodeText(m[1]):m[2]?'\n':m[3]?' ':LIGATURES[m[4]];
      i=PRESENTATION.lastIndex;
    } else text+=source[i++]; // Offsets count UTF-16 units, matching DOM Range and NSString.
    offsets.push(i);
  }
  return {text,offsets};
}
function encodeText(text) {
  return text.replace(/[\\%$&#_{}~^]/g, c => ({'\\':'\\textbackslash{}','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[c] || `\\${c}`));
}
/** Simple, non-recursive macro declarations only. Never executes TeX or includes. */
function readMacroDefinitions(source) {
  const macros = {};
  const body = bodyRange(source), preamble = body.wrapped ? source.slice(0, body.start) : source;
  const pattern = /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{(\\[A-Za-z]+)\}\s*(?:\[(\d)\])?\s*/g;
  for (const match of preamble.matchAll(pattern)) {
    // A declaration after an unescaped % on the same line is a comment.
    const lineStart = preamble.lastIndexOf('\n', match.index) + 1;
    let commented = false;
    for (let i = lineStart; i < match.index; i++) if (preamble[i] === '%' && !escaped(preamble, i)) { commented = true; break; }
    if (commented || Object.keys(macros).length >= 128) continue;
    const arg = balanced(preamble, match.index + match[0].length);
    if (!arg) continue;
    const expansion = preamble.slice(arg.start, arg.end);
    if (expansion.length <= 512) macros[match[1]] = expansion;
  }
  return macros;
}

/** Render common enumitem counter labels without evaluating TeX. */
function listMarker(options, index) {
  const match=/(?:^|,)\s*label\s*=\s*(.*?)(?=,\s*[A-Za-z]+\s*=|$)/.exec(options);
  if(!match)return null;
  let text=match[1].trim(),bold=false;
  if(text.startsWith('{')&&balanced(text,0)?.after===text.length)text=text.slice(1,-1);
  if(text.startsWith('\\textbf{')&&balanced(text,7)?.after===text.length){bold=true;text=text.slice(8,-1);}
  const roman=n=>{let result='';for(const [v,c] of [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']])while(n>=v){result+=c;n-=v;}return result;};
  text=text.replace(/\\(arabic|alph|Alph|roman|Roman)\*/g,(_,style)=>{
    if(style==='arabic')return String(index);
    if(index<1||index>3999)return String(index);
    let value=style.toLowerCase()==='roman'?roman(index):index<=26?String.fromCharCode(96+index):String(index);
    return style[0]===style[0].toUpperCase()?value.toUpperCase():value;
  });
  return /[\\{}$]/.test(text)?null:{text,bold};
}

/** Recognize only top-level literal listing options; package-specific values stay in source. */
function listingPresentation(options = '') {
  const values = {};
  let start = 0, depth = 0;
  for (let i = 0; i <= options.length; i++) {
    if (!escaped(options, i)) {
      if (options[i] === '{') depth++;
      if (options[i] === '}') depth--;
    }
    if (i === options.length || (options[i] === ',' && depth === 0)) {
      const match = /^\s*(numbers|firstnumber)\s*=\s*(.*?)\s*$/.exec(options.slice(start, i));
      if (match) values[match[1]] = match[2].replace(/^\{(.*)\}$/, '$1').trim();
      start = i + 1;
    }
  }
  const first = Number(values.firstnumber);
  return { numbers: ['left', 'right'].includes(values.numbers) ? values.numbers : 'none',
    firstNumber: Number.isSafeInteger(first) && first >= 0 && first <= 1000000000 ? first : 1 };
}

/** Place a new document block outside the selected list, table or formatted group. */
function blockInsertionOffset(tokens, activeToken, fallback) {
  if(!activeToken)return fallback;
  const pairs={blockStart:'blockEnd',listStart:'listEnd',formatStart:'formatEnd',tableStart:'tableEnd'};
  const closing=new Set(Object.values(pairs)), stack=[];
  let enclosing=null, found=false;
  for(const token of tokens) {
    if(pairs[token.kind])stack.push(token);
    if(token===activeToken) {found=true;enclosing=stack[0];if(!enclosing)return token.end;}
    if(closing.has(token.kind)) {
      const opened=stack.pop();
      if(found&&opened===enclosing)return token.end;
    }
  }
  return activeToken.end;
}

window.TeX = {MATH_ENVIRONMENTS,escaped,balanced,bodyRange,scanDocument,mathForField,mathFromField,sourcePatch,applyPatch,decodeText,textPresentation,encodeText,readMacroDefinitions,listMarker,listingPresentation,blockInsertionOffset};
})();
