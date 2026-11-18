'use strict';

// Financial integrity regression tests against the actual CRM functions.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' must exist');
  const end = source.indexOf('\nfunction ', start + 10);
  assert.notEqual(end, -1, 'function ' + name + ' must have a following declaration');
  return source.slice(start, end).trimEnd();
}

const context = {
  state: { sales: [], customers: [], products: [], supplies: [], printers: [], filaments: [], marketing: [], wastage: [], settings: { powerRate: 0 } },
  num: value => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; },
  getStats: null,
  supplyTotals: null,
  fkey: item => item.key || [item.brand, item.material, item.colour].map(value => String(value || '').trim().toLowerCase()).join('|'),
  safeHex: value => value || '#000000',
  fname: entry => [entry.brand, entry.material, entry.colour].filter(Boolean).join(' '),
  statsCache: null,
  statsVer: -1,
  ver: 0,
  powerOf: (printerId, hours) => ({ printer: (context.state.printers || []).find(p => p.id === printerId) || null, kwh: 0, cost: 0 }),
  saleLines: null,
  saleRev: sale => (Array.isArray(sale.lineItems) ? sale.lineItems : []).reduce((sum, line) =>
    sum + Number(line.finalUnit != null ? line.finalUnit : line.unitPrice || 0) * Number(line.qty || 0), 0),
};
vm.createContext(context);
vm.runInContext([extract('saleLines'), extract('getStats'), extract('supplyTotals'), extract('saleTax'), extract('saleTaxable'), extract('productCost'), extract('saleLineCostInfo'), extract('saleCostInfo'), extract('saleCost'), extract('saleProfit'), extract('custStats')].join('\n'), context);
const originalGetStats = context.getStats;
context.getStats = function () {
  const current = context.state;
  current.filaments = current.filaments || [];
  current.products = current.products || [];
  current.sales = current.sales || [];
  current.marketing = current.marketing || [];
  current.wastage = current.wastage || [];
  context.statsCache = null;
  context.statsVer = -1;
  context.ver++;
  return originalGetStats();
};

