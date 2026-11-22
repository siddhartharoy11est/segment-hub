// Checks on the About page: its numbers, its structure, and its wording rules. Run with: node test/about.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../public/about.js');
const md = fs.readFileSync(path.join(__dirname, '../public/about.md'), 'utf8');
const blocks = A.parse(md);

const tests = [
  ['calculator defaults: worked example', () => {
    const r = A.calc.example({ impsPerHour: 500000, sharePct: 4, hours: 6, ecpm: 90, campaign: 2500000 });
    assert.equal(r.served, 120000); assert.equal(r.value, 10800); assert.equal(Math.round(r.multiple), 231);
  }],
  ['calculator defaults: break-even', () => {
    const r = A.calc.breakEven({ campaign: 2500000, sharePct: 20, hours: 30, rate: 2000, annual: 8400000 });
    assert.equal(r.perIncident, 560000); assert.equal(r.incidents, 15);
  }],
  ['break-even rounds up and handles zero value', () => {
    assert.equal(A.calc.breakEven({ campaign: 1000000, sharePct: 10, hours: 0, rate: 0, annual: 250000 }).incidents, 3);
    assert.equal(A.calc.breakEven({ campaign: 1000000, sharePct: 0, hours: 0, rate: 0, annual: 250000 }).incidents, null);
  }],
  ['Indian digit grouping', () => {
    assert.equal(A.fmtINR(2500000), '₹25,00,000'); assert.equal(A.fmtINR(10800), '₹10,800');
    assert.equal(A.fmtINR(560000), '₹5,60,000'); assert.equal(A.fmtNum(120000), '1,20,000'); assert.equal(A.fmtNum(999), '999');
  }],
  ['page has a greeting, a legend, six numbered sections and Sources', () => {
    assert.equal(blocks.filter(b => b.type === 'greeting').length, 1);
    assert.ok(blocks.filter(b => b.type === 'legend').length >= 1);
    const nums = blocks.filter(b => b.type === 'h2').map(b => /^(\d+)\./.exec(b.text)).filter(Boolean).map(m => Number(m[1]));
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6]);
    assert.ok(blocks.some(b => b.type === 'h2' && b.text === 'Sources'));
  }],
  ['every visual marker is one the renderer knows', () => {
    const names = blocks.filter(b => b.type === 'visual').map(b => b.name);
    assert.ok(names.length >= 4);
    names.forEach(n => assert.ok(A.VISUALS.includes(n), 'unknown visual ' + n));
  }],
  ['paired markers are balanced', () => {
    ['GREETING', 'PAIN-LEGEND'].forEach(k => {
      const open = (md.match(new RegExp('^\\[\\[' + k + '\\]\\]$', 'gm')) || []).length, close = (md.match(new RegExp('^\\[\\[/' + k + '\\]\\]$', 'gm')) || []).length;
      assert.equal(open, close, k);
    });
  }],
  ['the seven endpoints are listed, each tagged with a pain', () => {
    const t = blocks.find(b => b.type === 'table' && b.header[1] === 'Endpoint');
    assert.ok(t, 'endpoint table missing'); assert.equal(t.rows.length, 7);
    t.rows.forEach(r => assert.ok(A.painsIn(r.join('|')).length > 0, 'untagged ' + r[1]));
    assert.deepEqual(A.painsIn(t.rows[4].join('|')), ['A', 'B']);
  }],
  ['the policy table has eight rows', () => {
    const t = blocks.find(b => b.type === 'table' && b.header[0] === 'What the new version changed');
    assert.ok(t); assert.equal(t.rows.length, 8);
  }],
  ['no em dash or en dash anywhere in the page text or renderer', () => {
    ['../public/about.md', '../public/about.js', '../public/index.html'].forEach(f => {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!/[–—]/.test(s), f + ' has a dash character');
    });
  }],
  ['page text is first person singular, with no "we"', () => {
    assert.ok(!/\bwe\b/i.test(md));
  }]

];

let failed = 0;
tests.forEach(([name, fn]) => { try { fn(); console.log('  PASS  ' + name); } catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message); } });
console.log('\nAbout page: ' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
