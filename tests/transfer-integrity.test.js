'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function openTransfer()');
const end = source.indexOf('\nfunction custStats()', start);
assert.ok(start >= 0 && end > start, 'transfer form must exist');
const form = source.slice(start, end);
assert.ok(form.includes('function writeNext(index)'), 'grouped transfers must use sequential writes');
assert.ok(form.includes('return writeNext(0)'), 'sequential writer must start at the first record');
assert.ok(form.includes('function rollback(error)'), 'failed batches must trigger rollback');
assert.ok(form.includes('syncStateAfterSave(\'transfers\')'), 'transfer collection must refresh after completion or rollback');
assert.ok(form.includes("queueAutoSheetsSync('saved:transfers')"), 'successful grouped transfer must queue one Sheets sync');
assert.ok(!form.includes('Promise.all(items.map'), 'grouped transfers must not use parallel independent saves');
process.stdout.write('PASS grouped transfers write sequentially and roll back partial batches\n');
