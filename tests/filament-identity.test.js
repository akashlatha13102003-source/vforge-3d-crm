'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const start = source.indexOf('function openPurchase(id)');
const end = source.indexOf('\n/* ---------- forms: product ---------- */', start);
assert.ok(start >= 0 && end > start, 'purchase form must exist');
const form = source.slice(start, end);
const oldKey = form.indexOf('var oldKey=p.key||fkey(p)');
const guard = form.indexOf('if(d.key!==oldKey)', oldKey);
const referenceHelper = form.indexOf('var refs=filamentPurchaseReferenceCounts(oldKey,state)', guard);
const stockGuard = form.indexOf('var stockError=filamentPurchaseStockError', guard);
const save = form.indexOf("return save('filaments'");
const deleteStart = form.indexOf('if(p)armDelete(form,function(){');
const deleteGuard = form.indexOf('var deleteError=filamentPurchaseDeleteError', deleteStart);
const deleteCall = form.indexOf("return remove('filaments'", deleteStart);
assert.ok(oldKey >= 0 && guard > oldKey, 'editing a filament identity must compare against its normalized old key');
assert.ok(referenceHelper > guard, 'identity guard must inspect all historical usage references');
assert.ok(stockGuard > guard && save > stockGuard, 'purchase stock validation must run before saving');
assert.ok(deleteGuard > deleteStart && deleteCall > deleteGuard, 'purchase deletion must validate stock and references before removing the record');
assert.match(form.slice(guard, save), /return fail\(form,/, 'blocked identity or stock edits must explain how to proceed');

process.stdout.write('PASS filament identity edits are blocked while any historical usage references the old key\n');
