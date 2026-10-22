'use strict';

const assert = require('node:assert/strict');
const { createSharedWorkspaceAdapter } = require('../src/shared-workspace-adapter.js');

function test(name, fn) {
  Promise.resolve().then(fn).then(
    () => process.stdout.write('PASS ' + name + '\n'),
    error => { process.stderr.write('FAIL ' + name + ': ' + error.message + '\n'); process.exitCode = 1; }
  );
}

function makeSupabase(result = { data: [], error: null }) {
  const calls = [];
  const chain = {
    select(value) { calls.push(['select', value]); return this; },
    eq(key, value) { calls.push(['eq', key, value]); return this; },
    order(key, value) { calls.push(['order', key, value]); return Promise.resolve(result); },
    upsert(payload, options) { calls.push(['upsert', payload, options]); return this; },
    single() { calls.push(['single']); return Promise.resolve(result); },
    delete() { calls.push(['delete']); return this; }
  };
  return { client: { from(name) { calls.push(['from', name]); return chain; } }, calls };
}

const base = { userId: 'user-1', workspaceId: 'workspace-1', role: 'admin' };

test('requires verified user, workspace, role, and client', () => {
  assert.throws(() => createSharedWorkspaceAdapter({ ...base, supabase: null }), /Supabase client/);
  const { client } = makeSupabase();
  assert.throws(() => createSharedWorkspaceAdapter({ ...base, supabase: client, workspaceId: '' }), /workspace ID/);
  assert.throws(() => createSharedWorkspaceAdapter({ ...base, supabase: client, role: 'owner' }), /membership role/);
});

test('reads are explicitly scoped to the selected workspace and collection', async () => {
  const { client, calls } = makeSupabase({ data: [{ id: 'p1' }], error: null });
  const adapter = createSharedWorkspaceAdapter({ ...base, supabase: client });
  const rows = await adapter.list('products');
  assert.equal(rows.length, 1);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'workspace_id' && c[2] === 'workspace-1'));
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'collection' && c[2] === 'products'));
});

test('saves include workspace scope and use the workspace composite conflict key', async () => {
  const { client, calls } = makeSupabase({ data: { id: 'p1' }, error: null });
  const adapter = createSharedWorkspaceAdapter({ ...base, supabase: client });
  await adapter.save('products', { id: 'p1', data: { name: 'Test' } });
  const write = calls.find(c => c[0] === 'upsert');
  assert.equal(write[1].workspace_id, 'workspace-1');
  assert.equal(write[1].user_id, 'user-1');
  assert.equal(write[1].collection, 'products');
  assert.deepEqual(write[2], { onConflict: 'workspace_id,collection,id' });
});

test('deletes are scoped to workspace, collection, and record ID', async () => {
  const { client, calls } = makeSupabase({ data: [{ id: 'p1' }], error: null });
  const adapter = createSharedWorkspaceAdapter({ ...base, supabase: client });
  await adapter.remove('products', 'p1');
  for (const [key, value] of [['workspace_id', 'workspace-1'], ['collection', 'products'], ['id', 'p1']]) {
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === key && c[2] === value), 'missing filter ' + key);
  }
});

test('rejects invalid collection names and malformed writes before database calls', async () => {
  const { client, calls } = makeSupabase();
  const adapter = createSharedWorkspaceAdapter({ ...base, supabase: client });
  await assert.rejects(() => adapter.list('products;delete'), /collection name/);
  await assert.rejects(() => adapter.save('products', { id: '', data: {} }), /record ID/);
  await assert.rejects(() => adapter.save('products', { id: 'p1' }), /Record data/);
  assert.equal(calls.length, 0);
});

test('propagates database errors rather than reporting false success', async () => {
  const dbError = new Error('RLS denied');
  const { client } = makeSupabase({ data: null, error: dbError });
  const adapter = createSharedWorkspaceAdapter({ ...base, supabase: client });
  await assert.rejects(() => adapter.list('products'), /RLS denied/);
});
