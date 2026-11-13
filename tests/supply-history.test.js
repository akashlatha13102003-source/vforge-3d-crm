'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const start = source.indexOf("else if(a.indexOf('delete-supply:')===0)");
assert.notEqual(start, -1, 'supply delete handler must exist');
const end = source.indexOf("\n", start);
const handler = source.slice(start, end < 0 ? source.length : end);
const guard = handler.indexOf("state.products.some");
const deletion = handler.indexOf("remove('supplies'");
assert.ok(guard >= 0, 'supply deletion must check product recipe references');
assert.ok(deletion > guard, 'reference guard must run before deleting supply history');
assert.match(handler, /if\(referenced\)\{toast\(/, 'referenced supplies must be blocked with a user-facing explanation');

process.stdout.write('PASS supplies referenced by product recipes cannot be deleted\n');
