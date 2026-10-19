export const textFileExtensions = [
  'txt', 'text', 'log', 'sql', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'ndjson',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'css', 'scss', 'sass', 'less',
  'py', 'pyw', 'java', 'kt', 'kts', 'gradle', 'groovy', 'c', 'h', 'cpp', 'hpp',
  'cc', 'cxx', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'cmd', 'r', 'lua', 'vue', 'svelte', 'graphql', 'gql', 'proto',
  'ipynb', 'tf', 'hcl', 'dockerfile', 'gitignore', 'editorconfig', 'diff', 'patch'
];

export const documentFileFilters = [
  { name: 'Supported files', extensions: [
    'quiz', 'pdf', 'docx', 'doc', 'odt', 'tex', 'ltx', 'latex', 'md', 'markdown', 'mdx',
    'rtf', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', ...textFileExtensions
  ] },
  { name: 'Text, source code and configuration', extensions: textFileExtensions },
  { name: 'All files', extensions: ['*'] }
];
