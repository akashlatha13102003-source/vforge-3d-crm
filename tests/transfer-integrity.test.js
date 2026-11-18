'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function openTransfer()');
const end = source.indexOf('\nfunction custStats()', start);
assert.ok(start >= 0 && end > start, 'transfer form must exist');
const form = source.slice(start, end);
assert.ok(form.includes('function writeNext(index)'), 'grouped transfers must use sequential writes');
assert.ok(form.includes('return writeNext(0)'), 'sequential writer must start at the first record');
assert.ok(form.includes('function rollback(error)'), 'failed batches must trigger rollback');
assert.ok(form.includes("syncStateAfterSave('transfers')"), 'transfer collection must refresh after completion or rollback');
assert.ok(form.includes("queueAutoSheetsSync('saved:transfers')"), 'successful grouped transfer must queue one Sheets sync');
assert.ok(!form.includes('Promise.all(items.map'), 'grouped transfers must not use parallel independent saves');
assert.ok(form.includes('rollbackTransferBatch(records,'), 'rollback must target every generated record ID, not only confirmed writes');
assert.ok(!form.includes('saved.push(record)'), 'a rejected write must not be assumed to be uncommitted');

const helperStart = source.indexOf('function rollbackTransferBatch(');
const helperEnd = source.indexOf('\nfunction openTransfer()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'rollback helper must be independently testable');
const context = { Promise };
vm.createContext(context);
vm.runInContext(source.slice(helperStart, helperEnd), context);

(async () => {
  const records = [{ id: 'confirmed-write' }, { id: 'ambiguous-write' }];
  const removed = [];
  let refreshed = false;
  const result = await context.rollbackTransferBatch(
    records,
    id => {
      removed.push(id);
      return id === 'ambiguous-write' ? Promise.reject(new Error('response lost after possible commit')) : Promise.resolve();
    },
    () => { refreshed = true; return Promise.resolve(); }
  );
  assert.deepEqual(removed, records.map(record => record.id), 'cleanup must attempt every generated ID, including the ambiguous write');
  assert.deepEqual(Array.from(result.failedIds), ['ambiguous-write'], 'failed cleanup must be reported');
  assert.equal(result.refreshed, true, 'refresh must still be attempted after a cleanup failure');

  const refreshFailure = await context.rollbackTransferBatch(
    [{ id: 'one' }],
    () => Promise.resolve(),
    () => Promise.reject(new Error('refresh unavailable'))
  );
  assert.equal(refreshFailure.refreshed, false, 'refresh failure must be reported separately');
  process.stdout.write('PASS grouped transfers rollback every generated ID after ambiguous failures\\n');
})().catch(error => {
  process.stderr.write('FAIL transfer rollback recovery: ' + error.message + '\\n');
  process.exitCode = 1;
});
