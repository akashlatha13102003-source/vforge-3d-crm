'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const start = source.indexOf('function saveMarketingEntry(');
assert.notEqual(start, -1, 'saveMarketingEntry must exist');
const end = source.indexOf('\nfunction ', start + 10);
assert.notEqual(end, -1, 'saveMarketingEntry must have a closing boundary');
const declaration = source.slice(start, end).trimEnd();

function createHarness(options) {
  const calls = [];
  const messages = [];
  const context = {
    Promise,
    save: (collection, id, data) => {
      calls.push(['save', collection, id]);
      if (collection === 'products') return Promise.resolve(options.productSave !== false);
      if (collection === 'marketing') return Promise.resolve(options.marketingSave !== false);
      throw new Error('Unexpected collection: ' + collection);
    },
    remove: (collection, id) => {
      calls.push(['remove', collection, id]);
      return Promise.resolve(options.rollback !== false);
    },
    toast: (message, isError) => messages.push({ message, isError })
  };
  vm.createContext(context);
  vm.runInContext(declaration, context);
  return { context, calls, messages };
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    process.stderr.write('FAIL ' + name + ': ' + error.message + '\n');
    process.exitCode = 1;
  }
}

(async () => {
  await test('new product and Marketing entry save in order without rollback on success', async () => {
    const h = createHarness({});
    const result = await h.context.saveMarketingEntry({ name: 'New print' }, 'product-1', 'marketing-1', { quantity: 1 });
    assert.equal(result, true);
    assert.deepEqual(h.calls, [
      ['save', 'products', 'product-1'],
      ['save', 'marketing', 'marketing-1']
    ]);
    assert.equal(h.messages.length, 0);
  });

  await test('failed Marketing save compensates by removing the newly created product', async () => {
    const h = createHarness({ marketingSave: false, rollback: true });
    const result = await h.context.saveMarketingEntry({ name: 'New print' }, 'product-2', 'marketing-2', { quantity: 1 });
    assert.equal(result, false);
    assert.deepEqual(h.calls, [
      ['save', 'products', 'product-2'],
      ['save', 'marketing', 'marketing-2'],
      ['remove', 'products', 'product-2']
    ]);
    assert.match(h.messages[0].message, /newly created product was removed/i);
    assert.equal(h.messages[0].isError, true);
  });

  await test('failed compensation clearly warns that the product may remain in stock records', async () => {
    const h = createHarness({ marketingSave: false, rollback: false });
    const result = await h.context.saveMarketingEntry({ name: 'New print' }, 'product-3', 'marketing-3', { quantity: 1 });
    assert.equal(result, false);
    assert.match(h.messages[0].message, /could not be removed.*Check the Products list/i);
  });

  await test('failed product save prevents Marketing save and does not attempt rollback', async () => {
    const h = createHarness({ productSave: false });
    const result = await h.context.saveMarketingEntry({ name: 'New print' }, 'product-4', 'marketing-4', { quantity: 1 });
    assert.equal(result, false);
    assert.deepEqual(h.calls, [['save', 'products', 'product-4']]);
  });

  await test('existing-product Marketing entries do not attempt to create or roll back a product', async () => {
    const h = createHarness({});
    const result = await h.context.saveMarketingEntry(null, 'existing-product', 'marketing-5', { quantity: 1 });
    assert.equal(result, true);
    assert.deepEqual(h.calls, [['save', 'marketing', 'marketing-5']]);
  });
})();
