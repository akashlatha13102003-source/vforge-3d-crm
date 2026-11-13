'use strict';

// Exercise the actual local backend from index.html with a controlled storage adapter.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function makeLocalBackend(){');
const end = source.indexOf('\nfunction errMsg(', start);
assert.notEqual(start, -1, 'makeLocalBackend must exist');
assert.notEqual(end, -1, 'makeLocalBackend must have a closing boundary');
const declaration = source.slice(start, end).trimEnd();

function harness(initial, failWrites) {
  const data = Object.assign({}, initial || {});
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { if (failWrites === 'all' || (failWrites && key !== 'vforge3d:t')) throw new Error('quota exceeded'); data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
  const context = { COLS: ['products'], localStorage, Promise, Date, Math };
  vm.createContext(context);
  vm.runInContext(declaration, context);
  return { backend: context.makeLocalBackend(), data };
}

async function test(name, fn) {
  try { await fn(); process.stdout.write('PASS ' + name + '\n'); }
  catch (e) { process.stderr.write('FAIL ' + name + ': ' + e.message + '\n'); process.exitCode = 1; }
}

(async () => {
  await test('corrupt collection is reported and original bytes are preserved', async () => {
    const raw = '{broken-json';
    const h = harness({ 'vforge3d:products': raw });
    assert.match(h.backend.warning, /could not be read/i);
    assert.equal(h.data['vforge3d:products'], raw);
    await assert.rejects(h.backend.save('products', 'p1', { name: 'New' }), /Saving is disabled/i);
    assert.equal(h.data['vforge3d:products'], raw);
  });

  await test('valid local records load and successful writes persist before notifying', async () => {
    const h = harness({ 'vforge3d:products': '[{"id":"p1","name":"Old"}]' });
    assert.deepEqual(JSON.parse(JSON.stringify(await h.backend.fetch('products'))), [{ id: 'p1', name: 'Old' }]);
    await h.backend.save('products', 'p2', { name: 'New' });
    assert.deepEqual(JSON.parse(h.data['vforge3d:products']), [
      { id: 'p1', name: 'Old' }, { id: 'p2', name: 'New' }
    ]);
  });

  await test('browser storage write failure rejects without changing in-memory records', async () => {
    const h = harness({ 'vforge3d:products': '[{"id":"p1","name":"Old"}]' }, true);
    await assert.rejects(h.backend.save('products', 'p2', { name: 'New' }), /Your change was not saved/i);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.backend.fetch('products'))), [{ id: 'p1', name: 'Old' }]);
  });

  await test('unavailable browser storage is clearly reported and writes are blocked', async () => {
    const h = harness({}, 'all');
    assert.equal(h.backend.kind, 'memory');
    assert.match(h.backend.warning, /changes are disabled/i);
    await assert.rejects(h.backend.save('products', 'p1', { name: 'New' }), /storage is unavailable/i);
  });
})();
