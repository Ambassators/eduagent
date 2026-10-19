import hljs from 'highlight.js/lib/common';
import groovy from 'highlight.js/lib/languages/groovy';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

hljs.registerLanguage('groovy', groovy);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('dockerfile', dockerfile);

const languages: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  kt: 'kotlin', kts: 'kotlin', py: 'python', pyw: 'python', rs: 'rust', rb: 'ruby',
  h: 'c', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  jsonc: 'json', jsonl: 'json', ndjson: 'json', ipynb: 'json',
  toml: 'ini', cfg: 'ini', conf: 'ini', config: 'ini', properties: 'ini', env: 'ini',
  sh: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  gql: 'graphql', proto: 'protobuf', gradle: 'groovy', patch: 'diff',
  vue: 'xml', svelte: 'xml'
};

export function highlightSource(text: string, extension: string): string | null {
  // Large dumps remain readable without blocking the renderer on tokenization.
  if (text.length > 300_000) return null;
  const ext = extension.replace(/^\./, '').toLowerCase(), language = languages[ext] ?? ext;
  if (!hljs.getLanguage(language)) return null;
  try { return hljs.highlight(text, { language, ignoreIllegals: true }).value; }
  catch { return null; }
}
