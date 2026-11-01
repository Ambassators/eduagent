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
