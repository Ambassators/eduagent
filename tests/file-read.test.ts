import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentFile } from '../src/main/file-read.ts';

function fixture(codes: string[]) {
  let reads = 0, downloads = 0;
  const pauses: number[] = [], waiting: string[] = [];
  const bytes = Buffer.from('SELECT * FROM students;');
  const io = {
    read: async () => { const code = codes[reads++]; if (code) throw Object.assign(new Error('read failed'), { code }); return bytes; },
    download: async () => { downloads++; },
    pause: async (ms: number) => { pauses.push(ms); }
  };
  return { io, bytes, waiting, pauses, reads: () => reads, downloads: () => downloads };
}
test('local reads do not invoke sync helpers or wait', async () => {
  const f = fixture([]);
  assert.equal(await readDocumentFile('/tmp/query.sql', name => f.waiting.push(name), f.io), f.bytes);
  assert.equal(f.downloads(), 0); assert.deepEqual(f.pauses, []);
});
test('a cloud timeout requests download and retries until the bytes are available', async () => {
  const f = fixture(['ETIMEDOUT', 'EAGAIN']);
  assert.equal(await readDocumentFile('/tmp/query.sql', name => f.waiting.push(name), f.io), f.bytes);
  assert.equal(f.reads(), 3); assert.equal(f.downloads(), 1);
  assert.deepEqual(f.waiting, ['query.sql', 'query.sql']); assert.deepEqual(f.pauses, [1000, 2000]);
});
test('persistent timeouts stop retrying and identify the file and recovery options', async () => {
  const f = fixture(['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT']);
  await assert.rejects(readDocumentFile('/tmp/query.sql', () => {}, f.io), /query.sql.*after retrying.*sync app/);
  assert.equal(f.reads(), 3); assert.equal(f.downloads(), 1);
});
test('permission errors are not retried or hidden', async () => {
  const f = fixture(['EACCES']);
  await assert.rejects(readDocumentFile('/tmp/query.sql', () => {}, f.io), { code: 'EACCES' });
  assert.equal(f.reads(), 1); assert.equal(f.downloads(), 0);
});
test('failed native download requests still allow generic sync reads to recover', async () => {
  const f = fixture(['ETIMEDOUT']);
  f.io.download = async () => { throw new Error('Not an iCloud file'); };
  assert.equal(await readDocumentFile('/tmp/query.sql', () => {}, f.io), f.bytes);
});


test('known cloud locations request download before the first read', async () => {
  const order: string[] = [];
  const bytes = Buffer.from('SELECT 1;');
  await readDocumentFile('/Users/example/Library/Mobile Documents/com~apple~CloudDocs/query.sql', () => {}, {
    read: async () => { order.push('read'); return bytes; },
    download: async () => { order.push('download'); },
    pause: async () => {}
  });
  assert.deepEqual(order, ['download', 'read']);
});
