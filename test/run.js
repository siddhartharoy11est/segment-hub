const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const Suite = require('./suite.js');

const results = Suite.run(E, assert);
let group = '', pass = 0, failed = 0;
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log('\n' + group); }
  console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n        ' + r.error));
  r.ok ? pass++ : failed++;
}
console.log('\n' + pass + ' passed, ' + failed + ' failed, ' + results.length + ' total');
process.exit(failed ? 1 : 0);
