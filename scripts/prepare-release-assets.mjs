import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

// Native Mac runners each produce a manifest; keep both architectures in one update feed.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Provide package and release asset directories.');
await mkdir(destination, { recursive: true });
const assets = new Map(), macManifests = [];
for (const directory of await readdir(source, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  for (const name of await readdir(path.join(source, directory.name))) {
    const bytes = await readFile(path.join(source, directory.name, name));
    if (name === 'latest-mac.yml') { macManifests.push(yaml.load(bytes.toString())); continue; }
    if (assets.has(name)) assert.ok(assets.get(name).equals(bytes), `Conflicting release asset: ${name}`);
    assets.set(name, bytes);
  }
}
if (macManifests.length) {
  const [first] = macManifests;
  const files = new Map();
  for (const manifest of macManifests) {
    assert.equal(manifest.version, first.version, 'Mac manifests must share a version.');
    for (const file of manifest.files) {
      if (files.has(file.url)) assert.deepEqual(files.get(file.url), file, 'Conflicting Mac update file.');
      files.set(file.url, file);
    }
  }
  assets.set('latest-mac.yml', Buffer.from(yaml.dump({ ...first, files: [...files.values()] })));
}
assert.ok(assets.size, 'No release assets were found.');
for (const [name, bytes] of assets) await writeFile(path.join(destination, name), bytes);
console.log(`Prepared ${assets.size} release assets.`);
