'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function recordSheetsSyncAttempt(');
const end = source.indexOf('\nfunction syncGoogleSheets(', start);
assert.notEqual(start, -1, 'recordSheetsSyncAttempt must exist');
assert.notEqual(end, -1, 'recordSheetsSyncAttempt must have a closing boundary');
const declaration = source.slice(start, end).trimEnd();

async function runTest(name, fn) {
  try { await fn(); process.stdout.write('PASS ' + name + '\n'); }
  catch (e) { process.stderr.write('FAIL ' + name + ': ' + e.message + '\n'); process.exitCode = 1; }
}

(async () => {
  await runTest('sync attempt timestamp is persisted to settings and in-memory state', async () => {
    let saved = null;
    const context = {
      state: { settings: { currency: 'INR', powerRate: 12, lastSheetsSync: '' } },
      backend: { save: (collection, id, data) => {
        assert.equal(collection, 'settings');
        assert.equal(id, 'main');
        saved = data;
        return Promise.resolve();
      } },
      Date, Promise, console
    };
    vm.createContext(context);
    vm.runInContext(declaration, context);
    const attemptedAt = Date.parse('2026-11-13T10:15:00.000Z');
    assert.equal(await context.recordSheetsSyncAttempt(attemptedAt), true);
    assert.equal(saved.lastSheetsSync, '2026-11-13T10:15:00.000Z');
    assert.equal(context.state.settings.lastSheetsSync, saved.lastSheetsSync);
    assert.equal(saved.powerRate, 12);
  });

  await runTest('failed timestamp persistence does not falsely update in-memory settings', async () => {
    const original = { currency: 'INR', lastSheetsSync: '' };
    const context = {
      state: { settings: original },
      backend: { save: () => Promise.reject(new Error('offline')) },
      Date, Promise, console: { warn: () => {} }
    };
    vm.createContext(context);
    vm.runInContext(declaration, context);
    assert.equal(await context.recordSheetsSyncAttempt(1000), false);
    assert.equal(context.state.settings, original);
    assert.equal(context.state.settings.lastSheetsSync, '');
  });

  await runTest('both successful and failed sync completion paths record the attempt', async () => {
    const start = source.indexOf('function syncGoogleSheets(silent)');
    const finish = source.indexOf('function finish(error,receipt)', start);
    const end = source.indexOf('\n    function pollReceipt()', finish);
    const block = source.slice(finish, end);
    assert.match(block, /recordSheetsSyncAttempt\(started\)/);
    assert.match(block, /if\(error\)/);
  });
})();
