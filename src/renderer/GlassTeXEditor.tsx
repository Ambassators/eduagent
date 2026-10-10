import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentInfo } from '../shared';
import { applyTeXPatch, canonicalTeXShortcut, cleanTeXSettings, texCategoryOrder, type TeXCommand, type TeXPatch, type TeXSettings } from '../glasstex';
import catalogue from '../glasstex/commands.json';
import { flushTeX, persistTeX } from './tex-persistence';
import './glasstex.css';

const ORIGIN = 'codex-glasstex://editor';
const channel = 'codex-glasstex';
const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } }
function storedCommands(): TeXCommand[] {
  const value = stored<unknown>('glasstex.commands', []);
  return Array.isArray(value) ? value.filter(command => command && ['id', 'title', 'category', 'symbol', 'latex', 'mode'].every(key => typeof command[key] === 'string')) : [];
}
type Inspector = { latex: string; display: boolean; append: string; note: string; javascript: string; mathjson: string };
const emptyInspector: Inspector = { latex: '', display: true, append: '', note: 'Select an equation to calculate it.', javascript: '', mathjson: '' };

export default function GlassTeXEditor({ file, sidebar, onError, onOpenFiles }: { file: DocumentInfo; sidebar: HTMLElement | null; onError: (message: string) => void; onOpenFiles: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null), sourceEditor = useRef<HTMLTextAreaElement>(null), search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(''), [loaded, setLoaded] = useState(false), [ready, setReady] = useState(false);
  const [sourceMode, setSourceMode] = useState(false), [preview, setPreview] = useState(false), [showInspector, setShowInspector] = useState(true);
  const [query, setQuery] = useState(''), [category, setCategory] = useState('All features');
  const [inspector, setInspector] = useState<Inspector>(emptyInspector), [tab, setTab] = useState('LaTeX');
  const [info, setInfo] = useState({ equations: 0, rawBlocks: 0 }), [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(0), [exporting, setExporting] = useState(false), [recovering, setRecovering] = useState(false);
  const [settings, setSettings] = useState<TeXSettings>(() => cleanTeXSettings(stored('glasstex.settings', {})));
  const [custom, setCustom] = useState<TeXCommand[]>(storedCommands);
  const [shortcuts, setShortcuts] = useState<Record<string, string>>(() => { const value = stored<unknown>('glasstex.shortcuts', {}); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, shortcut]) => typeof shortcut === 'string')) : {}; });
  const [dialog, setDialog] = useState<'settings' | 'custom' | 'shortcut' | null>(null);
  const [newCommand, setNewCommand] = useState({ title: '', category: 'Custom', symbol: 'ƒ', latex: '\\operatorname{myFunction}\\left(#?\\right)', mode: 'math' });
  const [editingCommand, setEditingCommand] = useState<string | null>(null);
  const [shortcutCommand, setShortcutCommand] = useState<TeXCommand | null>(null), [shortcutValue, setShortcutValue] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = useRef({ source: '', revision: file.revision, undo: [] as string[], redo: [] as string[], recovering: false, loaded: false });
  const selection = useRef({ start: 0, end: 0 });
  const mounted = useRef(true), errorRef = useRef(onError); errorRef.current = onError;
  const windows = !navigator.userAgent.includes('Mac');
  const commands: TeXCommand[] = [...catalogue, ...custom].map(command => ({ ...command, shortcut: (shortcuts[command.id] ?? command.shortcut)?.replace(windows ? /^cmd\+/ : /$^/, 'ctrl+') }));
  const available = [...new Set(commands.map(command => command.category))];
  const categories = [...texCategoryOrder.filter(name => available.includes(name)), ...available.filter(name => !texCategoryOrder.includes(name)).sort()];
  const filtered = commands.filter(command => query.trim() ? [command.title, command.latex, command.keywords, command.category, command.id].join(' ').toLowerCase().includes(query.trim().toLowerCase()) : category === 'All features' || category === command.category);
  const send = (type: string, payload: unknown) => frame.current?.contentWindow?.postMessage({ channel, type, payload }, ORIGIN);
  const receive = (payload: object) => send('command', payload);
  function syncDocument(initial = false) { send('document', { source: state.current.source, revision: state.current.revision, initial }); }

  async function reload(clearHistory = true) {
    const content = await window.desktop!.document(file.id);
    if (!mounted.current) return;
    Object.assign(state.current, { source: content.text, revision: content.info.revision, loaded: true, recovering: false });
    if (clearHistory) { state.current.undo = []; state.current.redo = []; }
    setSource(content.text); setLoaded(true); setRecovering(false); setInspector(emptyInspector); syncDocument(!loaded);
  }
  async function recover(error: unknown) {
    if (state.current.recovering) return;
    state.current.recovering = true;
    if (mounted.current) { setRecovering(true); errorRef.current(errorMessage(error)); }
    await flushTeX(file.id).catch(() => {});
    try { await reload(); } catch (failure) { if (mounted.current) errorRef.current(errorMessage(failure)); }
  }
  function edit(next: string, history = true, updateFrame = false) {
    const current = state.current;
    if (!current.loaded || current.recovering || current.source === next) return;
    if (history) { current.undo.push(current.source); current.redo = []; }
    // Bound source snapshots for large documents while retaining useful local undo.
    while (current.undo.length > 200 || current.undo.length > 1 && current.undo.reduce((bytes, text) => bytes + text.length * 2, 0) > 32 * 1024 * 1024) current.undo.shift();
    const previousRevision = current.revision;
    current.source = next; current.revision++; setSource(next); setSaving(value => value + 1);
    if (updateFrame) syncDocument();
    void persistTeX(file.id, next, previousRevision).catch(recover).finally(() => { if (mounted.current) setSaving(value => Math.max(0, value - 1)); });
  }
  function undo(redo = false) {
    const current = state.current, from = redo ? current.redo : current.undo, to = redo ? current.undo : current.redo;
    const next = from.pop(); if (next === undefined) return;
    to.push(current.source); edit(next, false, !sourceMode);
  }
  function insertText(text: string, preamble = false) {
    const current = state.current, range = preamble ? { start: current.source.charCodeAt(0) === 0xfeff ? 1 : 0, end: current.source.charCodeAt(0) === 0xfeff ? 1 : 0 } : selection.current;
    edit(current.source.slice(0, range.start) + text + current.source.slice(range.end));
    selection.current = { start: range.start + text.length, end: range.start + text.length };
    requestAnimationFrame(() => { sourceEditor.current?.focus(); sourceEditor.current?.setSelectionRange(selection.current.start, selection.current.end); });
  }
  function insert(command: TeXCommand) {
    if (sourceMode) {
      const template = command.latex.replaceAll('#@', state.current.source.slice(selection.current.start, selection.current.end)).replaceAll('#?', '');
      insertText(command.mode === 'math' ? `\\(${template}\\)` : template, command.mode === 'preamble');
    } else receive({ action: 'insertCommand', command });
  }
  function equation(inline = false) { if (sourceMode) insertText(inline ? '\\(\\)' : '\n\\[\n\n\\]\n'); else receive({ action: 'insertEquation', inline }); }
  function paragraph() { if (sourceMode) insertText('\n\nNew paragraph.\n\n'); else receive({ action: 'insertParagraph' }); }
  function togglePreview() { setSourceMode(false); setPreview(value => { receive({ action: 'preview', enabled: !value }); return !value; }); }
  async function save(original: boolean) { try { await flushTeX(file.id); await window.desktop!.saveDocument(file.id, original); } catch (error) { errorRef.current(errorMessage(error)); } }
  async function exportPDF() {
    if (exporting) return;
    setExporting(true);
    try { await flushTeX(file.id); await window.desktop!.exportTeXPDF(file.id, settings); } catch (error) { errorRef.current(errorMessage(error)); } finally { if (mounted.current) setExporting(false); }
  }
  const handlers = useRef<(action: string) => void>(() => {});
  handlers.current = action => {
    if (action === 'undo' || action === 'redo') undo(action === 'redo');
    else if (action === 'palette') search.current?.focus();
    else if (action === 'source') setSourceMode(value => !value);
    else if (action === 'preview') togglePreview();
    else if (action === 'inspector') setShowInspector(value => !value);
    else if (action === 'paragraph') paragraph();
    else if (action === 'settings') setDialog('settings');
    else if (action === 'save') void save(!!file.originalPath);
    else if (action === 'saveCopy') void save(false);
    else if (action === 'export') void exportPDF();
    else if (action === 'open') onOpenFiles();
  };
  useEffect(() => {
    mounted.current = true;
    void reload().catch(error => errorRef.current(errorMessage(error)));
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== ORIGIN || event.data?.channel !== channel) return;
      const message = event.data;
      if (message.type === 'ready') { setReady(true); if (state.current.loaded) syncDocument(true); }
      else if (message.type === 'patch') { try { edit(applyTeXPatch(state.current.source, state.current.revision, message.patch as TeXPatch)); } catch (error) { void recover(error); } }
      else if (message.type === 'active') setInspector({ ...emptyInspector, latex: message.latex ?? '', display: message.display !== false });
      else if (message.type === 'analysis' && (message.sourceRevision === undefined || message.sourceRevision === state.current.revision)) setInspector(old => ({ ...old, append: message.append ?? '', note: message.note ?? '', javascript: message.javascript ?? '', mathjson: message.mathjson ?? '' }));
      else if (message.type === 'documentInfo') { setInfo({ equations: message.equations ?? 0, rawBlocks: message.rawBlocks ?? 0 }); setNotice((message.warnings ?? []).join(' ')); }
      else if (message.type === 'preview') setPreview(message.enabled === true);
      else if (message.type === 'request') handlers.current(message.action);
      else if (message.type === 'notice') setNotice(message.message);
      else if (message.type === 'error') errorRef.current(message.message);
    };
    window.addEventListener('message', listener);
    return () => { mounted.current = false; window.removeEventListener('message', listener); };
  }, [file.id]);
  useEffect(() => {
    if (!loaded || file.revision <= state.current.revision || state.current.recovering) return;
    void flushTeX(file.id).then(() => reload()).catch(recover);
  }, [file.revision, loaded]);
  useEffect(() => { if (ready) { receive({ action: 'settings', settings }); receive({ action: 'commands', commands }); } localStorage.setItem('glasstex.settings', JSON.stringify(settings)); }, [settings, ready]);
  useEffect(() => { if (ready) receive({ action: 'commands', commands }); localStorage.setItem('glasstex.commands', JSON.stringify(custom)); localStorage.setItem('glasstex.shortcuts', JSON.stringify(shortcuts)); }, [custom, shortcuts, ready]);
  useEffect(() => { list.current?.scrollTo(0, 0); }, [query, category]);
  useEffect(() => { if (loaded && ready && !sourceMode) syncDocument(); }, [sourceMode, loaded, ready]);
  useEffect(() => { if (dialog) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [dialog]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (dialog || event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const action = key === ',' ? 'settings' : key === 'k' ? 'palette' : event.shiftKey && key === 'l' ? 'source' : event.shiftKey && key === 'p' ? 'preview' : event.shiftKey && key === 'i' ? 'inspector' : event.shiftKey && key === 't' ? 'paragraph' : key === 's' ? event.shiftKey ? 'saveCopy' : 'save' : event.altKey && event.code === 'KeyE' ? 'export' : null;
      if (action) { event.preventDefault(); handlers.current(action); }
      else if (sourceMode && key === 'z') { event.preventDefault(); undo(event.shiftKey); }
      else if (sourceMode && event.key === 'Enter') { event.preventDefault(); equation(event.shiftKey); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [dialog, sourceMode]);

  const inspectorText = tab === 'JS' ? inspector.javascript || '// Select a supported expression to generate JavaScript.' : tab === 'JSON' ? inspector.mathjson || 'Select a supported expression to inspect its syntax tree.' : tab === 'TSX' ? inspector.latex ? `import { ${inspector.display ? 'BlockMath' : 'InlineMath'} } from 'react-katex';\nimport 'katex/dist/katex.min.css';\n\nexport default function Equation() {\n  return <${inspector.display ? 'BlockMath' : 'InlineMath'} math={${JSON.stringify(inspector.latex)}} />;\n}\n` : '// Select an equation to generate a component.' : inspector.latex || 'Select an equation. Use Full source to edit the complete document.';
  const canEdit = loaded && ready && !recovering;
  function setPreference<K extends keyof TeXSettings>(key: K, value: TeXSettings[K]) { setSettings(old => ({ ...old, [key]: value })); }
  return <div className="document-view glasstex-view">
    <div className="doc-toolbar drag"><div className="doc-title"><span className="file-glyph small tex">TEX</span><strong title={file.originalPath}>{file.name}</strong><span className="tex-save-status" role="status">{recovering ? 'Reloading…' : saving ? 'Saving working copy…' : loaded ? 'GlassTeX' : 'Loading…'}</span></div><div className="doc-actions">
      <button className="quiet-button" onClick={() => setSourceMode(value => !value)}>{sourceMode ? 'Visual editor' : 'Full source'}</button>
      <button className="quiet-button" onClick={() => setShowInspector(value => !value)} aria-pressed={showInspector}>Inspector</button>
      <button className="quiet-button" disabled={!loaded || recovering} onClick={() => void save(false)}>Save copy</button>
      {file.dirty && file.originalPath && <button className="quiet-button strong" onClick={() => void save(true)}>Save original</button>}
    </div></div>
    <div className="tex-editor-body">
      <div className="tex-canvas">
        <iframe ref={frame} title={`GlassTeX editor — ${file.name}`} src={`${ORIGIN}/index.html`} sandbox="allow-scripts allow-same-origin" className={sourceMode ? 'tex-frame hidden' : 'tex-frame'} />
        {sourceMode && <textarea ref={sourceEditor} className="tex-source" aria-label="LaTeX source" spellCheck={false} disabled={!loaded || recovering} value={source} onChange={event => edit(event.target.value)} onSelect={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} />}
        {(!loaded || !ready || recovering) && <div className="tex-loading" role="status"><span className="loading-ring" />{recovering ? 'Reloading current source…' : 'Loading GlassTeX…'}</div>}
      </div>
      {showInspector && <aside className="tex-inspector" aria-label="GlassTeX inspector"><div className="tex-heading"><strong>Inspector</strong><button onClick={() => setShowInspector(false)} aria-label="Hide inspector">×</button></div>
        <div className="tex-tabs" role="tablist" aria-label="Generated representation">{['LaTeX', 'JS', 'TSX', 'JSON'].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
        <pre className="tex-representation">{inspectorText}</pre><div className="tex-inspector-actions"><button onClick={() => void navigator.clipboard.writeText(inspectorText).catch(error => errorRef.current(errorMessage(error)))}>Copy</button><button onClick={() => setSourceMode(value => !value)}>{sourceMode ? 'Visual' : 'Full source'}</button></div>
        <div className="tex-assistant"><strong>Math assistant</strong><p>{inspector.note}</p>{inspector.append && <button disabled={!canEdit} onClick={() => receive({ action: 'accept' })}>Accept result ⇥</button>}</div>
        {!!info.rawBlocks && <p className="tex-note">{info.rawBlocks} source fragments preserved.</p>}{notice && <p className="tex-note" role="status">{notice}</p>}
      </aside>}
    </div>
    {sidebar && createPortal(<div className="tex-command-rail" aria-label="GlassTeX commands">
      <div className="tex-heading"><strong>ƒ GlassTeX</strong><span>{info.equations} {info.equations === 1 ? 'equation' : 'equations'}</span><button className="tex-export" disabled={!canEdit || exporting} aria-label="Export GlassTeX to PDF" title="Export to PDF" onClick={() => void exportPDF()}>{exporting ? 'Exporting…' : 'PDF ↗'}</button></div>
      <div className="tex-rail-tools">
        <div className="tex-quick-insert"><button disabled={!canEdit} onMouseDown={event => event.preventDefault()} onClick={() => equation()}>Equation</button><button disabled={!canEdit} onMouseDown={event => event.preventDefault()} onClick={() => equation(true)}>Inline</button><button disabled={!canEdit} onMouseDown={event => event.preventDefault()} onClick={paragraph}>Text</button></div>
        <div className="tex-filters"><input ref={search} aria-label="Search GlassTeX features" placeholder={`Search · ${windows ? 'Ctrl+' : '⌘'}K`} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && filtered[0] && canEdit) { event.preventDefault(); insert(filtered[0]); } }} />
        <select aria-label="Feature category" value={category} onChange={event => setCategory(event.target.value)}><option>All features</option>{categories.map(name => <option key={name}>{name}</option>)}</select></div>
      </div>
      <div className="tex-rail-scroll">
        <div ref={list} className="tex-feature-list">{categories.map(name => { const items = filtered.filter(command => command.category === name); return items.length ? <section key={name}><h3>{name}</h3>{items.map(command => <button className="tex-feature" key={command.id} disabled={!canEdit} aria-label={`Insert ${command.title}`} title={`${command.latex}\nRight-click to assign a shortcut.`} onMouseDown={event => event.preventDefault()} onClick={() => insert(command)} onContextMenu={event => { event.preventDefault(); setShortcutCommand(command); setShortcutValue(shortcuts[command.id] ?? command.shortcut ?? ''); setDialog('shortcut'); }}><span>{command.symbol}</span><span>{command.title}</span></button>)}</section> : null; })}{!filtered.length && <p className="tex-note">No matching feature.</p>}</div>
      </div>
      <div className="tex-rail-footer"><button disabled={!loaded} onClick={() => setSourceMode(value => !value)}>{sourceMode ? 'Visual editor' : 'Edit source'}</button><button disabled={!canEdit} onClick={togglePreview}>{preview ? 'Resume editing' : 'KaTeX preview'}</button><button onClick={() => setDialog('custom')}>Custom command</button><button onClick={() => setDialog('settings')}>Settings…</button><small>{commands.length} commands</small></div>
    </div>, sidebar)}
    <dialog ref={dialogRef} className="tex-dialog" onCancel={() => setDialog(null)}><div className="tex-heading"><h2>{dialog === 'settings' ? 'GlassTeX settings' : dialog === 'custom' ? 'Custom commands' : 'Keyboard shortcut'}</h2><button aria-label="Close dialog" onClick={() => setDialog(null)}>×</button></div>
      {dialog === 'settings' && <div className="tex-settings">
        <label>Document appearance<select value={settings.appearance} onChange={event => setPreference('appearance', event.target.value as TeXSettings['appearance'])}>{['system', 'light', 'dark'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Equation size · {settings.fontSize}px<input type="range" min="16" max="32" step="1" value={settings.fontSize} onChange={event => setPreference('fontSize', Number(event.target.value))} /></label>
        <label>Document spacing<select value={settings.documentSpacing} onChange={event => setPreference('documentSpacing', event.target.value as TeXSettings['documentSpacing'])}>{['compact', 'comfortable', 'spacious', 'custom'].map(value => <option key={value}>{value}</option>)}</select></label>
        {settings.documentSpacing === 'custom' && ([['customLineSpacing', 'Line spacing', 1.1, 2.2], ['customBlockSpacing', 'Block gaps', 0, 2], ['customEquationSpacing', 'Equation gaps', 0, 2], ['customListSpacing', 'List item gaps', 0, 1.5]] as const).map(([key, label, min, max]) => <label key={key}>{label} · {settings[key].toFixed(2)}×<input type="range" min={min} max={max} step=".05" value={settings[key]} onChange={event => setPreference(key, Number(event.target.value))} /></label>)}
        <label><input type="checkbox" checked={settings.autoEquations} onChange={event => setPreference('autoEquations', event.target.checked)} />Auto equations</label><label><input type="checkbox" checked={settings.automatic} onChange={event => setPreference('automatic', event.target.checked)} />Automatic calculation</label>
        <label>Angle unit<select value={settings.angleMode} onChange={event => setPreference('angleMode', event.target.value as TeXSettings['angleMode'])}><option>radians</option><option>degrees</option></select></label><p className="tex-note">Preferences save automatically. Calculations run locally.</p>
      </div>}
      {dialog === 'custom' && <form className="tex-settings" onSubmit={event => { event.preventDefault(); setCustom(old => [...old.filter(command => command.id !== editingCommand), { ...newCommand, id: editingCommand ?? `custom-${crypto.randomUUID()}` }]); setEditingCommand(null); setNewCommand(old => ({ ...old, title: '' })); setDialog(null); }}>
        <label>Name<input required value={newCommand.title} onChange={event => setNewCommand(old => ({ ...old, title: event.target.value }))} /></label><label>Category<input value={newCommand.category} onChange={event => setNewCommand(old => ({ ...old, category: event.target.value || 'Custom' }))} /></label><label>Button symbol<input value={newCommand.symbol} onChange={event => setNewCommand(old => ({ ...old, symbol: event.target.value }))} /></label><label>Insert into<select value={newCommand.mode} onChange={event => setNewCommand(old => ({ ...old, mode: event.target.value }))}><option value="math">Equation</option><option value="document">Document source</option><option value="preamble">Preamble</option></select></label><label>LaTeX template<textarea required value={newCommand.latex} onChange={event => setNewCommand(old => ({ ...old, latex: event.target.value }))} /></label><p className="tex-note">#@ uses the selected expression. #? creates a placeholder.</p><button className="button-primary" type="submit" disabled={!newCommand.title.trim()}>{editingCommand ? 'Save command' : 'Add command'}</button>
        {editingCommand && <button type="button" onClick={() => { setEditingCommand(null); setNewCommand(old => ({ ...old, title: '' })); }}>Create another command</button>}
        {!!custom.length && <div className="tex-custom-list"><strong>Saved commands</strong>{custom.map(command => <div key={command.id}><span>{command.title}</span><button type="button" onClick={() => { setEditingCommand(command.id); setNewCommand({ title: command.title, category: command.category, symbol: command.symbol, latex: command.latex, mode: command.mode }); }}>Edit</button><button type="button" aria-label={`Delete ${command.title}`} onClick={() => { setCustom(old => old.filter(item => item.id !== command.id)); if (editingCommand === command.id) { setEditingCommand(null); setNewCommand(old => ({ ...old, title: '' })); } }}>Delete</button></div>)}</div>}
      </form>}
      {dialog === 'shortcut' && shortcutCommand && <form className="tex-settings" onSubmit={event => { event.preventDefault(); let value: string; try { value = canonicalTeXShortcut(shortcutValue); } catch (error) { errorRef.current(errorMessage(error)); return; } if (value && commands.some(command => command.id !== shortcutCommand.id && command.shortcut === value)) { errorRef.current('That shortcut is already assigned to a command.'); return; } setShortcuts(old => ({ ...old, [shortcutCommand.id]: value })); setDialog(null); }}><p>{shortcutCommand.title}</p><label>Shortcut<input value={shortcutValue} placeholder="cmd+alt+f" onChange={event => setShortcutValue(event.target.value)} onKeyDown={event => { if (event.key === 'Tab' || event.key === 'Enter' || !event.metaKey && !event.ctrlKey && !event.altKey) return; event.preventDefault(); setShortcutValue([event.metaKey ? 'cmd' : '', event.ctrlKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : '', event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase()].filter(Boolean).join('+')); }} /></label><button type="button" onClick={() => void navigator.clipboard.writeText(shortcutCommand.latex).catch(error => errorRef.current(errorMessage(error)))}>Copy LaTeX template</button><button className="button-primary" type="submit">Save shortcut</button></form>}
    </dialog>
  </div>;
}
