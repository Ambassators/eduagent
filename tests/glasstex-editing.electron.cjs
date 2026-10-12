/* GlassTeX editing behaviour, driven with real (trusted) keyboard and mouse input so the
   browser's own editing runs, as it does for a person. Loads the editor frame straight from
   src/, so no build is needed: npm run test:glasstex:editing */
const { app, BrowserWindow, protocol, clipboard } = require('electron');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const root = path.resolve(__dirname, '../src/renderer/public/glasstex');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
// A background app: no Dock icon, and it never takes focus from what the person is doing.
if (process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock?.hide(); }
protocol.registerSchemesAsPrivileged([{ scheme: 'codex-glasstex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const texDocument = body => `\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n${body}\\end{document}\n`;
const tests = [];
const test = (name, run) => tests.push({ name, run });

// ---- Selections across text and equations
test('Backspace deletes a shift-arrow selection across inline math', async t => {
  await t.load('Hello \\(x+1\\) world\n');
  await t.caret('Hello', 2); await t.press('Right', ['shift'], 8); await t.press('Backspace');
  await t.body('\nHerld\n');
  await t.type('X');
  await t.body('\nHeXrld\n');
});
test('Delete deletes a dragged selection across inline math', async t => {
  await t.load('Hello \\(x+1\\) world\n');
  await t.drag(['Hello', 2], ['world', 3]); await t.press('Delete');
  await t.body('\nHeld\n');
});
test('typing replaces a selection across a display equation', async t => {
  await t.load('First para\n\\[\na^2\n\\]\nSecond para\n');
  await t.drag(['First', 3], ['Second', 3]); await t.type('Z');
  await t.body('\nFirZond para\n');
});
test('Select All selects the focused text first, then the document', async t => {
  await t.load('Intro\n\\[\nx\n\\]\nOutro\n');
  await t.caret('Intro', 2); await t.press('a', ['cmd']); await t.press('Backspace');
  await t.body('\n\\[\nx\n\\]\nOutro\n');
  await t.load('Intro\n\\[\nx\n\\]\nOutro\n');
  await t.caret('Intro', 2); await t.press('a', ['cmd']); await t.press('a', ['cmd']); await t.press('Backspace');
  await t.body(body => !/Intro|\\\[|Outro/.test(body));
  await t.type('new');
  await t.body(body => body.includes('new'));
});
test('a selection across list items joins them', async t => {
  await t.load('\\begin{itemize}\n  \\item First item\n  \\item Second item\n  \\item Third item\n\\end{itemize}\n');
  await t.drag(['First', 2], ['Second', 3]); await t.press('Backspace');
  await t.body('\n\\begin{itemize}\n  \\item Fiond item\n  \\item Third item\n\\end{itemize}\n');
});
test('a selection from prose into a list keeps the remaining item marker', async t => {
  await t.load('Intro text\n\\begin{itemize}\n  \\item First item\n  \\item Second item\n\\end{itemize}\n');
  await t.drag(['Intro', 2], ['Second', 3]); await t.press('Backspace');
  await t.body('\nIn\\begin{itemize}\\item ond item\n\\end{itemize}\n');
});
test('a selection across table cells clears them and keeps the grid', async t => {
  await t.load('\\begin{tabular}{ll}\n  A1 & B1 \\\\\n  A2 & B2\n\\end{tabular}\n');
  await t.drag(['A1', 1], ['B2', 1]); await t.press('Backspace');
  await t.body(body => /^\n\\begin\{tabular\}\{ll\}\n  A &  \\\\\n   & B?2\n\\end\{tabular\}\n$/.test(body));
});
const algorithmic = '\\begin{algorithmic}[1]\n\\State first line\n\\While{$x < 10$}\n\\State inner\n\\EndWhile\n\\State done here\n\\State second\n\\end{algorithmic}\n';
test('a selection into a loop keeps While and EndWhile balanced', async t => {
  await t.load(algorithmic);
  await t.drag(['first line', 5], ['inner', 2]); await t.press('Backspace');
  await t.body(body => (body.match(/\\While/g) || []).length === (body.match(/\\EndWhile/g) || []).length && body.includes('\\State first'));
});
test('a selection over a whole loop removes it and joins the statements', async t => {
  await t.load(algorithmic);
  await t.drag(['first line', 5], ['done here', 4]); await t.press('Backspace');
  await t.body('\n\\begin{algorithmic}[1]\n\\State first here\n\\State second\n\\end{algorithmic}\n');
});
test('cut, copy and paste with a selection across items', async t => {
  await t.load('Hello \\(x+1\\) world\n');
  await t.drag(['Hello', 2], ['world', 3]);
  t.win.webContents.copy(); await t.settle();
  t.equal(await clipboard.readText(), 'llo \\(x+1\\) wor', 'copied text keeps the LaTeX');
  t.win.webContents.cut(); await t.settle();
  await t.body('\nHeld\n');
  await t.load('Hello \\(x+1\\) world\n');
  await t.drag(['Hello', 2], ['world', 3]);
  await clipboard.writeText('y%z'); t.win.webContents.paste(); await t.settle();
  await t.body('\nHey\\%zld\n');
});

// ---- The catalogue's algorithm block: a code listing
const listing = '\\begin{flushleft}\n\\textbf{Algorithm 1} \\texttt{isIncreasing(int C[a...b])}\n\n\\begin{lstlisting}[numbers=left]\ni = a;\nwhile i < b do\n    i++;\nend while\nreturn true;\n\\end{lstlisting}\n\\end{flushleft}\n';
test('Enter, typing and Backspace at the end of a listing', async t => {
  await t.load(listing);
  await t.caret('return true;', 12); await t.press('Enter'); await t.type('x'); await t.press('Backspace'); await t.press('Backspace');
  await t.body('\n' + listing);
  await t.caret('i++;', 4); await t.press('Backspace', [], 9);
  await t.body(body => body.includes('while i < b do\nend while'));
});
test('Backspace at the start of a listing moves to the line before without deleting', async t => {
  await t.load(listing);
  await t.caret('i = a;', 0); await t.press('Backspace');
  await t.body('\n' + listing);
  await t.focus('isIncreasing(int C[a...b])@26');
});
test('Select All in a listing, then Backspace twice, empties then removes it', async t => {
  await t.load(listing);
  await t.caret('i = a;', 3); await t.press('a', ['cmd']); await t.press('Backspace');
  await t.body(body => body.includes('\\begin{lstlisting}[numbers=left]\n\n\\end{lstlisting}') && body.includes('Algorithm 1'));
  await t.press('Backspace');
  await t.body(body => !body.includes('lstlisting') && body.includes('Algorithm 1'));
});
test('lines selected in a listing delete natively', async t => {
  await t.load(listing);
  await t.caret('end while', 9); await t.press('Up', ['shift'], 2); await t.press('Backspace');
  await t.body(body => body.includes('i = a;\nwhile i <\nreturn true;'));
});
test('pasting lines into a listing', async t => {
  await t.load(listing);
  await t.caret('i++;', 4); await clipboard.writeText('\n    j++;'); t.win.webContents.paste(); await t.settle();
  await t.body(body => body.includes('    i++;\n    j++;\nend while'));
});

// ---- algorithmic environments
test('Backspace at the start of a statement joins it to the previous statement', async t => {
  await t.load(algorithmic);
  await t.caret('second', 0); await t.press('Backspace');
  await t.body('\n' + algorithmic.replace('done here\n\\State second', 'done here second'));
});
test('Backspace in an emptied statement removes the line', async t => {
  await t.load(algorithmic);
  await t.caret('second', 6); await t.press('Backspace', [], 7);
  await t.body('\n' + algorithmic.replace('\\State second\n', ''));
  await t.focus('done here@9');
  await t.type('Q');
  await t.body(body => body.includes('\\State done hereQ\n'));
});
test('Backspace next to a control-flow line deletes nothing', async t => {
  await t.load(algorithmic);
  await t.caret('inner', 0); await t.press('Backspace');
  await t.body('\n' + algorithmic);
  await t.caretMath(0, 0); await t.press('Backspace');
  await t.body('\n' + algorithmic);
});
test('Backspace in an empty loop removes the whole loop; a loop with a body stays', async t => {
  await t.load('\\begin{algorithmic}\n\\State before\n\\For{}\n\\EndFor\n\\State\n\\end{algorithmic}\n');
  await t.js(`[...document.querySelectorAll('.algorithm-line-content .text-run')].at(-1).focus()`); await t.press('Backspace');
  await t.body('\n\\begin{algorithmic}\n\\State before\n\\For{}\n\\EndFor\n\\end{algorithmic}\n');
  await t.press('Backspace');
  await t.body('\n\\begin{algorithmic}\n\\State before\n\\end{algorithmic}\n');
  await t.focus('before@6');
  await t.load('\\begin{algorithmic}\n\\State before\n\\For{}\n\\State body\n\\EndFor\n\\end{algorithmic}\n');
  await t.js(`document.querySelectorAll('.algorithm-line-content .text-run')[1].focus()`); await t.press('Backspace');
  await t.body('\n\\begin{algorithmic}\n\\State before\n\\For{}\n\\State body\n\\EndFor\n\\end{algorithmic}\n');
});
test('a drag that starts on a line keyword or number selects from that line', async t => {
  await t.load('\\begin{algorithmic}[1]\n\\State //$C[i]$ now contains the \\# of elements in $A$ equal to $i$\n\\For{$i = 1$ \\textbf{to} $k$}\n\\State $C[i] = 0$;\n\\EndFor\n\\end{algorithmic}\n');
  const [from, to] = await t.js(`(()=>{const ls=document.querySelectorAll('.document-algorithm-line');const k=ls[1].querySelector('.algorithm-keyword').getBoundingClientRect(),m=ls[2].querySelector('math-field').getBoundingClientRect();return [[k.left+3,k.top+k.height/2],[m.right-2,m.top+m.height/2]];})()`);
  await t.dragPoints(from, to);
  const top = await t.js(`Math.min(...[...document.querySelectorAll('.document-selection > div')].map(d=>parseFloat(d.style.top)))`);
  const lines = await t.js(`[...document.querySelectorAll('.document-algorithm-line')].map(l=>l.getBoundingClientRect().top)`);
  t.equal(top >= lines[1] - 2 && top < lines[2], true, `selection starts on line 2 (top ${top}, lines ${lines.map(Math.round)})`);
});
test('the view does not move when a delete rebuilds the page', async t => {
  const filler = Array.from({ length: 14 }, (_, i) => `Paragraph ${i} with an equation \\(x_${i} + y = ${i}\\) to fill the page.\n\n`).join('');
  await t.load(filler + '\\begin{algorithmic}[1]\n\\State Let $C[0\\ldots k]$ be a new array\n\\For{$i = 0$ \\textbf{to} $k$}\n\\State $C[i] = 0$;\n\\EndFor\n\\State second\n\\State\n\\end{algorithmic}\n' + filler);
  await t.sleep(600);
  await t.js(`document.querySelectorAll('.document-algorithm-line')[2].scrollIntoView({block:'center'})`); await t.sleep(300);
  // Positions are read after each frame's work, as the person sees them.
  await t.js(`window.__positions=[];{const t0=performance.now();const f=()=>setTimeout(()=>{__positions.push(Math.round(document.querySelectorAll('.document-algorithm-line')[1].getBoundingClientRect().top));if(performance.now()-t0<900)requestAnimationFrame(f)});requestAnimationFrame(f)};0`);
  await t.js(`[...document.querySelectorAll('.algorithm-line-content .text-run')].at(-1).focus()`);
  await t.press('Backspace'); await t.caret('second', 0); await t.press('Backspace'); await t.sleep(900);
  const positions = [...new Set(await t.js('__positions'))];
  t.equal(positions.length, 1, `line position on screen ${JSON.stringify(positions)}`);
});
test('typing into an empty statement', async t => {
  await t.load('\\begin{algorithmic}\n\\State one\n\\State\n\\State three\n\\end{algorithmic}\n');
  await t.js(`document.querySelectorAll('.algorithm-line-content .text-run')[1].focus()`); await t.type('two');
  await t.body('\n\\begin{algorithmic}\n\\State one\n\\State two\n\\State three\n\\end{algorithmic}\n');
});

// ---- Boundaries between items
test('Backspace after a display equation enters it without deleting', async t => {
  await t.load('Intro text\n\\[\nx+y\n\\]\nAfter text\n');
  await t.caret('After', 0); await t.press('Backspace');
  await t.body('\nIntro text\n\\[\nx+y\n\\]\nAfter text\n');
  await t.focus('math:x+y@3');
});
test('Backspace at the start of a list item joins it to the previous item', async t => {
  await t.load('\\begin{itemize}\n  \\item First item\n  \\item Second item\n\\end{itemize}\n');
  await t.caret('Second', 0); await t.press('Backspace');
  await t.body('\n\\begin{itemize}\n  \\item First item\n  Second item\n\\end{itemize}\n');
});
test('Backspace in an empty list item removes it', async t => {
  await t.load('\\begin{itemize}\n  \\item First item\n  \\item \n  \\item Third\n\\end{itemize}\n');
  await t.js(`document.querySelectorAll('li .text-run')[1].focus()`); await t.press('Backspace');
  await t.body('\n\\begin{itemize}\n  \\item First item\n  \\item Third\n\\end{itemize}\n');
  await t.focus('First item @10');
});
test('Backspace at the start of a table cell deletes nothing', async t => {
  await t.load('\\begin{tabular}{ll}\n  A & B \\\\\n  C & D\n\\end{tabular}\n');
  await t.caret('B', 0); await t.press('Backspace');
  await t.body('\n\\begin{tabular}{ll}\n  A & B \\\\\n  C & D\n\\end{tabular}\n');
});
test('deleting a whole paragraph keeps its line ending', async t => {
  await t.load('one two\n');
  await t.caret('one two', 7); await t.press('Backspace', [], 7);
  await t.body('\n\n');
  await t.type('ok');
  await t.body('\nok\n');
});
test('Backspace in an empty display equation removes it', async t => {
  await t.load('Start\n\\[\n\n\\]\nEnd\n');
  await t.caretMath(0, 0); await t.press('Backspace');
  await t.body('\nStart\n\nEnd\n');
  await t.type('X');
  await t.body('\nStartX\n\nEnd\n');
});
test('Backspace in an empty heading removes it', async t => {
  await t.load('\\section{Title}\nBody\n');
  await t.caret('Title', 5); await t.press('Backspace', [], 6);
  await t.body('\n\nBody\n');
});
test('Backspace removes a \\\\ line break, a literal, or an empty equation whole', async t => {
  await t.load('line one\\\\\nline two\n');
  await t.caret('line two', 0); await t.press('Backspace');
  await t.body('\nline oneline two\n');
  await t.load('Wait\\ldots{} then\n');
  await t.caret(' then', 0); await t.press('Backspace');
  await t.body('\nWait then\n');
  await t.load('x \\(\\) y\n');
  await t.caret(' y', 0); await t.press('Backspace');
  await t.body('\nx  y\n');
});
test('Backspace on one line of prose continues into inline math and formatting', async t => {
  await t.load('a \\(x\\) b\n');
  await t.caret(' b', 1); await t.press('Backspace', [], 2);
  await t.body('\na \\(\\)b\n');
  await t.load('word \\textbf{bold} tail\n');
  await t.caret(' tail', 0); await t.press('Backspace');
  await t.body('\nword \\textbf{bol} tail\n');
});

// ---- Typing and moving (unchanged behaviour)
test('Enter starts and Backspace rejoins a paragraph', async t => {
  await t.load('Alpha beta\n\\[\nx\n\\]\n');
  await t.caret('Alpha beta', 10); await t.press('Enter'); await t.type('new');
  await t.body('\nAlpha beta\n\nnew\n\\[\nx\n\\]\n');
  await t.press('Backspace', [], 4);
  await t.body('\nAlpha beta\n\\[\nx\n\\]\n');
  await t.load('Alpha beta\n');
  await t.caret('Alpha beta', 5); await t.press('Enter');
  await t.body('\nAlpha\n\n beta\n');
  await t.press('Backspace');
  await t.body('\nAlpha beta\n');
});
test('typing escapes TeX specials and keeps nearby escapes', async t => {
  await t.load('Cost is 5\\% of $x_1$ \\& more\n');
  await t.caret('more', 4); await t.type('!');
  await t.body('\nCost is 5\\% of $x_1$ \\& more!\n');
  await t.caret('Cost', 4); await t.type('#');
  await t.body('\nCost\\# is 5\\% of $x_1$ \\& more!\n');
});
test('arrow keys move into and out of inline math', async t => {
  await t.load('Before \\(a\\) after\n');
  await t.caret('Before ', 7); await t.press('Right');
  await t.focus(value => value.startsWith('math:a@'));
  await t.press('Right', [], 2);
  await t.focus(' after @0');
});
test('equations: typing, Enter for a new one, Cmd+Enter to insert one', async t => {
  await t.load('Some text\n\\[\nx+1\n\\]\nMore text\n');
  await t.caretMath(0, 'end'); await t.type('0');
  await t.body('\nSome text\n\\[\nx+10\n\\]\nMore text\n');
  await t.press('Enter');
  await t.body(body => (body.match(/\\\[/g) || []).length === 2);
  await t.load('Para one\n');
  await t.caret('Para one', 8); await t.press('Enter', ['cmd']); await t.type('y');
  await t.body(body => /\\\[\s*y\s*\\\]/.test(body));
});
test('auto-math converts while typing, and Backspace undoes it', async t => {
  await t.load('Try here\n');
  await t.caret('Try here', 8); await t.type(' x^');
  await t.body(body => body.includes('\\(x^'));
  await t.press('Backspace');
  await t.body('\nTry here x\\textasciicircum{}\n');
});
test('Tab moves between table cells', async t => {
  await t.load('\\begin{tabular}{ll}\n  A & B \\\\\n  C & D\n\\end{tabular}\n');
  await t.caret('A', 1); await t.press('Tab'); await t.type('x');
  await t.body('\n\\begin{tabular}{ll}\n  A & xB \\\\\n  C & D\n\\end{tabular}\n');
});
test('raw source is editable', async t => {
  await t.load('Text \\unknowncommand{arg} end\n');
  await t.caret('\\unknowncommand', 5); await t.type('X');
  await t.body(body => body.includes('\\unknXowncommand{arg}'));
});
test('a change from the host keeps the caret at the edit', async t => {
  await t.load('First\n');
  await t.caret('First', 5); await t.type('ly');
  await t.js(`(()=>{const s=GlassTeX.snapshot();GlassTeX.setDocument({source:s.source.replace('Firstly','Firstly said'),revision:s.revision+1});})()`); await t.settle();
  await t.focus('Firstly said @12');
  await t.type('!');
  await t.body('\nFirstly said!\n');
});
test('selections inside one text run edit natively', async t => {
  await t.load('Hello world\n');
  await t.caret('Hello', 2); await t.press('Right', ['shift'], 3); await t.press('Backspace');
  await t.body('\nHe world\n');
  await t.caret('He world', 8); await t.press('Left', ['shift'], 5); await t.type('Z');
  await t.body('\nHe Z\n');
});
test('undo and redo are requests to the host', async t => {
  await t.load('x\n');
  await t.caret('x', 1); await t.press('z', ['cmd']); await t.press('z', ['cmd', 'shift']);
  t.equal(JSON.stringify(t.requests), '["undo","redo"]', 'requests');
});

const keyCodes = { Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down', Enter: 'Return' };
const timeout = setTimeout(() => { console.error('GlassTeX editing tests timed out'); app.exit(1); }, 240_000);
app.whenReady().then(async () => {
  protocol.handle('codex-glasstex', async request => {
    try {
      const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url).pathname));
      if (!file.startsWith(root + path.sep)) throw new Error('outside');
      return new Response(await readFile(file), { headers: { 'Content-Type': mime[path.extname(file)] || 'text/plain' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadURL('codex-glasstex://editor/index.html');
  // Behave as a focused page whatever the OS does with this window, so focus events always fire.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = code => win.webContents.executeJavaScript(code);
  const settle = async (ms = 100) => { await sleep(ms); await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); };
  let failures = 0, current = null;
  const check = (ok, message) => { if (!ok) { current.failed = true; console.error(`  ✗ ${message}`); } };
  const t = {
    win, js, settle, requests: [],
    async load(body) {
      await js(`window.__requests=[];window.webkit.messageHandlers.editor.postMessage=m=>{if(m.type==='request')__requests.push(m.action);};GlassTeX.setDocument(${JSON.stringify({ source: texDocument(body), revision: 0, initial: true, force: true })});document.activeElement?.blur?.()`);
      await settle(300);
    },
    async press(key, modifiers = [], times = 1) {
      if (/^[A-Z]$/.test(key)) modifiers = [...modifiers, 'shift'];
      for (let i = 0; i < times; i++) {
        const keyCode = keyCodes[key] || key;
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        const char = key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : key.length === 1 ? key : null;
        if (char && !modifiers.includes('cmd')) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await sleep(20);
      }
      await settle();
      t.requests = await js('window.__requests');
    },
    /** Letters and spaces are keystrokes; other characters arrive as text input, as from an input method. */
    async type(text) {
      for (const c of text) {
        if (/^[A-Za-z0-9 ]$/.test(c)) await t.press(c);
        else { win.webContents.insertText(c); await settle(50); }
      }
    },
    /** A collapsed caret `offset` characters into the first editable text containing `needle`. */
    async caret(needle, offset) {
      const found = await js(`(()=>{const el=[...document.querySelectorAll('[contenteditable=true]')].find(e=>e.textContent.includes(${JSON.stringify(needle)}));if(!el)return false;el.focus();
        let left=el.textContent.indexOf(${JSON.stringify(needle)})+${offset};const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())&&left>n.length)left-=n.length;
        const r=document.createRange();r.setStart(n||el,n?left:0);getSelection().removeAllRanges();getSelection().addRange(r);return true;})()`);
      if (!found) throw new Error('No editable text contains ' + needle);
      await settle(50);
    },
    async caretMath(index, position) {
      await js(`(()=>{const mf=document.querySelectorAll('math-field')[${index}];mf.focus();mf.position=${position === 'end' ? 'mf.lastOffset' : position};})()`);
      await settle(50);
    },
    sleep,
    /** Drag the mouse from [text, offset] to [text, offset]. */
    async drag(from, to) {
      const points = await js(`[${JSON.stringify(from)},${JSON.stringify(to)}].map(([text,offset])=>{for(const el of document.querySelectorAll('[contenteditable=true]')){const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){const i=n.data.indexOf(text);if(i>=0){const r=document.createRange();r.setStart(n,i+offset);const b=r.getBoundingClientRect();return [b.left,b.top+b.height/2];}}}return null;})`);
      if (points.includes(null)) throw new Error('Drag target not found');
      await t.dragPoints(...points);
    },
    /** Drag the mouse between two viewport points. */
    async dragPoints(a, b) {
      const mouse = (type, [x, y], extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
      mouse('mouseDown', a); await sleep(30);
      for (let i = 1; i <= 8; i++) { mouse('mouseMove', [a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8], { modifiers: ['leftButtonDown'] }); await sleep(20); }
      mouse('mouseUp', b); await settle();
    },
    /** Check the text between \begin{document} and \end{document}. */
    async body(expected) {
      const source = await js('GlassTeX.snapshot().source');
      const body = source.slice(source.indexOf('\\begin{document}') + 16, source.indexOf('\\end{document}'));
      check(typeof expected === 'function' ? expected(body) : body === expected, `source: got ${JSON.stringify(body)}, expected ${typeof expected === 'function' ? expected : JSON.stringify(expected)}`);
    },
    equal: (actual, expected, label) => check(actual === expected, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`),
    /** Where the caret is: "text@offset", or "math:latex@position". */
    async focus(expected) {
      const actual = await js(`(()=>{const a=document.activeElement;return a?.tagName==='MATH-FIELD'?'math:'+a.value+'@'+a.position:(a?.textContent??'')+'@'+getSelection().anchorOffset;})()`);
      check(typeof expected === 'function' ? expected(actual) : actual === expected, `caret: got ${JSON.stringify(actual)}, expected ${typeof expected === 'function' ? expected : JSON.stringify(expected)}`);
    },
  };
  for (const entry of tests) {
    current = entry;
      try { await entry.run(t); } catch (error) { check(false, error.message); }
    if (entry.failed) failures++;
    console.log(`${entry.failed ? '✗' : '✓'} ${entry.name}`);
  }
  if (errors.length) { failures++; console.error('Console errors:\n' + errors.join('\n')); }
  console.log(failures ? `\n${failures} of ${tests.length} GlassTeX editing tests failed.` : `\nAll ${tests.length} GlassTeX editing tests passed.`);
  clearTimeout(timeout); app.exit(failures ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
