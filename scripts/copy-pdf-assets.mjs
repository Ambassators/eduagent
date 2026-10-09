import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const source=path.dirname(require.resolve('pdfjs-dist/package.json'));
const destination=path.resolve('dist/renderer/pdf-assets');
await mkdir(destination,{recursive:true});
for(const folder of ['standard_fonts','cmaps','wasm'])await cp(path.join(source,folder),path.join(destination,folder),{recursive:true});
