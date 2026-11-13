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
  state: { sales: [], customers: [] },
  num: value => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; },
  saleLines: null,
  saleRev: sale => (Array.isArray(sale.lineItems) ? sale.lineItems : []).reduce((sum, line) =>
    sum + Number(line.finalUnit != null ? line.finalUnit : line.unitPrice || 0) * Number(line.qty || 0), 0),
};
vm.createContext(context);
vm.runInContext([extract('saleLines'), extract('saleTax'), extract('custStats')].join('\n'), context);

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
