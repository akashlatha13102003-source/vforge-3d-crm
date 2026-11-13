'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function refresh(silent){');
const end = source.indexOf('\n}\n\n/* ---------- boot ---------- */', start);
assert.ok(start >= 0 && end > start, 'refresh function must exist');
const block = source.slice(start, end + 2);
assert.ok(block.includes('Promise.all(COLS.map(function(c){return Promise.resolve(backend.fetch(c));}))'),
  'all collections must be fetched before state is changed');
assert.ok(block.includes('COLS.forEach(function(c,index){onDocs(c,results[index]);})'),
  'state updates must happen only after every fetch succeeds');
assert.ok(!block.includes('backend.fetch(c)).then(function(docs){onDocs(c,docs)'),
  'individual collection responses must not be applied before all fetches complete');
assert.match(block, /Your previous view was kept unchanged/i,
  'failed refresh must tell the user that the last complete view was retained');
process.stdout.write('PASS refresh applies an all-collection snapshot atomically and retains prior state on failure\n');
