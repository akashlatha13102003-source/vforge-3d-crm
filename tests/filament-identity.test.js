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
const productRefs = form.indexOf('product.lines||[]', guard);
const wastageRefs = form.indexOf('entry.filamentKey===oldKey', guard);
const salesRefs = form.indexOf('var salesRefs=(state.sales||[]).filter', guard);
const marketingRefs = form.indexOf('var marketingRefs=(state.marketing||[]).filter', guard);
const stockGuard = form.indexOf('var stockError=filamentPurchaseStockError', guard);
const save = form.indexOf("return save('filaments'");
assert.ok(oldKey >= 0 && guard > oldKey, 'editing a filament identity must compare against its normalized old key');
assert.ok(productRefs > guard, 'identity guard must check product recipe references');
assert.ok(wastageRefs > guard, 'identity guard must check wastage references');
assert.ok(salesRefs > guard, 'identity guard must check historical sales usage references');
assert.ok(marketingRefs > guard, 'identity guard must check Marketing usage references');
assert.ok(stockGuard > guard && save > stockGuard, 'purchase stock validation must run before saving');
assert.match(form.slice(guard, save), /return fail\(form,/, 'blocked identity or stock edits must explain how to proceed');

process.stdout.write('PASS filament identity edits are blocked while any historical usage references the old key\n');
