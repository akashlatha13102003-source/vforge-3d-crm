'use strict';

// Regression tests run against the actual pure business-logic functions extracted
// from index.html, so the checks fail if those source functions change behavior.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' must exist in index.html');
  // In this file, the declaration's closing brace is on its own unindented line.
  const end = source.indexOf('\nfunction ', start + 10);
  assert.notEqual(end, -1, 'function ' + name + ' must have a closing brace');
  return source.slice(start, end).trimEnd();
}

const declarations = [
  'productGst', 'saleLines', 'productSoldQty', 'productAvailableQty',
  'productExtraQtyForSale', 'productSavedExtraQtyForSale', 'saleRev', 'saleTax', 'saleTaxable',
  'saleCost', 'saleProfit', 'getStats', 'powerOf', 'productCost', 'wastageExceedsStock'
].map(extractFunction).join('\n');

const context = {
  num: v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; },
  safeHex: h => /^#[0-9a-f]{6}$/i.test(h || '') ? h : '#8a8f94',
  fkey: o => [o.brand, o.material, o.colour].map(v => String(v || '').trim().toLowerCase()).join('|'),
  fname: o => [o.brand, o.material, o.colour].filter(Boolean).join(' '),
  ver: 1,
  statsVer: -1,
  statsCache: null,
  state: { filaments: [], products: [], sales: [], wastage: [], printers: [], settings: { powerRate: 10.50 } },
};
vm.createContext(context);
vm.runInContext(declarations, context);

function approx(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.001, label + ': expected ' + expected + ', got ' + actual);
}

function test(name, fn) {
  try { fn(); process.stdout.write('PASS ' + name + '\n'); }
  catch (e) { process.stderr.write('FAIL ' + name + ': ' + e.message + '\n'); process.exitCode = 1; }
}

test('legacy sale with zero saved unit cost falls back to current product recipe cost', () => {
  context.state = {
    filaments: [{ key: 'green', brand: 'Anycubic', material: 'PLA', colour: 'Green', weight: 600, spools: 1, total: 600 }],
    products: [{ id: 'funko', name: 'Akash Funko', lines: [{ key: 'green', grams: 145 }], printerId: 'kobra', printHours: 4.116, otherCost: 50, quantityMade: 3 }],
    sales: [{ id: 'sale-1', lineItems: [{ productId: 'funko', productName: 'Akash Funko', qty: 3, unitPrice: 700, unitCost: 0 }] }],
    wastage: [], printers: [{ id: 'kobra', watts: 500 }], settings: { powerRate: 10.5 }
  };
  context.statsCache = null;
  context.statsVer = -1;
  context.ver = (context.ver || 0) + 1;
  approx(context.saleCost(context.state.sales[0]), 649.83, 'three units should cost 3 × 216.61');
});

test('GST-exclusive price adds tax without changing taxable value', () => {
  const result = context.productGst({ gstRate: 18, priceMode: 'exclusive' }, 100);
  assert.equal(result.taxable, 100);
  assert.equal(result.gst, 18);
  assert.equal(result.total, 118);
});

test('GST-inclusive price extracts tax from final price', () => {
  const result = context.productGst({ gstRate: 18, priceMode: 'inclusive' }, 118);
  assert.equal(result.taxable, 100);
  assert.equal(result.gst, 18);
  assert.equal(result.total, 118);
});

test('multi-item invoice totals and profit exclude collected GST', () => {
  const sale = { lineItems: [
    { productId: 'a', productName: 'A', qty: 2, unitPrice: 100, unitCost: 40, taxableUnit: 100, gstUnit: 18, finalUnit: 118, gstRate: 18, priceMode: 'exclusive' },
    { productId: 'b', productName: 'B', qty: 1, unitPrice: 118, unitCost: 50, taxableUnit: 100, gstUnit: 18, finalUnit: 118, gstRate: 18, priceMode: 'inclusive' }
  ] };
  approx(context.saleRev(sale), 354, 'invoice total');
  approx(context.saleTaxable(sale), 300, 'taxable value');
  approx(context.saleTax(sale), 54, 'GST amount');
  approx(context.saleCost(sale), 130, 'cost');
  approx(context.saleProfit(sale), 170, 'profit before GST remittance');
});

test('legacy single-product sale still calculates total and taxable value', () => {
  const sale = { productId: 'legacy', qty: 2, unitPrice: 100, unitCost: 40, gstRate: 18, priceMode: 'exclusive' };
  approx(context.saleRev(sale), 236, 'legacy invoice total');
  approx(context.saleTaxable(sale), 200, 'legacy taxable value');
  approx(context.saleCost(sale), 80, 'legacy cost');
  approx(context.saleProfit(sale), 120, 'legacy profit');
});

