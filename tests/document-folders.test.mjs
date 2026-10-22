import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../dist/main/main/documents.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-voice-folders-')));
  const notes = path.join(root, 'Chemistry');
  await mkdir(path.join(notes, 'nested'), { recursive: true });
  await writeFile(path.join(notes, 'b.txt'), 'second');
  await writeFile(path.join(notes, 'a.md'), '# first');
  await writeFile(path.join(notes, '.hidden.txt'), 'hidden');
  await writeFile(path.join(notes, 'archive.zip'), Buffer.from([0x50, 0x4b, 0, 0]));
  await writeFile(path.join(notes, 'nested', 'c.txt'), 'nested');
  await writeFile(path.join(root, 'loose.txt'), 'loose');
  return { root, notes, store: path.join(root, 'store') };
}

test('opening a folder from disk groups its documents and reuses the folder', async () => {
  const { root, notes, store } = await fixture();
  try {
    const documents = new DocumentStore(store, () => {});
    await documents.initialize();
    await documents.open([notes]);
    const [folder] = documents.listFolders();
    assert.equal(folder.name, 'Chemistry');
    assert.equal(folder.path, notes);
    assert.deepEqual(documents.list().map(file => [file.name, file.folderId]), [['a.md', folder.id], ['b.txt', folder.id]]);
    assert.equal(documents.activeId, documents.list()[0].id);
    assert.match(documents.context(), /a\.md \(markdown\) in folder "Chemistry"/);

    await documents.open([notes]);
    assert.equal(documents.listFolders().length, 1);
    assert.equal(documents.list().length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folders can be created, renamed, filled, emptied and restored after restart', async () => {
  const { root, store } = await fixture();
  try {
    const documents = new DocumentStore(store, () => {});
    await documents.initialize();
    await documents.open([path.join(root, 'loose.txt')]);
    const file = documents.list()[0];
    const first = await documents.createFolder('  Week   1 ');
    const second = await documents.createFolder('Week 1', [file.id]);
    assert.deepEqual(documents.listFolders().map(folder => folder.name), ['Week 1', 'Week 1 2']);
    assert.equal(documents.list()[0].folderId, second);

    await documents.moveFile(file.id, first);
    await documents.renameFolder(first, 'Reading');
    await documents.setFolderCollapsed(first, true);
    const reopened = new DocumentStore(store, () => {});
    await reopened.initialize();
    assert.deepEqual(reopened.listFolders().map(({ name, collapsed }) => ({ name, collapsed })), [{ name: 'Reading', collapsed: true }, { name: 'Week 1 2', collapsed: false }]);
    assert.equal(reopened.list()[0].folderId, first);

    await reopened.moveFile(file.id, null);
    assert.equal(reopened.list()[0].folderId, undefined);
    await reopened.moveFile(file.id, first);
    await reopened.deleteFolder(first);
    assert.equal(reopened.listFolders().length, 1);
    assert.equal(reopened.list().length, 1, 'deleting a folder keeps its files open');
    assert.equal(reopened.list()[0].folderId, undefined);
    await assert.rejects(reopened.moveFile(file.id, first), /no longer exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a folder with no supported documents is rejected', async () => {
  const { root, store } = await fixture();
  try {
    const documents = new DocumentStore(store, () => {});
    await documents.initialize();
    await mkdir(path.join(root, 'empty'));
    await writeFile(path.join(root, 'empty', 'archive.zip'), Buffer.from([0x50, 0x4b, 0, 0]));
    await assert.rejects(documents.open([path.join(root, 'empty')]), /no documents this app can open/);
    assert.equal(documents.listFolders().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
