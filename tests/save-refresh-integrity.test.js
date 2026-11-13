'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf('function applyMutationToState(');
const end = source.indexOf('\nfunction migrateLocalToCloud()', start);
assert.ok(start >= 0 && end > start, 'mutation consistency helpers must exist');
const block = source.slice(start, end);
assert.ok(block.includes('function refreshAfterMutation('), 'post-write refresh handling must be shared');
assert.ok(block.includes('.catch(function(error){'), 'refresh failures must be handled');
assert.ok(block.includes('applyMutationToState(col,id,data,removed)'), 'successful writes must update visible state if refresh fails');
assert.ok(block.includes("queueAutoSheetsSync(action+':'+col)"), 'successful writes must still queue Sheets sync');
assert.ok(block.includes('return refreshAfterMutation(col,id,data,false,\'saved\')'), 'save must use the safe post-write path');
assert.ok(block.includes('return refreshAfterMutation(col,id,null,true,\'removed\')'), 'delete must use the safe post-write path');
assert.ok(block.includes('return false;'), 'backend write failures must still report failure');
process.stdout.write('PASS successful writes remain successful when only the follow-up refresh fails\n');
