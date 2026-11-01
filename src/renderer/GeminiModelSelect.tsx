import { useEffect, useState } from 'react';
import type { GeminiModelOption } from '../gemini';

export default function GeminiModelSelect({ name, label, value, models, onChange, onCommit }: { name: string; label: string; value: string; models: GeminiModelOption[]; onChange(value: string, save: boolean): void; onCommit(): void }) {
  const [other, setOther] = useState(false);
  useEffect(() => { if (models.some(model => model.model === value)) setOther(false); }, [value, models]);
  const custom = other || !models.some(model => model.model === value);
  return <>
    <label className="field"><span>{label}</span><select name={name} value={custom ? '__other__' : value} onChange={event => {
      const selected = event.target.value;
      setOther(selected === '__other__');
      if (selected !== '__other__') onChange(selected, true);
    }}>{models.map(model => <option key={model.model} value={model.model}>{model.displayName}</option>)}<option value="__other__">Other…</option></select></label>
    {custom && <label className="field"><span>Custom model ID</span><input name={`${name}Custom`} maxLength={150} value={value} onChange={event => onChange(event.target.value, false)} onBlur={onCommit} placeholder="Enter a Gemini model ID"/></label>}
  </>;
}

/** Comma-separated fallback model IDs, tried in order when the selected model is limited on every key. */
export function GeminiFallbackModels({ name, value, models, onCommit }: { name: string; value: string[]; models: GeminiModelOption[]; onCommit(value: string[]): void }) {
  const [draft, setDraft] = useState(value.join(', '));
  useEffect(() => setDraft(value.join(', ')), [value]);
  const commit = () => {
    const next = [...new Set(draft.split(/[\s,]+/).map(item => item.trim().replace(/^models\//, '')).filter(Boolean))].slice(0, 5);
    setDraft(next.join(', '));
    if (next.join() !== value.join()) onCommit(next);
  };
  return <label className="field wide" title="When the selected model is rate-limited, overloaded or unavailable on every API key, these are tried in order."><span>Fallback models</span>
    <input name={name} maxLength={800} value={draft} list={`${name}Options`} placeholder={`Optional, e.g. ${models.slice(1, 3).map(model => model.model).join(', ')}`}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); }}/>
    <datalist id={`${name}Options`}>{models.map(model => <option key={model.model} value={model.model}>{model.displayName}</option>)}</datalist>
  </label>;
}