function approx(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.001, label + ': expected ' + expected + ', got ' + actual);
}
function test(name, fn) {
  try { fn(); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { process.stderr.write('FAIL ' + name + ': ' + error.message + '\n'); process.exitCode = 1; }
}

test('customer spend excludes pending invoices but retains order count', () => {
  context.state = {
    customers: [{ id: 'c1', name: 'Customer One' }],
    sales: [
      { id: 's1', customerId: 'c1', status: 'paid', date: '2026-11-01', lineItems: [{ qty: 2, finalUnit: 100 }] },
      { id: 's2', customerId: 'c1', status: 'pending', date: '2026-11-02', lineItems: [{ qty: 1, finalUnit: 500 }] },
      { id: 's3', customerId: 'c1', date: '2026-11-03', lineItems: [{ qty: 1, finalUnit: 50 }] }
    ]
  };
  const stats = context.custStats().get('c1');
  assert.equal(stats.orders, 3, 'all invoices remain visible as orders');
  approx(stats.spent, 250, 'only paid and legacy non-pending invoices count as spent');
  assert.equal(stats.last, '2026-11-03');
});

test('legacy inclusive GST is calculated when gstUnit is absent', () => {
  const tax = context.saleTax({ lineItems: [{ qty: 2, unitPrice: 118, priceMode: 'inclusive', gstRate: 18 }] });
  approx(tax, 36, 'inclusive GST');
});

test('legacy exclusive GST is calculated when gstUnit is absent', () => {
  const tax = context.saleTax({ lineItems: [{ qty: 3, unitPrice: 100, priceMode: 'exclusive', gstRate: 5 }] });
  approx(tax, 15, 'exclusive GST');
});

test('stored GST values take precedence, including an explicit zero', () => {
  const tax = context.saleTax({ lineItems: [
    { qty: 2, unitPrice: 118, priceMode: 'inclusive', gstRate: 18, gstUnit: 0 },
    { qty: 1, unitPrice: 100, gstRate: 18, gstUnit: 18 }
  ] });
  approx(tax, 18, 'stored GST');
});

test('legacy single-product invoices also receive GST fallback', () => {
  const tax = context.saleTax({ qty: 2, unitPrice: 118, priceMode: 'inclusive', gstRate: 18 });
  approx(tax, 36, 'legacy single-line GST');
});


test('unknown product cost is not reported as zero cost or positive profit', () => {
  context.state = { customers: [], sales: [], products: [{ id: 'p1', costInfo: { total: 0, hasCost: false } }] };
  const sale = { productId: 'p1', lineItems: [{ productId: 'p1', qty: 2, unitPrice: 118, taxableUnit: 100, unitCost: 0, priceMode: 'inclusive', gstRate: 18 }] };
  assert.equal(context.saleCostInfo(sale).known, false);
  assert.equal(context.saleCost(sale), null);
  assert.equal(context.saleProfit(sale), null);
});

test('explicitly recorded zero cost remains a valid zero-cost snapshot', () => {
  context.state = { customers: [], sales: [], products: [] };
  const sale = { lineItems: [{ qty: 2, unitPrice: 118, taxableUnit: 100, unitCost: 0, unitCostKnown: true, priceMode: 'inclusive', gstRate: 18 }] };
  assert.deepEqual(JSON.parse(JSON.stringify(context.saleCostInfo(sale))), { known: true, total: 0 });
  approx(context.saleProfit(sale), 200, 'profit with explicit zero cost');
});

test('legacy positive unit-cost snapshots remain authoritative', () => {
  context.state = { customers: [], sales: [], products: [{ id: 'p1', costInfo: { total: 90, hasCost: true } }] };
  const sale = { productId: 'p1', lineItems: [{ productId: 'p1', qty: 2, unitPrice: 100, taxableUnit: 100, unitCost: 25 }] };
  assert.equal(context.saleCost(sale), 50);
  approx(context.saleProfit(sale), 150, 'legacy saved cost');
});

test('legacy zero-cost lines use current product cost only when it is actually known', () => {
  context.state = { customers: [], sales: [], products: [{ id: 'p1', otherCost: 30 }], supplies: [], printers: [], settings: { powerRate: 0 } };
  const sale = { productId: 'p1', lineItems: [{ productId: 'p1', qty: 2, unitPrice: 100, taxableUnit: 100, unitCost: 0 }] };
  assert.equal(context.saleCost(sale), 60);
  approx(context.saleProfit(sale), 140, 'legacy fallback to known product cost');
});

test('one unknown line makes a multi-product invoice profit unavailable', () => {
  context.state = { customers: [], sales: [], products: [{ id: 'p2', costInfo: { total: 0, hasCost: false } }] };
  const sale = { lineItems: [
    { productId: 'p1', qty: 1, unitPrice: 100, taxableUnit: 100, unitCost: 20 },
    { productId: 'p2', qty: 1, unitPrice: 100, taxableUnit: 100, unitCost: 0, unitCostKnown: false }
  ] };
  assert.equal(context.saleCostInfo(sale).known, false);
  assert.equal(context.saleProfit(sale), null);
});


test('filament recipe without a matching purchase is not a known zero cost', () => {
  context.state = { customers: [], sales: [], products: [], supplies: [], printers: [], settings: { powerRate: 0 } };
  const cost = context.productCost({ lines: [{ key: 'pla-red', grams: 100 }], consumables: [], printerId: '', printHours: 0, otherCost: null }, new Map());
  assert.equal(cost.hasCost, false);
  assert.equal(cost.filKnown, false);
});

test('filament recipe with a recorded purchase has a known cost', () => {
  context.state = { customers: [], sales: [], products: [], supplies: [], printers: [], settings: { powerRate: 0 } };
  const stats = new Map([['pla-red', { bought: 1000, cpg: 0.05, costKnown: true }]]);
  const cost = context.productCost({ lines: [{ key: 'pla-red', grams: 100 }], consumables: [], printerId: '', printHours: 0, otherCost: null }, stats);
  assert.equal(cost.hasCost, true);
  approx(cost.fil, 5, 'filament cost');
});

test('filament purchase with a missing historical price does not create a known zero cost', () => {
  context.state = {
    filaments: [{ id: 'f1', key: 'pla-red', brand: 'Anycubic', material: 'PLA', colour: 'Red', weight: 1000, spools: 1 }],
    products: [{ id: 'p1', lines: [{ key: 'pla-red', grams: 100 }], consumables: [], printerId: '', printHours: 0, otherCost: null }],
    sales: [], marketing: [], wastage: [], supplies: [], printers: [], settings: { powerRate: 0 }
  };
  context.statsCache = null;
  context.statsVer = -1;
  context.ver++;
  const stats = context.getStats();
  assert.equal(stats.get('pla-red').costKnown, false);
  const cost = context.productCost(context.state.products[0], stats);
  assert.equal(cost.hasCost, false);
  const sale = { productId: 'p1', lineItems: [{ productId: 'p1', qty: 1, unitPrice: 100, taxableUnit: 100, unitCost: 0 }] };
  assert.equal(context.saleCostInfo(sale).known, false);
  assert.equal(context.saleProfit(sale), null);

  context.state.filaments[0].total = 0;
  context.statsCache = null;
  context.statsVer = -1;
  context.ver++;
  const zeroStats = context.getStats();
  assert.equal(zeroStats.get('pla-red').costKnown, true);
  const zeroCost = context.productCost(context.state.products[0], zeroStats);
  assert.equal(zeroCost.hasCost, true);
  approx(zeroCost.fil, 0, 'explicit zero filament purchase cost');
});

test('consumable purchase with a missing historical price does not create a known zero cost', () => {
  const item = { id: 'glue', purchases: [{ quantity: 10 }] };
  context.state = {
    products: [{ id: 'p1', lines: [], consumables: [{ supplyId: 'glue', quantity: 1 }], printerId: '', printHours: 0, otherCost: null }],
    supplies: [item], printers: [], sales: [], filaments: [], marketing: [], wastage: [], settings: { powerRate: 0 }
  };
  const totals = context.supplyTotals(item);
  assert.equal(totals.bought, 10);
  assert.equal(totals.costKnown, false);
  const cost = context.productCost(context.state.products[0], new Map());
  assert.equal(cost.hasCost, false);
  assert.equal(cost.consumablesKnown, false);

  item.purchases[0].total = 0;
  const zeroTotals = context.supplyTotals(item);
  assert.equal(zeroTotals.costKnown, true);
  const zeroCost = context.productCost(context.state.products[0], new Map());
  assert.equal(zeroCost.hasCost, true);
  approx(zeroCost.consumables, 0, 'explicit zero consumable purchase cost');
});

test('consumable use without purchase history is not a known zero cost', () => {
  context.state = { customers: [], sales: [], products: [], supplies: [{ id: 'glue', totals: { bought: 0, unitCost: 0 } }], printers: [], settings: { powerRate: 0 } };
  const cost = context.productCost({ lines: [], consumables: [{ supplyId: 'glue', quantity: 1 }], printerId: '', printHours: 0, otherCost: null }, new Map());
  assert.equal(cost.hasCost, false);
  assert.equal(cost.consumablesKnown, false);
});

test('a selected printer without print time is not a known zero electricity cost', () => {
  context.state = { customers: [], sales: [], products: [], supplies: [], printers: [{ id: 'p1', watts: 100 }], settings: { powerRate: 0 } };
  const cost = context.productCost({ lines: [], consumables: [], printerId: 'p1', printHours: 0, otherCost: null }, new Map());
  assert.equal(cost.hasCost, false);
  assert.equal(cost.elecKnown, false);
});

test('an explicitly entered zero other-cost remains a known zero-cost component', () => {
  context.state = { customers: [], sales: [], products: [], supplies: [], printers: [], settings: { powerRate: 0 } };
  const cost = context.productCost({ lines: [], consumables: [], printerId: '', printHours: 0, otherCost: 0 }, new Map());
  assert.equal(cost.hasCost, true);
  assert.equal(cost.total, 0);
});
