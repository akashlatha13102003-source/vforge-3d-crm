'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('index.html', 'utf8');

const configStart = source.indexOf('var CLOUD_LOCAL_KEY=');
const configEnd = source.indexOf('\nfunction setCloudConfig(', configStart);
assert.ok(configStart >= 0 && configEnd > configStart, 'cloud config declaration must exist');
const configSource = source.slice(configStart, configEnd);
const bootStart = source.indexOf('function boot(){');
const bootEnd = source.indexOf('\nboot();', bootStart);
const bootSource = source.slice(bootStart, bootEnd);
const bootCloudStart = bootSource.indexOf('    var cc=getCloudConfig();');
const bootCloudEnd = bootSource.indexOf('\n  }).then(function(){', bootCloudStart);
assert.ok(bootCloudStart >= 0 && bootCloudEnd > bootCloudStart, 'boot cloud selection block must exist');
const bootBlock = bootSource.slice(bootCloudStart, bootCloudEnd);

function contextWith(raw) {
  const context = {
    localStorage: { getItem: () => raw },
    Object, JSON, Error,
    DEFAULT_CLOUD_URL: 'https://example.supabase.co',
    DEFAULT_CLOUD_KEY: 'public-test-key'
  };
  vm.createContext(context);
  vm.runInContext(configSource, context);
  return context;
}

const malformed = contextWith('{broken json');
const config = malformed.getCloudConfig();
assert.ok(malformed.cloudConfigError, 'malformed saved settings must be reported');
assert.equal(config.url, 'https://example.supabase.co');
assert.match(malformed.cloudConfigError, /not switched to browser-local records/i);

const wrongShape = contextWith('[]');
wrongShape.getCloudConfig();
assert.ok(wrongShape.cloudConfigError, 'non-object saved settings must be rejected');

assert.ok(bootBlock.indexOf('if(cloudConfigError)') < bootBlock.indexOf('backend=makeLocalBackend()'),
  'cloud settings corruption must be checked before local mode selection');
assert.match(bootBlock, /backend=makeUnavailableBackend\(cloudConfigError\)/,
  'corrupt cloud settings must use the unavailable backend');
process.stdout.write('PASS corrupt cloud settings cannot silently switch the CRM to local storage\n');
