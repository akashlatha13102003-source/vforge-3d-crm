'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function setCloudConfig(');
const end = source.indexOf('\nfunction clearCloudConfig(', start);
assert.ok(start >= 0 && end > start, 'setCloudConfig function must exist');
const functionSource = source.slice(start, end);

function runWith(storage) {
  const context = { localStorage: storage, CLOUD_LOCAL_KEY: 'vforge3d:cloud', JSON, Error };
  vm.createContext(context);
  vm.runInContext(functionSource, context);
  return context.setCloudConfig;
}

let stored = null;
runWith({setItem: (key, value) => { stored = value; },getItem: () => stored})({url:'https://example.supabase.co',refreshToken:'test-refresh'});
assert.ok(stored.includes('test-refresh'), 'successful save must persist settings');

const blocked = runWith({setItem: () => {throw new Error('quota exceeded');},getItem: () => null});
assert.throws(() => blocked({refreshToken:'test-refresh'}), /Could not safely save the cloud connection settings/i);

const mismatch = runWith({setItem: () => {},getItem: () => '{}'});
assert.throws(() => mismatch({refreshToken:'test-refresh'}), /Could not safely save the cloud connection settings/i);

process.stdout.write('PASS cloud settings are verified in browser storage; failed persistence is reported\n');
