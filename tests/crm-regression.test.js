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
  'productGst', 'saleLines', 'saleRev', 'saleTax', 'saleTaxable',
  'saleCost', 'saleProfit', 'getStats'
].map(extractFunction).join('\n');

const context = {
  num: v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; },
  safeHex: h => /^#[0-9a-f]{6}$/i.test(h || '') ? h : '#8a8f94',
  fkey: o => [o.brand, o.material, o.colour].map(v => String(v || '').trim().toLowerCase()).join('|'),
  fname: o => [o.brand, o.material, o.colour].filter(Boolean).join(' '),
  ver: 1,
  statsVer: -1,
  statsCache: null,
  state: { filaments: [], products: [], sales: [], wastage: [], settings: {} },
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
  const exportHandler = source.slice(source.indexOf("data-export=\"json\"") - 100, source.indexOf("data-export=\"json\"") + 1200);
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
