'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function makeUnavailableBackend(');
const end = source.indexOf('\nfunction makeSupabaseBackend(', start);
assert.notEqual(start, -1, 'makeUnavailableBackend must exist');
assert.notEqual(end, -1, 'makeUnavailableBackend must have a closing boundary');
const declaration = source.slice(start, end).trimEnd();

(async () => {
  const context = { Promise, Date, Math };
  vm.createContext(context);
  vm.runInContext(declaration, context);
  const backend = context.makeUnavailableBackend('refresh token expired');
  assert.equal(backend.kind, 'cloud-error');
  assert.match(backend.warning, /browser-local records were not substituted/i);
  for (const operation of ['fetch', 'save', 'remove']) {
    await assert.rejects(backend[operation]('products', 'p1', { name: 'x' }), /Cloud connection failed/i);
  }
  let reported = null;
  backend.subscribe('products', () => {}, error => { reported = error; });
  assert.match(reported.message, /refresh token expired/i);

  const bootStart = source.indexOf('function boot(){');
  const bootEnd = source.indexOf('\nboot();', bootStart);
  const boot = source.slice(bootStart, bootEnd);
  const cloudBranch = boot.slice(boot.indexOf('if(cc.url&&cc.anonKey&&cc.refreshToken)'));
  const refreshCall = cloudBranch.indexOf('return cloudRefresh().then(function(){');
  const catchStart = cloudBranch.indexOf('}).catch(function(error){', refreshCall);
  const catchEnd = cloudBranch.indexOf('});', catchStart);
  assert.ok(refreshCall >= 0 && catchStart > refreshCall && catchEnd > catchStart,
    'the configured cloud refresh failure handler must exist');
  const failurePath = cloudBranch.slice(catchStart, catchEnd);
  assert.ok(failurePath.includes('makeUnavailableBackend(error&&error.message)'),
    'a configured cloud session failure must use the unavailable backend');
  assert.ok(!failurePath.includes('makeLocalBackend()'),
    'a configured cloud session failure must not silently switch to local storage');
  assert.match(source, /state\.storage==='cloud-error'/,
    'the UI must show an explicit cloud connection failure notice');
  process.stdout.write('PASS cloud refresh failure blocks writes instead of switching to local data\n');
})().catch(error => {
  process.stderr.write('FAIL cloud fail-closed checks: ' + error.message + '\n');
  process.exitCode = 1;
});
