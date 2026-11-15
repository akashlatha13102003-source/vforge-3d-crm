'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const start = source.indexOf('function filamentPurchaseStockError(');
assert.notEqual(start, -1, 'filamentPurchaseStockError must exist');
const end = source.indexOf('\nfunction openPurchase(', start + 10);
assert.notEqual(end, -1, 'filament purchase helpers must end before openPurchase');

const context = {
  num: value => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  },
  fkey: purchase => purchase.key || 'legacy-filament-key',
  fmtG: value => String(Math.round(Number(value))),
  saleLines: sale => Array.isArray(sale.lineItems) ? sale.lineItems : [{ usage: sale.usage || [] }]
};
vm.createContext(context);
vm.runInContext(source.slice(start, end).trimEnd(), context);

function test(name, fn) {
  try {
    fn();
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    process.stderr.write('FAIL ' + name + ': ' + error.message + '\n');
    process.exitCode = 1;
  }
}

const purchase = { key: 'pla|red', weight: 1000, spools: 1 };
const stock = new Map([['pla|red', { bought: 2000, actualUsed: 1500, name: 'PLA Red' }]]);

test('blocks a purchase edit that would leave less filament than recorded usage', () => {
  const error = context.filamentPurchaseStockError(purchase, 400, 1, stock);
  assert.match(error, /1400 g.*1500 g already used/i);
  assert.match(error, /keep at least 500 g/i);
});

test('allows a purchase edit that leaves exactly the consumed quantity available', () => {
  assert.equal(context.filamentPurchaseStockError(purchase, 500, 1, stock), '');
});

test('includes other purchases of the same filament when validating an edit', () => {
  const multiplePurchases = new Map([['pla|red', { bought: 2500, actualUsed: 1500, name: 'PLA Red' }]]);
  assert.equal(context.filamentPurchaseStockError(purchase, 0, 1, multiplePurchases), '');
});

test('treats moving a purchase to a different filament identity as removing its old stock', () => {
  const error = context.filamentPurchaseStockError(purchase, 0, 1, stock);
  assert.match(error, /already used/i);
});

test('supports legacy purchases whose filament key must be derived', () => {
  const legacyPurchase = { brand: 'Brand', material: 'PLA', colour: 'Red', weight: 1000, spools: 1 };
  const legacyStock = new Map([['legacy-filament-key', { bought: 1000, actualUsed: 800, name: 'Legacy PLA Red' }]]);
  const error = context.filamentPurchaseStockError(legacyPurchase, 500, 1, legacyStock);
  assert.match(error, /already used/i);
});


test('counts product, sales, Marketing and wastage references before identity changes', () => {
  const refs = context.filamentPurchaseReferenceCounts('pla|red', {
    products: [{ lines: [{ key: 'pla|red' }] }],
    sales: [{ usage: [{ key: 'pla|red' }] }],
    marketing: [{ lines: [{ key: 'pla|red' }] }],
    wastage: [{ filamentKey: 'pla|red' }]
  });
  assert.equal(refs.products, 1);
  assert.equal(refs.sales, 1);
  assert.equal(refs.marketing, 1);
  assert.equal(refs.wastage, 1);
});

test('blocks deleting the only purchase while product history still references the filament', () => {
  const onlyPurchase = new Map([['pla|red', { bought: 1000, actualUsed: 0, name: 'PLA Red' }]]);
  const refs = { products: [{ lines: [{ key: 'pla|red' }] }], sales: [], marketing: [], wastage: [] };
  const error = context.filamentPurchaseDeleteError(purchase, onlyPurchase, refs);
  assert.match(error, /1 product recipe.*no other purchase remains/i);
});

test('allows deleting one purchase when remaining purchases preserve used stock and references', () => {
  const multiplePurchases = new Map([['pla|red', { bought: 2500, actualUsed: 1500, name: 'PLA Red' }]]);
  const refs = { products: [{ lines: [{ key: 'pla|red' }] }], sales: [], marketing: [], wastage: [] };
  assert.equal(context.filamentPurchaseDeleteError(purchase, multiplePurchases, refs), '');
});

test('blocks deleting a purchase if the remaining stock would fall below recorded usage', () => {
  const error = context.filamentPurchaseDeleteError(purchase, stock, {});
  assert.match(error, /Deleting this purchase would leave 1000 g.*1500 g already used/i);
});

test('matches legacy purchases with missing spool counts to the stock calculation', () => {
  const legacyPurchase = { key: 'pla|red', weight: 1000 };
  const legacyStock = new Map([['pla|red', { bought: 1000, actualUsed: 800, name: 'PLA Red' }]]);
  assert.equal(context.filamentPurchaseStockError(legacyPurchase, 500, 1, legacyStock), '');
  assert.equal(context.filamentPurchaseDeleteError(legacyPurchase, legacyStock, {}), '');
});

test('does not invent a stock error when the filament has no usage entry', () => {
  assert.equal(context.filamentPurchaseStockError(purchase, 0, 1, new Map()), '');
});
