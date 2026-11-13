'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');
const start = source.indexOf("var nextSettings={currency:ctl(form,'currency').value");
const end = source.indexOf('\n  });', start);
assert.ok(start >= 0 && end > start, 'settings save handler must persist a complete settings object');
const block = source.slice(start, end);
assert.match(block, /var powerRateChanged=num\(s\.powerRate\)!==nextSettings\.powerRate/);
assert.match(block, /state\.settings=Object\.assign\(\{\},state\.settings,nextSettings\)/);
assert.match(block, /if\(powerRateChanged\)queueAutoSheetsSync\('settings:powerRate'\)/);
assert.match(block, /return save\('settings','main',nextSettings\)/);
process.stdout.write('PASS electricity rate changes update local settings and queue a Google Sheets report sync\n');
