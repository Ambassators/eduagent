import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/extensions', { recursive: true });
await cp('extensions', 'dist/extensions', { recursive: true });
for (const browser of ['chromium','firefox']) await cp('extensions/common', `dist/extensions/${browser}`, { recursive: true });