test('quantity made deducts recipe stock once, with only excess sales deducting extra', () => {
  context.state = {
    filaments: [{ id: 'purchase-1', key: 'brand|pla|red', brand: 'Brand', material: 'PLA', colour: 'Red', hex: '#ff0000', weight: 1000, spools: 1, total: 2000, date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' }],
    products: [{ id: 'p1', name: 'Test product', quantityMade: 3, lines: [{ key: 'brand|pla|red', grams: 100 }] }],
    sales: [{ id: 's1', productId: 'p1', qty: 2, unitPrice: 100, unitCost: 10 }],
    wastage: [], settings: {}
  };
  context.ver++; context.statsCache = null;
  approx(context.getStats().get('brand|pla|red').left, 700, 'stock after 3 made and 2 sold');
  context.state.sales[0].qty = 4;
  context.ver++; context.statsCache = null;
  approx(context.getStats().get('brand|pla|red').left, 600, 'stock after 3 made and 4 sold');
});


test('product availability subtracts sold quantity from quantity made', () => {
  context.state = {
    products: [{ id: 'p1', quantityMade: 2, lines: [] }],
    sales: [{ id: 's1', productId: 'p1', qty: 1 }],
    filaments: [], wastage: [], settings: {}
  };
  assert.equal(context.productAvailableQty('p1'), 1, 'one of two made remains after one sale');
  assert.equal(context.productAvailableQty('p1', 's1'), 2, 'editing a sale excludes that sale from current stock');
});

test('sale filament warning counts only pieces beyond available finished stock', () => {
  context.state = {
    products: [{ id: 'p1', quantityMade: 2, lines: [{ key: 'pla|green', grams: 145 }] }],
    sales: [], filaments: [], wastage: [], settings: {}
  };
  assert.equal(context.productExtraQtyForSale('p1', 3, null), 1, 'selling three when two are made requires one additional print');
  assert.equal(145 * context.productExtraQtyForSale('p1', 3, null), 145, 'only 145g is required for the third piece');
  context.state.sales = [{ id: 's1', productId: 'p1', qty: 3 }];
  assert.equal(context.productSavedExtraQtyForSale('p1', 's1'), 1, 'editing the saved sale adds back only its one excess-produced piece');
  assert.equal(context.productExtraQtyForSale('p1', 3, 's1'), 1, 'editing the saved sale still needs only one extra piece');
});


test('sale form explicitly warns when additional finished pieces need printing', () => {
  const start = source.indexOf('function openSale(');
  const end = source.indexOf('/* ---------- forms: customer ---------- */', start);
  const form = source.slice(start, end);
  assert.match(form, /if\(extraQty>0\)warnings\.push\('Finished stock:/);
  assert.match(form, /additional piece/);
  assert.match(form, /requiring '\+fmtG\(need\)/);
});

test('sales covered by existing finished stock require no additional filament', () => {
  context.state = {
    products: [{ id: 'p1', quantityMade: 5, lines: [{ key: 'pla|green', grams: 145 }] }],
    sales: [{ id: 's1', productId: 'p1', qty: 2 }],
    filaments: [], wastage: [], settings: {}
  };
  assert.equal(context.productAvailableQty('p1'), 3);
  assert.equal(context.productExtraQtyForSale('p1', 3, null), 0);
});

test('wastage reduces filament stock once and recalculates on edit/delete', () => {
  context.state = {
    filaments: [{ id: 'purchase-1', key: 'brand|pla|red', brand: 'Brand', material: 'PLA', colour: 'Red', hex: '#ff0000', weight: 1000, spools: 1, total: 2000, date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' }],
    products: [], sales: [],
    wastage: [{ id: 'w1', filamentKey: 'brand|pla|red', grams: 100 }],
    settings: {}
  };
  context.ver++; context.statsCache = null;
  approx(context.getStats().get('brand|pla|red').left, 900, 'stock after 100g wastage');
  context.state.wastage[0].grams = 150;
  context.ver++; context.statsCache = null;
  approx(context.getStats().get('brand|pla|red').left, 850, 'stock after editing wastage to 150g');
  context.state.wastage = [];
  context.ver++; context.statsCache = null;
  approx(context.getStats().get('brand|pla|red').left, 1000, 'stock after deleting wastage');
});


test('cloud record reads and deletes are explicitly scoped to the signed-in user', () => {
  assert.match(source, /function rows\(col\)[\s\S]{0,350}user_id=eq\.'\+encodeURIComponent\(cloudSession\.user\.id\)/);
  assert.match(source, /remove:function\(col,id\)[\s\S]{0,450}user_id=eq\.'\+encodeURIComponent\(cloudSession\.user\.id\)/);
  assert.match(source, /user_id:cloudSession\.user\.id/);
});

test('JSON backup export includes all eight CRM collections/settings', () => {
  const exportStart = source.indexOf("offerFile('vforge-3d-backup.json'");
  assert.notEqual(exportStart, -1, 'JSON backup export action must exist');
  const exportHandler = source.slice(exportStart, exportStart + 700);
  for (const key of ['filaments','printers','products','customers','sales','wastage','transfers','settings']) {
    assert.match(exportHandler, new RegExp(key + ':state\\.' + key));
  }
});
test('Google Sheets payload includes all report groups supported by the CRM', () => {
  const start = source.indexOf('function sheetsPayload(){');
  assert.notEqual(start, -1, 'sheetsPayload must exist');
  const end = source.indexOf('function testGoogleSheets()', start);
  assert.notEqual(end, -1, 'sheetsPayload must end before testGoogleSheets');
  const payload = source.slice(start, end);
  for (const key of ['filament','products','sales','customers','wastage','branchTransfers']) {
    assert.ok(payload.includes(key + ':'), 'Sheets payload must include ' + key);
  }
});


test('Supabase preflight remains read-only and covers required security metadata', () => {
  const sql = fs.readFileSync('docs/READ_ONLY_SUPABASE_SECURITY_PREFLIGHT.sql', 'utf8');
  const executable = sql.replace(/--.*$/gm, '').toLowerCase();
  for (const fragment of [
    'from pg_policies',
    'from information_schema.columns',
    'from pg_constraint',
    'group by workspace_id, collection',
    'having count(*) > 1',
    'relrowsecurity'
  ]) assert.ok(executable.includes(fragment), 'preflight SQL must include ' + fragment);
  assert.doesNotMatch(executable, /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/, 'preflight SQL must not mutate database state');
});


test('shared-workspace migration checklist remains explicitly review-only', () => {
  const checklist = fs.readFileSync('docs/SHARED_WORKSPACE_MIGRATION_REVIEW_CHECKLIST.md', 'utf8');
  assert.match(checklist, /draft \/ not approved for production/i);
  assert.match(checklist, /Replace—not merely supplement—the existing permissive user-only record policies/);
  assert.match(checklist, /separate Admin, Staff, and second workspace/);
  assert.match(checklist, /No database migration has been run by this checklist/);
});


test('workspace rollout runbook requires staging and coordinated app/database cutover', () => {
  const runbook = fs.readFileSync('docs/SHARED_WORKSPACE_ROLLOUT_RUNBOOK.md', 'utf8');
  assert.match(runbook, /Status: draft only/);
  assert.match(runbook, /staging database migration and RLS tests/i);
  assert.match(runbook, /Replace the four permissive user-only policies/);
  assert.match(runbook, /Never deploy a workspace-only database policy set while the old user-scoped adapter is still the active production client/);
  assert.match(runbook, /No production database migration has been applied by this runbook/);
});

test('backup validator is read-only and checks all exported collections', () => {
  assert.match(source, /data-backup-preview/);
  assert.match(source, /JSON\.parse\(raw\)/);
  assert.match(source, /schemaVersion/);
  for (const key of ['filaments','printers','products','customers','sales','wastage','transfers','settings']) {
    assert.match(source, new RegExp(key));
  }
  assert.match(source, /This is a read-only preview/);
  assert.match(source, /No records were imported, merged, replaced, or deleted/);
});


test('wastage entry rejects missing filament and amounts exceeding available stock', () => {
  assert.match(source, /if\(!e\)return fail\(f,'Choose a valid filament/);
  assert.match(source, /if\(wastageExceedsStock\(g,e\.left\)\)return fail\(f,'Wastage exceeds available stock/);
});


test('wastage stock guard rejects amounts above stock and any positive wastage when stock is zero/negative', () => {
  assert.equal(context.wastageExceedsStock(1000, 896), true, '1000g must be rejected when only 896g remains');
  assert.equal(context.wastageExceedsStock(896, 896), false, 'exactly available stock may be recorded');
  assert.equal(context.wastageExceedsStock(1, 0), true, 'positive wastage must be rejected at zero stock');
  assert.equal(context.wastageExceedsStock(1, -104), true, 'positive wastage must be rejected at negative stock');
});
