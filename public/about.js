/* about.js
 * Renders public/about.md as the "About this project" page.
 * The words live in about.md. Edit that file to change the text. This file only knows how to draw it.
 * No dependencies. Everything is built with DOM nodes and textContent, so text in about.md can never run as code.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SegmentAbout = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Default pain names. If about.md has a legend block with "**Pain A: ...**" the names there win.
  var PAINS = { A: 'a wrong rule goes live', B: 'ad servers run an out-of-date rule' };
  var VISUALS = ['problem-flow', 'metric-tree', 'break-even', 'example-calc'];
  // Rows of the policy table (4.2) that can be tried elsewhere in the prototype.
  var EXPLORER_TRY = { 0: ['story', 'Run Request 4 on the Story tab'], 1: ['story', 'Run Request 5 on the Story tab, then open the Sync board'] };

  // ------------------------------------------------------------ numbers
  function groupIN(n) {
    var s = String(Math.round(Math.abs(n)));
    if (s.length <= 3) return s;
    return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  }
  function fmtINR(n) { return '₹' + groupIN(n); }
  function fmtNum(n) { return groupIN(n); }
  function fmtPct(n) { return (Math.round(n * 10) / 10) + '%'; }

  function calcExample(i) {
    var served = i.impsPerHour * (i.sharePct / 100) * i.hours;
    var value = served / 1000 * i.ecpm;
    return { served: Math.round(served), value: Math.round(value), multiple: value > 0 ? i.campaign / value : null };
  }
  function calcBreakEven(i) {
    var per = i.campaign * (i.sharePct / 100) + i.hours * i.rate;
    return { perIncident: Math.round(per), incidents: per > 0 ? Math.ceil(i.annual / per - 1e-9) : null };
  }

  // ------------------------------------------------------------ markdown: blocks
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }
  function startsBlock(t) {
    return /^(#{1,3}\s|\||>|- |---+$|\[\[)/.test(t);
  }

  function parse(md) {
    var lines = String(md).replace(/\r\n?/g, '\n').split('\n'), out = [], i = 0, m;
    while (i < lines.length) {
      var t = lines[i].trim();
      if (!t) { i++; continue; }
      if (t === '[[GREETING]]' || t === '[[PAIN-LEGEND]]') {
        var end = '[[/' + t.slice(2), buf = [];
        i++;
        while (i < lines.length && lines[i].trim() !== end) { buf.push(lines[i].trim()); i++; }
        i++;
        out.push({ type: t === '[[GREETING]]' ? 'greeting' : 'legend', text: buf.join(' ').trim() });
        continue;
      }
      if ((m = /^\[\[VISUAL:\s*([a-z-]+)\s*\]\]$/.exec(t))) { out.push({ type: 'visual', name: m[1] }); i++; continue; }
      if (/^---+$/.test(t)) { out.push({ type: 'hr' }); i++; continue; }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) { out.push({ type: 'h' + m[1].length, text: m[2].trim() }); i++; continue; }
      if (t.charAt(0) === '|') {
        var rows = [];
        while (i < lines.length && lines[i].trim().charAt(0) === '|') { rows.push(splitRow(lines[i])); i++; }
        var header = rows[0], body = rows.slice(/^:?-+/.test(rows[1] && rows[1][0] || '') ? 2 : 1);
        out.push({ type: 'table', header: header, headerEmpty: header.every(function (c) { return c === ''; }), rows: body });
        continue;
      }
      if (t.charAt(0) === '>') {
        var q = [];
        while (i < lines.length && lines[i].trim().charAt(0) === '>') { q.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
        out.push({ type: 'quote', text: q.join(' ') });
        continue;
      }
      if (/^- /.test(t)) {
        var items = [];
        while (i < lines.length && /^- /.test(lines[i].trim())) { items.push(lines[i].trim().slice(2)); i++; }
        out.push({ type: 'list', items: items });
        continue;
      }
      var p = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i].trim())) { p.push(lines[i].trim()); i++; }
      if (!p.length) { p.push(t); i++; }
      out.push({ type: 'p', text: p.join(' ') });
    }
    return out;
  }

  function painsIn(text) {
    var found = [], re = /\[\[PAIN:([AB,\s]+)\]\]/g, m;
    while ((m = re.exec(text))) m[1].split(/[,\s]+/).forEach(function (c) { if (c && found.indexOf(c) < 0) found.push(c); });
    return found;
  }

  // ------------------------------------------------------------ DOM helpers
  function el(tag, attrs) {
    var e = document.createElement(tag), kids = Array.prototype.slice.call(arguments, 2), val;
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'value') val = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    if (val !== undefined) e.value = val;
    (function add(list) { list.forEach(function (c) { if (Array.isArray(c)) return add(c); if (c == null || c === false) return; e.append(c.nodeType ? c : document.createTextNode(String(c))); }); })(kids);
    return e;
  }

  var INLINE_SRC = '\\*\\*(.+?)\\*\\*|`([^`]+)`|\\[\\[PAIN:([AB,\\s]+)\\]\\]|(https?:\\/\\/[^\\s)]+)|\\*([^*\\s][^*]*?)\\*';
  function inline(text, ctx) {
    var nodes = [], last = 0, m, re = new RegExp(INLINE_SRC, 'g');
    while ((m = re.exec(text))) {
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) nodes.push(el('strong', {}, inline(m[1], ctx)));
      else if (m[2] !== undefined) nodes.push(el('code', {}, m[2]));
      else if (m[3] !== undefined) nodes.push(painChips(painsIn(m[0]), ctx));
      else if (m[4] !== undefined) nodes.push(el('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer' }, m[4]));
      else nodes.push(el('em', {}, inline(m[5], ctx)));
      last = re.lastIndex;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
  }

  // ------------------------------------------------------------ pain chips
  function painName(code, ctx) { return (ctx.pains[code] || PAINS[code] || '').replace(/\.$/, ''); }
  function painChips(codes, ctx) {
    var wrap = el('span', { class: 'pgroup' });
    codes.forEach(function (c) { wrap.append(painChip(c, ctx, false)); });
    return wrap;
  }
  function painChip(code, ctx, long) {
    var name = painName(code, ctx);
    var b = el('button', { type: 'button', class: 'pchip p' + code + (long ? ' plong' : ''), 'data-pain-code': code, 'aria-pressed': 'false',
      'aria-label': 'Pain ' + code + ': ' + name + '. Press to highlight the endpoints for this pain.' }, long ? 'Pain ' + code + ': ' + name : code);
    b.addEventListener('mouseenter', function () { showTip(b, ctx); });
    b.addEventListener('focus', function () { showTip(b, ctx); });
    b.addEventListener('mouseleave', function () { hideTip(ctx); });
    b.addEventListener('blur', function () { hideTip(ctx); });
    b.addEventListener('click', function () { setHighlight(ctx, ctx.hl === code ? null : code); showTip(b, ctx); });
    return b;
  }
  function showTip(btn, ctx) {
    var code = btn.getAttribute('data-pain-code'), tip = ctx.tip, on = ctx.hl === code;
    tip.textContent = 'Pain ' + code + ': ' + painName(code, ctx) + '. ' + (on ? 'Press again to clear.' : 'Press to highlight the endpoints.');
    tip.hidden = false;
    var r = btn.getBoundingClientRect(), w = Math.min(260, window.innerWidth - 16);
    tip.style.maxWidth = w + 'px';
    tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    tip.style.top = (r.bottom + 6) + 'px';
  }
  function hideTip(ctx) { ctx.tip.hidden = true; }
  function setHighlight(ctx, code) {
    ctx.hl = code; ctx.persist.hl = code;
    ctx.root.setAttribute('data-hl', code || '');
    Array.prototype.forEach.call(ctx.root.querySelectorAll('.pchip'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-pain-code') === code ? 'true' : 'false'); });
  }

  // ------------------------------------------------------------ tables
  function chipFor(text, header) {
    if (header === 'Status') { if (text === 'Built') return 'good'; if (text === 'Design only') return 'grey'; }
    if (header === 'Risk') { return ({ Low: 'good', High: 'bad', Critical: 'bad', None: 'grey', Escalating: 'warn' })[text] || null; }
    return null;
  }
  function buildTable(b, ctx) {
    var table = el('table');
    if (!b.headerEmpty) table.append(el('thead', {}, el('tr', {}, b.header.map(function (c) { return el('th', {}, inline(c, ctx)); }))));
    var tbody = el('tbody'), trs = [];
    b.rows.forEach(function (r) {
      var tr = el('tr'), pains = painsIn(r.join(' | '));
      if (pains.length) tr.setAttribute('data-pain', pains.join(' '));
      r.forEach(function (c, ci) {
        var tone = b.headerEmpty ? null : chipFor(c, b.header[ci]);
        tr.append(el('td', {}, tone ? el('span', { class: 'chip ' + tone }, c) : inline(c, ctx)));
      });
      tbody.append(tr); trs.push(tr);
    });
    table.append(tbody);
    var scroll = el('div', { class: 'scroll' }, table);
    if (b.header[0] === 'What the new version changed') return explorer(scroll, trs, b, ctx);
    return scroll;
  }

  // The 4.2 policy table: select a row to see it spelled out, and where to try it.
  function explorer(scroll, trs, b, ctx) {
    var panel = el('div', { class: 'xpanel', 'aria-live': 'polite' }, 'Select a row to see what the hub does.');
    var box = el('div', { class: 'explorer' }, el('p', { class: 'xhint' }, 'Select any row to see it in plain words.'), scroll, panel);
    function pick(idx) {
      trs.forEach(function (tr, i) { tr.classList.toggle('sel', i === idx); tr.setAttribute('aria-pressed', i === idx ? 'true' : 'false'); });
      var r = b.rows[idx], lines = [['What changed', r[0]], ['An old copy is', r[1]], ['Risk', r[2]], ['Hub action', r[3]], ['Status', r[4]]];
      panel.innerHTML = '';
      lines.forEach(function (l) { panel.append(el('div', { class: 'xline' }, el('span', { class: 'xk' }, l[0]), el('span', {}, l[1]))); });
      if (EXPLORER_TRY[idx]) panel.append(el('div', { class: 'xline' }, el('button', { type: 'button', class: 'sm', onclick: function () { ctx.go(EXPLORER_TRY[idx][0]); } }, EXPLORER_TRY[idx][1] + ' >')));
    }
    trs.forEach(function (tr, i) {
      tr.classList.add('pick'); tr.setAttribute('tabindex', '0'); tr.setAttribute('role', 'button'); tr.setAttribute('aria-pressed', 'false');
      tr.addEventListener('click', function () { pick(i); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(i); } });
    });
    return box;
  }

  // ------------------------------------------------------------ visuals
  function problemFlow() {
    var steps = ['The client asks for a rule', 'The rule or a list is updated', 'One ad server misses the update', 'That server keeps serving on the old rule', 'The client notices first'];
    var ol = el('ol', { class: 'flow' });
    steps.forEach(function (s, i) {
      ol.append(el('li', { class: i === 2 ? 'catch' : i === 4 ? 'late' : '' },
        i === 2 ? el('span', { class: 'flag good' }, 'Acks and the sync board catch it here') : null,
        i === 4 ? el('span', { class: 'flag bad' }, 'Today, the first signal') : null,
        el('span', { class: 'fn' }, String(i + 1)), el('span', {}, s)));
    });
    return el('figure', { class: 'visual' }, ol,
      el('figcaption', {}, 'Without the hub, the first signal is step 5. With it, the first signal is step 3, before the client sees anything.'));
  }
  function metricTree() {
    function box(t, cls) { return el('div', { class: 'mt-box ' + (cls || '') }, t); }
    return el('figure', { class: 'visual' }, el('div', { class: 'mt' },
      el('div', { class: 'mt-main' },
        box('Stale-version impression share', 'top'),
        el('div', { class: 'mt-cols' },
          el('div', { class: 'mt-col' }, box('Stale traffic footprint', 'mid'), box('Acknowledgement coverage'), box('Share of traffic on servers that are behind')),
          el('div', { class: 'mt-col' }, box('Time behind', 'mid'), box('Publish to active, 95th percentile'), box('Time to detect'), box('Local expiry'))),
        box('Outcome: revenue at risk, and AdOps hours per incident', 'out')),
      el('div', { class: 'mt-guard' }, el('b', {}, 'Guardrails, all held at 0'),
        el('ul', {}, ['Consent violations', 'Unsigned snapshots accepted', 'Narrower copies paused', 'Loosening rollbacks', 'New content without a second person'].map(function (g) { return el('li', {}, g); })))),
      el('figcaption', {}, 'The headline moves with how much traffic is behind and for how long. The guardrails can never be traded for it.'));
  }

  function buildCalc(spec) {
    var vals = {}, inputs = {}, outs = {};
    var grid = el('div', { class: 'calc-grid' });
    spec.fields.forEach(function (f) {
      vals[f.key] = f.value;
      var id = 'calc-' + spec.id + '-' + f.key, o = el('output', { for: id }, f.fmt(f.value));
      var inp = el('input', { type: 'range', id: id, min: f.min, max: f.max, step: f.step });
      inp.value = f.value;
      inp.addEventListener('input', function () { vals[f.key] = Number(inp.value); o.textContent = f.fmt(vals[f.key]); update(); });
      inputs[f.key] = { inp: inp, out: o, f: f };
      grid.append(el('label', { class: 'cf', for: id }, el('span', { class: 'cl' }, f.label), inp, o));
    });
    var tiles = el('div', { class: 'calc-out' });
    spec.outputs.forEach(function (o, i) {
      var b = el('b', {}); outs[i] = b;
      tiles.append(el('div', { class: 'tile' + (o.big ? ' big' : '') }, b, el('span', {}, o.label)));
    });
    function update() { var r = spec.compute(vals); spec.outputs.forEach(function (o, i) { outs[i].textContent = o.get(r); }); }
    var reset = el('button', { type: 'button', class: 'sm', onclick: function () {
      spec.fields.forEach(function (f) { vals[f.key] = f.value; inputs[f.key].inp.value = f.value; inputs[f.key].out.textContent = f.fmt(f.value); }); update();
    } }, 'Reset to defaults');
    update();
    return el('div', { class: 'calc' }, el('div', { class: 'calc-title' }, spec.title), grid, tiles, spec.note ? el('p', { class: 'small muted' }, spec.note) : null, reset);
  }
  function exampleCalc() {
    return buildCalc({ id: 'ex', title: 'Try your own numbers', note: 'Illustrative inputs. Replace them with real traffic and price figures.',
      fields: [
        { key: 'impsPerHour', label: 'Impressions per hour on the stale cluster', min: 50000, max: 5000000, step: 50000, value: 500000, fmt: fmtNum },
        { key: 'sharePct', label: 'Share on the newly excluded site', min: 0.5, max: 20, step: 0.5, value: 4, fmt: fmtPct },
        { key: 'hours', label: 'Hours until someone notices', min: 1, max: 48, step: 1, value: 6, fmt: function (n) { return n + ' h'; } },
        { key: 'ecpm', label: 'Average price (eCPM)', min: 10, max: 500, step: 5, value: 90, fmt: fmtINR },
        { key: 'campaign', label: 'Campaign value the client could pause', min: 500000, max: 50000000, step: 100000, value: 2500000, fmt: fmtINR }],
      compute: calcExample,
      outputs: [
        { label: 'Impressions served on the excluded site', get: function (r) { return fmtNum(r.served); } },
        { label: 'Direct value served against the exclusion', get: function (r) { return fmtINR(r.value); } },
        { label: 'Campaign value as a multiple of the direct value', get: function (r) { return r.multiple == null ? 'n/a' : 'about ' + fmtNum(r.multiple) + ' times'; } }] });
  }
  function breakEvenCalc() {
    return buildCalc({ id: 'be', title: 'How many incidents must the hub prevent each year?', note: 'Defaults are illustrative. Use Media.net figures when you have them.',
      fields: [
        { key: 'campaign', label: 'Campaign value', min: 500000, max: 50000000, step: 100000, value: 2500000, fmt: fmtINR },
        { key: 'sharePct', label: 'Share withdrawn or credited', min: 0, max: 100, step: 1, value: 20, fmt: function (n) { return n + '%'; } },
        { key: 'hours', label: 'Hours spent on one incident', min: 0, max: 200, step: 1, value: 30, fmt: function (n) { return n + ' h'; } },
        { key: 'rate', label: 'Cost per hour', min: 500, max: 10000, step: 100, value: 2000, fmt: fmtINR },
        { key: 'annual', label: 'Annual cost to build and run the hub', min: 1000000, max: 50000000, step: 100000, value: 8400000, fmt: fmtINR }],
      compute: calcBreakEven,
      outputs: [
        { label: 'Value per incident avoided', get: function (r) { return fmtINR(r.perIncident); } },
        { label: 'Incidents a year to break even', big: true, get: function (r) { return r.incidents == null ? 'n/a' : String(r.incidents); } }] });
  }
  function visual(name) {
    if (name === 'problem-flow') return problemFlow();
    if (name === 'metric-tree') return metricTree();
    if (name === 'break-even') return breakEvenCalc();
    if (name === 'example-calc') return exampleCalc();
    return el('p', { class: 'muted' }, '[unknown visual: ' + name + ']');
  }

  // ------------------------------------------------------------ greeting
  function greeting(b, ctx) {
    return el('section', { class: 'greet' },
      el('img', { class: 'avatar', src: ctx.avatar, alt: 'Illustration of Sid', width: 96, height: 96 }),
      el('div', { class: 'bubble' }, el('div', { class: 'gtext' }, inline(b.text, ctx)),
        el('div', { class: 'gact' },
          el('button', { type: 'button', class: 'pri', onclick: function () { ctx.go('story'); } }, 'Replay the incident'),
          el('button', { type: 'button', onclick: function () { setAll(ctx, true); } }, 'Expand all sections'))));
  }
  function setAll(ctx, open) {
    ctx.sections.forEach(function (s) { s.open = open; });
    ctx.persist.open = open ? ctx.sections.map(function (s) { return s.id; }) : [];
  }

  // ------------------------------------------------------------ page
  function mount(host, opts) {
    injectCss();
    var blocks = parse(opts.md), persist = opts.persist || {};
    var ctx = { go: opts.go || function () {}, avatar: opts.avatar || '', pains: {}, hl: null, persist: persist, sections: [], tip: null, root: null };
    blocks.forEach(function (b) {
      if (b.type !== 'legend') return;
      var re = /\*\*Pain ([AB]):\s*(.+?)\.?\*\*/g, m;
      while ((m = re.exec(b.text))) ctx.pains[m[1]] = m[2].trim();
    });
    var root = el('div', { class: 'about' }), body = el('div', { class: 'abody' }), rail = el('nav', { class: 'rail', 'aria-label': 'On this page' });
    ctx.root = root;
    ctx.tip = el('div', { class: 'ptip', role: 'tooltip', hidden: true });
    var cur = body, toolbarDone = false;

    blocks.forEach(function (b) {
      if (b.type === 'greeting') { body.append(greeting(b, ctx)); return; }
      if (b.type === 'h1') { cur.append(el('h1', { class: 'atitle' }, inline(b.text, ctx))); return; }
      if (b.type === 'h2') {
        var num = /^(\d+)\.\s+(.*)$/.exec(b.text), isSrc = b.text === 'Sources';
        if (!num && !isSrc) { cur = body; cur.append(el('h2', { class: 'ah2' }, inline(b.text, ctx))); return; }
        if (!toolbarDone) { toolbarDone = true; body.append(toolbar(ctx)); }
        var id = isSrc ? 's-sources' : 's' + num[1];
        var d = el('details', { class: 'sec', id: 'about-' + id }), sum = el('summary', {}, num ? el('span', { class: 'secnum' }, num[1]) : null, el('span', {}, num ? num[2] : b.text));
        var inner = el('div', { class: 'secbody' });
        d.append(sum, inner);
        var openNow = persist.open ? persist.open.indexOf(id) >= 0 : id === 's1';
        d.open = openNow;
        d.addEventListener('toggle', function () { persist.open = ctx.sections.filter(function (s) { return s.node.open; }).map(function (s) { return s.id; }); });
        ctx.sections.push({ id: id, node: d, label: (num ? num[1] + '. ' : '') + (num ? num[2] : b.text) });
        Object.defineProperty(ctx.sections[ctx.sections.length - 1], 'open', { get: function () { return d.open; }, set: function (v) { d.open = v; } });
        body.append(d); cur = inner; return;
      }
      if (b.type === 'h3') { cur.append(el('h3', { class: 'ah3' }, inline(b.text, ctx))); return; }
      if (b.type === 'hr') { if (!toolbarDone) cur = body; return; }
      if (b.type === 'p') { cur.append(el('p', {}, inline(b.text, ctx))); return; }
      if (b.type === 'quote') { cur.append(el('blockquote', {}, inline(b.text, ctx))); return; }
      if (b.type === 'list') { cur.append(el('ul', { class: 'alist' }, b.items.map(function (x) { return el('li', {}, inline(x, ctx)); }))); return; }
      if (b.type === 'table') { cur.append(buildTable(b, ctx)); return; }
      if (b.type === 'visual') { cur.append(visual(b.name)); return; }
      if (b.type === 'legend') {
        cur.append(el('div', { class: 'legend' }, el('span', { class: 'muted small' }, 'Pain points:'), painChip('A', ctx, true), painChip('B', ctx, true), el('span', { class: 'muted small' }, 'Press one to highlight its endpoints.')));
        return;
      }
    });

    // Rail: jump to a section, opening it first.
    rail.append(el('div', { class: 'railh' }, 'On this page'));
    var links = [];
    function addLink(label, target, id) {
      var a = el('a', { href: '#about-' + id, 'data-sec': id }, label);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var sec = ctx.sections.filter(function (s) { return s.id === id; })[0];
        if (sec) sec.open = true;
        target.scrollIntoView({ behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      });
      rail.append(a); links.push(a);
    }
    addLink('Overview', body.querySelector('.atitle') || body, 'top');
    ctx.sections.forEach(function (s) { addLink(s.label, s.node, s.id); });
    root.append(rail, body, ctx.tip);
    host.innerHTML = ''; host.append(root);

    if (persist.hl) setHighlight(ctx, persist.hl);
    window.addEventListener('scroll', function () { hideTip(ctx); }, { passive: true });
    if (typeof IntersectionObserver !== 'undefined') {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var sid = en.target.getAttribute('data-sec-id');
          links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-sec') === sid); });
        });
      }, { rootMargin: '-15% 0px -75% 0px' });
      ctx.sections.forEach(function (s) { s.node.setAttribute('data-sec-id', s.id); io.observe(s.node); });
    }
    return ctx;
  }

  function toolbar(ctx) {
    return el('div', { class: 'toolbar' }, el('span', { class: 'muted small' }, 'Six sections. Open the ones you want.'),
      el('button', { type: 'button', class: 'sm', onclick: function () { setAll(ctx, true); } }, 'Expand all'),
      el('button', { type: 'button', class: 'sm', onclick: function () { setAll(ctx, false); } }, 'Collapse all'));
  }

  // ------------------------------------------------------------ styles
  var CSS = [
    '.about{display:grid;grid-template-columns:190px minmax(0,1fr);gap:28px;align-items:start;line-height:1.6}',
    '.about .abody{min-width:0;max-width:860px}',
    '.about p{margin:8px 0}',
    '.about a{color:var(--acc);word-break:break-word}',
    '.about code{background:var(--code);border-radius:5px;padding:1px 5px;font-size:.88em}',
    '.about .atitle{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:26px 0 2px;font-weight:700}',
    '.about .ah2{font-size:26px;margin:2px 0 2px;line-height:1.2}',
    '.about .ah3{font-size:15px;margin:18px 0 6px}',
    '.about blockquote{margin:10px 0;padding:8px 14px;border-left:3px solid var(--acc);background:var(--info-bg);border-radius:0 8px 8px 0}',
    '.about .alist{padding-left:20px;margin:8px 0}.about .alist li{margin:4px 0}',
    '.about table{margin:10px 0}.about td strong{font-weight:650}',
    '.rail{position:sticky;top:12px;display:flex;flex-direction:column;gap:2px;font-size:13px}',
    '.rail .railh{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 6px;font-weight:700}',
    '.rail a{color:var(--mut);text-decoration:none;padding:5px 8px;border-left:2px solid var(--line);line-height:1.35}',
    '.rail a:hover{color:var(--ink);border-left-color:var(--acc)}',
    '.rail a.on{color:var(--ink);border-left-color:var(--acc);font-weight:600}',
    '.greet{display:flex;gap:16px;align-items:flex-start;margin:6px 0 4px}',
    '.greet .avatar{width:96px;height:96px;border-radius:50%;flex:none;border:2px solid var(--line);background:var(--card)}',
    '.greet .bubble{position:relative;background:var(--card);border:1px solid var(--line);border-radius:6px 16px 16px 16px;padding:14px 16px;box-shadow:0 2px 10px rgba(0,0,0,.06);animation:abIn .5s ease both}',
    '.greet .gtext{font-size:16px;line-height:1.6}',
    '.greet .gact{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
    '@keyframes abIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.greet .bubble{animation:none}}',
    '.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 6px}',
    '.sec{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0;scroll-margin-top:12px}',
    '.sec>summary{cursor:pointer;list-style:none;display:flex;gap:12px;align-items:center;padding:14px 16px;font-size:17px;font-weight:650;color:var(--ink);margin:0}',
    '.sec>summary::-webkit-details-marker{display:none}',
    '.sec>summary::after{content:"+";margin-left:auto;color:var(--mut);font-size:20px;font-weight:400}',
    '.sec[open]>summary::after{content:"\\2212"}',
    '.sec[open]>summary{border-bottom:1px solid var(--line)}',
    '.secnum{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:var(--info-bg);color:var(--info);font-size:13px;flex:none}',
    '.secbody{padding:4px 16px 16px}',
    '.pgroup{display:inline-flex;gap:4px}',
    '.pchip{border-radius:999px;min-width:26px;padding:1px 9px;font-size:12.5px;font-weight:700;cursor:pointer;line-height:1.5}',
    '.pchip.pA{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn)}',
    '.pchip.pB{background:var(--info-bg);color:var(--info);border:1px solid var(--info)}',
    '.pchip[aria-pressed=true]{box-shadow:0 0 0 2px var(--ink)}',
    '.pchip.plong{padding:3px 12px;font-size:13px;font-weight:600}',
    '.legend{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}',
    '.ptip{position:fixed;z-index:60;background:var(--ink);color:var(--bg);padding:6px 10px;border-radius:8px;font-size:12.5px;line-height:1.4;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25)}',
    '.ptip[hidden]{display:none}',
    '.about[data-hl=A] tr[data-pain]:not([data-pain~=A]),.about[data-hl=B] tr[data-pain]:not([data-pain~=B]){opacity:.3}',
    '.about[data-hl=A] tr[data-pain~=A],.about[data-hl=B] tr[data-pain~=B]{background:var(--info-bg)}',
    '.explorer .xhint{margin:6px 0 0;color:var(--mut);font-size:13px}',
    '.about tr.pick{cursor:pointer}.about tr.pick:hover{background:var(--code)}.about tr.pick.sel{background:var(--info-bg)}',
    '.about tr.pick:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}',
    '.xpanel{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--code)}',
    '.xline{display:flex;gap:10px;margin:3px 0;flex-wrap:wrap}.xk{min-width:110px;color:var(--mut);font-size:12.5px;font-weight:600}',
    'figure.visual{margin:14px 0}figure.visual figcaption{color:var(--mut);font-size:13px;margin-top:8px}',
    '.flow{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:22px 26px;counter-reset:f}',
    '.flow li{position:relative;flex:1 1 150px;min-width:140px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 10px 10px;display:flex;flex-direction:column;gap:6px;font-size:13.5px}',
    '.flow li:not(:last-child)::after{content:"\\2192";position:absolute;right:-22px;top:50%;transform:translateY(-50%);color:var(--mut);font-size:18px}',
    '.flow li.catch{border-color:var(--ok);background:var(--ok-bg)}.flow li.late{border-color:var(--bad);background:var(--bad-bg)}',
    '.flow .fn{font-weight:700;color:var(--mut);font-size:12px}',
    '.flow .flag{align-self:flex-start;font-size:11px;line-height:1.35;font-weight:700;padding:2px 8px;border-radius:10px;background:var(--card);border:1px solid currentColor}',
    '.flag.good{color:var(--ok)}.flag.bad{color:var(--bad)}',
    '.mt{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}',
    '.mt-main{flex:1 1 360px;display:flex;flex-direction:column;gap:10px;align-items:stretch}',
    '.mt-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mt-col{display:flex;flex-direction:column;gap:6px}',
    '.mt-box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px;text-align:center}',
    '.mt-box.top{background:var(--acc);color:var(--acc-ink);border-color:var(--acc);font-weight:700;font-size:14px}',
    '.mt-box.mid{background:var(--info-bg);color:var(--info);font-weight:650}',
    '.mt-box.out{background:var(--ok-bg);color:var(--ok);font-weight:650}',
    '.mt-guard{flex:0 1 230px;border:1px dashed var(--bad);border-radius:10px;padding:10px 12px;font-size:13px}.mt-guard ul{margin:6px 0 0;padding-left:18px}',
    '.calc{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0;background:var(--card)}',
    '.calc-title{font-weight:650;margin-bottom:8px}',
    '.calc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 18px}',
    '.cf{display:flex;flex-direction:column;gap:2px;font-size:13px}.cf .cl{color:var(--mut)}.cf input{width:100%}.cf output{font-weight:650}',
    '.calc-out{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:12px 0 8px}',
    '.calc-out .tile.big b{color:var(--acc)}',
    '@media(max-width:900px){.about{grid-template-columns:1fr;gap:10px}.rail{position:static;flex-direction:row;overflow-x:auto;gap:6px;padding-bottom:4px}.rail .railh{display:none}.rail a{white-space:nowrap;border-left:0;border-bottom:2px solid var(--line)}.rail a.on{border-bottom-color:var(--acc)}.greet{flex-direction:column}.flow li:not(:last-child)::after{display:none}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('about-css')) return;
    var s = document.createElement('style'); s.id = 'about-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  return { mount: mount, parse: parse, calc: { example: calcExample, breakEven: calcBreakEven }, fmtINR: fmtINR, fmtNum: fmtNum, VISUALS: VISUALS, painsIn: painsIn };
});
