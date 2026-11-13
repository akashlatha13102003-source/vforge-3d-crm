'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const start = source.indexOf('function openPurchase(id)');
const end = source.indexOf('\n/* ---------- forms: product ---------- */', start);
assert.ok(start >= 0 && end > start, 'purchase form must exist');
const form = source.slice(start, end);
const guard = form.indexOf('if(p&&d.key!==p.key)');
const productRefs = form.indexOf('product.lines||[]');
const wastageRefs = form.indexOf('entry.filamentKey===oldKey');
const save = form.indexOf("return save('filaments'");
assert.ok(guard >= 0, 'editing a filament identity must be guarded');
assert.ok(productRefs > guard, 'guard must check product recipe references');
assert.ok(wastageRefs > guard, 'guard must check wastage references');
assert.ok(save > wastageRefs, 'reference guard must run before saving the changed identity');
assert.match(form.slice(guard, save), /return fail\(form,/, 'blocked identity edits must explain how to proceed');

process.stdout.write('PASS filament identity edits are blocked while recipes or wastage reference the old key\n');
