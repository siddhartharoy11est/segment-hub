/* Segment Hub engine.
 * One module, two homes: runs in Node (server.js) and in the browser (demo page).
 * Every endpoint is served by hub.handle({method, path, query, headers, body}).
 * Prototype notes: signatures are simulated, consent strings are not decoded (demo tokens only),
 * state is in memory. Everything else is real logic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SegmentHub = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- utilities
  function cyrb53(str, seed) {
    seed = seed || 0;
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function hash(s) { return cyrb53(String(s)).toString(16).padStart(14, '0').slice(-8); }
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function iso(t) { return new Date(t).toISOString(); }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function setOf(a) { return new Set(a || []); }
  function sameSet(a, b) { if (a.size !== b.size) return false; for (var x of a) if (!b.has(x)) return false; return true; }
  function isSubset(a, b) { for (var x of a) if (!b.has(x)) return false; return true; } // a subset of b
  function diffSet(a, b) { var o = []; for (var x of a) if (!b.has(x)) o.push(x); return o.sort(); }
  function lower(o) { var r = {}; Object.keys(o || {}).forEach(function (k) { r[k.toLowerCase()] = o[k]; }); return r; }
  function lev(a, b) {
    var m = [], i, j;
    for (i = 0; i <= a.length; i++) m[i] = [i];
    for (j = 0; j <= b.length; j++) m[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  }

  var REGION_NAMES = {
    'IN-WB': 'West Bengal', 'IN-OD': 'Odisha', 'IN-DL': 'Delhi', 'IN-HR': 'Haryana', 'IN-MH': 'Maharashtra',
    'IN-KA': 'Karnataka', 'IN-TN': 'Tamil Nadu', 'IN-BR': 'Bihar', 'IN-AS': 'Assam', 'IN-JH': 'Jharkhand',
    'IN-UP': 'Uttar Pradesh', 'IN-GJ': 'Gujarat'
  };
  function regionLabel(c) { return REGION_NAMES[c] ? REGION_NAMES[c] + ' (' + c + ')' : c; }

  // ---------------------------------------------------------------- rule model
  var FIELDS = {
    'device.geo.country': { kind: 'scalar', ops: ['in', 'not_in', 'eq'], pattern: /^[A-Z]{3}$/, dim: 'country' },
    'device.geo.region': { kind: 'scalar', ops: ['in', 'not_in', 'eq'], pattern: /^[A-Z]{2}-[A-Z0-9]{1,3}$/, dim: 'region' },
    'device.type': { kind: 'scalar', ops: ['in', 'not_in', 'eq'], enum: ['mobile', 'tablet', 'desktop', 'ctv'], dim: 'device' },
    'device.os': { kind: 'scalar', ops: ['in', 'not_in', 'eq'], enum: ['android', 'ios', 'windows', 'macos', 'linux'], dim: 'os' },
    'site.domain': { kind: 'scalar', ops: ['in', 'not_in', 'eq', 'not_in_list'], pattern: /^[a-z0-9][a-z0-9.-]{2,98}$/, dim: 'site' },
    'site.cat': { kind: 'array', ops: ['in', 'not_in'], pattern: /^[A-Za-z0-9-]{1,12}$/, dim: 'category' }
  };
  var AUDIENCE_RE = /^audience\.[a-z0-9_]{1,40}$/;
  var RULE_KEYS = ['must', 'should', 'if_audience_missing', 'audience_required', 'strict_compliance'];
  var COND_KEYS = ['field', 'in', 'not_in', 'eq', 'not_in_list', 'consent_required'];
  var OPS = ['in', 'not_in', 'eq', 'not_in_list'];
  var LIMITS = { must: 20, tiers: 5, perTier: 10, values: 200, ruleChars: 20000 };

  function isAudience(f) { return AUDIENCE_RE.test(f); }
  function dimOf(f) { return isAudience(f) ? 'audience' : (FIELDS[f] ? FIELDS[f].dim : f); }

  var ALIASES = {
    'device.geo.state': 'device.geo.region', 'device.geo.province': 'device.geo.region', 'device.geo.zone': 'device.geo.region',
    'device.geo.nation': 'device.geo.country', 'device.devicetype': 'device.type', 'device.operating_system': 'device.os',
    'site.category': 'site.cat', 'site.categories': 'site.cat', 'site.host': 'site.domain', 'site.url': 'site.domain'
  };
  function suggestField(f) {
    if (ALIASES[f]) return ALIASES[f];
    var names = Object.keys(FIELDS);
    var prefix = f.indexOf('.') > -1 ? f.slice(0, f.lastIndexOf('.') + 1) : '';
    var pool = names.filter(function (n) { return prefix && n.indexOf(prefix) === 0; });
    if (!pool.length) pool = names;
    var best = null, bd = 99;
    pool.forEach(function (n) { var d = lev(f, n); if (d < bd) { bd = d; best = n; } });
    return best && bd <= 8 ? best : null;
  }

  function parseListRef(ref) {
    var m = /^([a-z0-9_]+)(?:@(\d+))?$/.exec(ref || '');
    return m ? { name: m[1], pin: m[2] ? parseInt(m[2], 10) : null } : null;
  }

  // listInfo(name) -> {latest, versions:int} or null. Used for validation.
  function validateRule(rule, listInfo) {
    var errors = [], warnings = [];
    function err(code, message, path, extra) { errors.push(Object.assign({ error: code, message: message, path: path }, extra || {})); }
    if (!isObj(rule)) { err('invalid_rule', 'rule must be a JSON object', ''); return { ok: false, errors: errors, warnings: warnings }; }
    if (canon(rule).length > LIMITS.ruleChars) {
      err('rule_too_large', 'rule is larger than ' + LIMITS.ruleChars + ' characters', ''); return { ok: false, errors: errors, warnings: warnings };
    }
    Object.keys(rule).forEach(function (k) { if (RULE_KEYS.indexOf(k) < 0) err('invalid_rule', "Unknown key '" + k + "' in rule", k); });
    var seenAudienceWarn = {};

    function checkCond(c, path, inMust) {
      if (!isObj(c)) { err('invalid_rule', 'condition must be an object', path); return; }
      ['all', 'any', 'not', 'or', 'and'].forEach(function (k) {
        if (k in c) err('nesting_not_supported', "Nested conditions ('" + k + "') are not supported. Keep conditions flat", path);
      });
      Object.keys(c).forEach(function (k) {
        if (COND_KEYS.indexOf(k) < 0 && ['all', 'any', 'not', 'or', 'and'].indexOf(k) < 0) err('invalid_rule', "Unknown key '" + k + "' in condition", path + '.' + k);
      });
      var f = c.field;
      if (typeof f !== 'string') { err('invalid_rule', 'condition needs a string field', path); return; }
      var aud = isAudience(f), spec = FIELDS[f];
      if (!aud && !spec) {
        var s = suggestField(f);
        err('invalid_rule', "Unknown field '" + f + "'." + (s ? " Did you mean '" + s + "'?" : ''), path + '.field', s ? { suggestion: s } : {});
        return;
      }
      var ops = OPS.filter(function (o) { return o in c; });
      if (ops.length !== 1) { err('invalid_rule', 'condition needs exactly one of in, not_in, eq, not_in_list', path); return; }
      var op = ops[0], val = c[op];
      if (aud) {
        if (op !== 'eq' || typeof val !== 'boolean') { err('invalid_rule', 'audience fields support only {eq: true|false}', path); return; }
        if (c.consent_required === false) { err('consent_required', 'consent_required cannot be false on an audience field', path + '.consent_required'); return; }
        if (c.consent_required !== true && !seenAudienceWarn[f]) {
          seenAudienceWarn[f] = true;
          warnings.push(f + ' needs consent: tag added automatically');
        }
        c.consent_required = true;
        return;
      }
      if (c.consent_required !== undefined) { err('invalid_rule', 'consent_required only applies to audience fields', path + '.consent_required'); }
      if (spec.ops.indexOf(op) < 0) { err('invalid_rule', "Operator '" + op + "' is not allowed on " + f, path); return; }
      if (op === 'not_in_list') {
        var ref = typeof val === 'string' ? parseListRef(val) : null;
        if (!ref) { err('invalid_rule', 'not_in_list needs a list name like excl_buyer_blocklist or excl_buyer_blocklist@2', path); return; }
        var info = listInfo ? listInfo(ref.name) : null;
        if (!info) { err('unknown_list', "Exclusion list '" + ref.name + "' does not exist", path); return; }
        if (ref.pin !== null && (ref.pin < 1 || ref.pin > info.versions)) { err('unknown_list', "List '" + ref.name + "' has no version " + ref.pin, path); }
        return;
      }
      var vals = op === 'eq' ? [val] : val;
      if (op !== 'eq' && (!Array.isArray(vals) || !vals.length)) { err('invalid_rule', op + ' needs a non-empty array', path); return; }
      if (vals.length > LIMITS.values) { err('invalid_rule', 'at most ' + LIMITS.values + ' values per condition', path); return; }
      vals.forEach(function (v) {
        if (typeof v !== 'string') { err('invalid_rule', 'values must be strings', path); return; }
        if (spec.enum && spec.enum.indexOf(v) < 0) err('invalid_rule', "Invalid value '" + v + "' for " + f + '. Allowed: ' + spec.enum.join(', '), path);
        else if (spec.pattern && !spec.pattern.test(v)) err('invalid_rule', "Invalid value '" + v + "' for " + f, path);
      });
    }

    var must = rule.must;
    if (!Array.isArray(must) || must.length === 0) {
      err('empty_must', 'A segment needs at least one hard condition in must, otherwise it matches everything', 'must');
    } else {
      if (must.length > LIMITS.must) err('invalid_rule', 'at most ' + LIMITS.must + ' must conditions', 'must');
      must.forEach(function (c, i) { checkCond(c, 'must[' + i + ']', true); });
    }
    var tiersSeen = {};
    if (rule.should !== undefined) {
      if (!Array.isArray(rule.should)) err('invalid_rule', 'should must be an array of tiers', 'should');
      else {
        if (rule.should.length > LIMITS.tiers) err('invalid_rule', 'at most ' + LIMITS.tiers + ' tiers', 'should');
        rule.should.forEach(function (t, i) {
          var p = 'should[' + i + ']';
          if (!isObj(t) || !Number.isInteger(t.tier) || t.tier < 1 || t.tier > 9) { err('invalid_rule', 'each tier needs an integer tier from 1 to 9', p); return; }
          if (tiersSeen[t.tier]) err('invalid_rule', 'duplicate tier ' + t.tier, p);
          tiersSeen[t.tier] = true;
          if (!Array.isArray(t.all) || !t.all.length) { err('invalid_rule', 'tier needs a non-empty all array', p + '.all'); return; }
          if (t.all.length > LIMITS.perTier) err('invalid_rule', 'at most ' + LIMITS.perTier + ' conditions per tier', p);
          t.all.forEach(function (c, j) { checkCond(c, p + '.all[' + j + ']', false); });
        });
      }
    }
    if (rule.if_audience_missing !== undefined && ['fall_back_to_context', 'ineligible'].indexOf(rule.if_audience_missing) < 0)
      err('invalid_rule', "if_audience_missing must be 'fall_back_to_context' or 'ineligible'", 'if_audience_missing');
    ['audience_required', 'strict_compliance'].forEach(function (k) {
      if (rule[k] !== undefined && typeof rule[k] !== 'boolean') err('invalid_rule', k + ' must be true or false', k);
    });
    if (!errors.length && rule.audience_required) {
      var hasAud = ((rule.must || []).concat([].concat.apply([], (rule.should || []).map(function (t) { return t.all; }))))
        .some(function (c) { return isAudience(c.field); });
      if (!hasAud) err('invalid_rule', 'audience_required needs at least one audience condition', 'audience_required');
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function normalizeRule(rule) {
    var r = clone(rule);
    function nc(c) {
      var o = Object.assign({}, c);
      ['in', 'not_in'].forEach(function (k) { if (Array.isArray(o[k])) o[k] = Array.from(new Set(o[k])).sort(); });
      return o;
    }
    function cmp(a, b) { var x = canon(a), y = canon(b); return x < y ? -1 : x > y ? 1 : 0; }
    r.must = (r.must || []).map(nc).sort(cmp);
    r.should = (r.should || []).map(function (t) { return { tier: t.tier, all: (t.all || []).map(nc).sort(cmp) }; }).sort(function (a, b) { return a.tier - b.tier; });
    r.if_audience_missing = r.if_audience_missing || 'fall_back_to_context';
    r.audience_required = !!r.audience_required;
    r.strict_compliance = !!r.strict_compliance;
    return r;
  }

  function listRefs(rule) {
    var out = {};
    function scan(c) { if (c.not_in_list) out[c.not_in_list] = true; }
    (rule.must || []).forEach(scan);
    (rule.should || []).forEach(function (t) { t.all.forEach(scan); });
    return Object.keys(out).sort();
  }

  // lists: map of ref -> {version, domains}. Ref may be 'name' (floating) or 'name@N' (pinned).
  function resolveList(lists, ref) {
    if (lists[ref]) return lists[ref];
    var p = parseListRef(ref);
    return p && lists[p.name] ? lists[p.name] : { version: 0, domains: [] };
  }
  function effectiveFingerprint(rule, lists, deals) {
    var nr = normalizeRule(rule);
    var parts = listRefs(nr).map(function (ref) {
      var l = resolveList(lists, ref);
      return ref + ':' + l.version + ':' + hash(canon((l.domains || []).slice().sort()));
    });
    return hash(canon(nr) + '|' + parts.join(',') + (deals && deals.length ? '|deals:' + deals.slice().sort().join(',') : ''));
  }

  // ---------------------------------------------------------------- blast radius
  function constraints(rule, lists) {
    var inc = {}, exc = {}, eq = {};
    (rule.must || []).forEach(function (c) {
      var f = c.field;
      if ('in' in c) { var s = setOf(c.in); inc[f] = inc[f] ? new Set(Array.from(inc[f]).filter(function (x) { return s.has(x); })) : s; }
      if ('not_in' in c) { exc[f] = new Set(Array.from(exc[f] || []).concat(c.not_in)); }
      if ('not_in_list' in c) { exc[f] = new Set(Array.from(exc[f] || []).concat(resolveList(lists, c.not_in_list).domains || [])); }
      if ('eq' in c) { eq[f] = c.eq; }
    });
    return { inc: inc, exc: exc, eq: eq };
  }
  function gateLevel(rule) { return rule.audience_required ? 3 : rule.if_audience_missing === 'ineligible' ? 2 : 1; }
  function fmtVals(f, arr) { return arr.map(function (v) { return f === 'device.geo.region' ? regionLabel(v) : v; }).join(', '); }

  // How does newRule differ from oldRule? 'wider' means newRule can match more traffic.
  function compareRules(oldRule, newRule, oldLists, newLists, oldDeals, newDeals) {
    oldRule = normalizeRule(oldRule); newRule = normalizeRule(newRule);
    oldLists = oldLists || {}; newLists = newLists || oldLists;
    var a = constraints(oldRule, oldLists), b = constraints(newRule, newLists);
    var dims = [];
    function add(dimension, change, detail) { dims.push({ dimension: dimension, change: change, detail: detail }); }
    var fields = {};
    [a.inc, b.inc, a.exc, b.exc, a.eq, b.eq].forEach(function (m) { Object.keys(m).forEach(function (k) { fields[k] = true; }); });
    Object.keys(fields).sort().forEach(function (f) {
      var dim = dimOf(f);
      var oi = a.inc[f], ni = b.inc[f];
      if (oi || ni) {
        if (oi && !ni) add(dim, 'wider', 'removes the ' + dim + ' restriction');
        else if (!oi && ni) add(dim, 'narrower', 'adds a ' + dim + ' restriction: ' + fmtVals(f, Array.from(ni).sort()));
        else if (!sameSet(oi, ni)) {
          var added = diffSet(ni, oi), removed = diffSet(oi, ni);
          if (!removed.length) add(dim, 'wider', 'adds ' + fmtVals(f, added));
          else if (!added.length) add(dim, 'narrower', 'removes ' + fmtVals(f, removed));
          else add(dim, 'mixed', 'adds ' + fmtVals(f, added) + ' and removes ' + fmtVals(f, removed));
        }
      }
      var oe = a.exc[f], ne = b.exc[f];
      if (oe || ne) {
        var o = oe || new Set(), n = ne || new Set();
        if (!sameSet(o, n)) {
          var more = diffSet(n, o), less = diffSet(o, n);
          if (!less.length) add('exclusions', 'narrower', 'excludes more sites: ' + more.join(', '));
          else if (!more.length) add('exclusions', 'wider', 'stops excluding: ' + less.join(', '));
          else add('exclusions', 'mixed', 'exclusion set changed in both directions');
        }
      }
      var oq = a.eq[f], nq = b.eq[f];
      if (f in a.eq || f in b.eq) {
        if (!(f in a.eq)) add(dim, 'narrower', 'adds a requirement on ' + f);
        else if (!(f in b.eq)) add(dim, 'wider', 'removes the requirement on ' + f);
        else if (oq !== nq) add(dim, 'unclassified', 'changes ' + f + ' from ' + oq + ' to ' + nq);
      }
    });
    // Deal bindings: a version that attaches more Deal IDs lets more demand reach the same traffic.
    var od = setOf(oldDeals), nd = setOf(newDeals);
    if (!sameSet(od, nd)) {
      var addD = diffSet(nd, od), remD = diffSet(od, nd);
      if (!remD.length) add('deals', 'wider', 'attaches deals: ' + addD.join(', '));
      else if (!addD.length) add('deals', 'narrower', 'detaches deals: ' + remD.join(', '));
      else add('deals', 'mixed', 'deal bindings changed in both directions');
    }
    var go = gateLevel(oldRule), gn = gateLevel(newRule);
    if (gn > go) add('audience_gate', 'narrower', 'requires audience data more strictly');
    else if (gn < go) add('audience_gate', 'wider', 'allows delivery with less audience data');
    var tierChange = canon(oldRule.should) !== canon(newRule.should);
    var kinds = dims.map(function (d) { return d.change; });
    var kind;
    if (kinds.indexOf('unclassified') > -1) kind = 'unclassified';
    else if (!kinds.length) kind = 'no_change';
    else if (kinds.indexOf('mixed') > -1 || (kinds.indexOf('wider') > -1 && kinds.indexOf('narrower') > -1)) kind = 'mixed_change';
    else if (kinds.indexOf('wider') > -1) kind = 'expands_reach';
    else kind = 'narrows_reach';
    return { kind: kind, dimensions: dims, tier_change: tierChange, strict_change: oldRule.strict_compliance !== newRule.strict_compliance };
  }

  function blastRadius(cmp, activeVersion) {
    var k = cmp.kind;
    var out = {
      vs_active: activeVersion,
      new_version_change: k,
      publish_risk: k === 'expands_reach' || k === 'mixed_change' || k === 'unclassified' ? 'high' : k === 'narrows_reach' ? 'lower' : 'none',
      old_copy_would_be: k === 'expands_reach' ? 'narrower' : k === 'narrows_reach' ? 'wider' : k === 'no_change' ? 'same' : 'mixed',
      stale_copy_risk: k === 'expands_reach' ? 'low' : k === 'no_change' ? 'none' : 'high',
      dimensions: cmp.dimensions,
      tier_change: cmp.tier_change,
      strict_change: cmp.strict_change
    };
    var parts = cmp.dimensions.map(function (d) { return d.dimension + ': ' + d.detail; });
    var head = {
      expands_reach: 'Wider reach. More traffic can match, so check the client agreed.',
      narrows_reach: 'Tighter reach. It can over-block but not leak. Servers still on the old copy would be wider than intended.',
      mixed_change: 'Mixed change: some dimensions widen and some tighten. Treated as wider, conservatively.',
      unclassified: 'Change could not be classified. Treated as wider, conservatively.',
      no_change: 'Same eligibility. Only priority tiers or flags changed.'
    }[k];
    out.plain_language = head + (parts.length ? ' ' + parts.join('; ') + '.' : '');
    return out;
  }

  // Classify the copy a server holds against what is active now. The answer is about the held copy:
  // 'wider' can match traffic the active version refuses (exposure), 'narrower' only under-delivers.
  function classifyStale(held, active, heldLists, curLists) {
    if (!held) return { kind: 'missing', risk: 'low', summary: 'The server does not hold this segment yet, so it serves nothing for it (under-delivery).' };
    if (held.paused && !active.paused) return { kind: 'narrower', risk: 'low', summary: 'The server holds a paused copy while the active one is live (under-delivery).' };
    if (!held.paused && active.paused) return { kind: 'wider', risk: 'high', summary: 'The segment is stopped, but this copy is still live.' };
    var cmp = compareRules(held.rule, active.rule, heldLists, curLists, held.deal_ids, active.deal_ids);
    var dims = cmp.dimensions.map(function (d) { return d.dimension + ': ' + d.detail; }).join('; ');
    // The active version asks for audience data more strictly, so this copy delivers with less consent and audience data than it should.
    var crit = cmp.dimensions.some(function (d) { return d.dimension === 'audience_gate' && d.change === 'narrower'; });
    if (cmp.kind === 'expands_reach') return { kind: 'narrower', risk: 'low', summary: 'Held copy is narrower than active: it under-delivers but cannot reach traffic the client excluded. What the active version has that this copy lacks: ' + dims, dimensions: cmp.dimensions };
    if (cmp.kind === 'narrows_reach') return { kind: 'wider', risk: 'high', consent_critical: crit, summary: 'Held copy is wider than active: it can make the deal eligible on traffic the client excluded. What the active version changed: ' + dims, dimensions: cmp.dimensions };
    if (cmp.kind === 'no_change') return { kind: 'tiers_only', risk: 'low', summary: 'Same eligibility. Only priority tiers differ.', dimensions: [] };
    return { kind: cmp.kind === 'unclassified' ? 'unclassified' : 'mixed', risk: 'high', consent_critical: crit, summary: 'Mixed or unclassifiable difference, treated as wider (conservative). ' + dims, dimensions: cmp.dimensions };
  }

  // ---------------------------------------------------------------- matching
  var A3TOA2 = { IND: 'IN', USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', ESP: 'ES', ITA: 'IT', NLD: 'NL', ARE: 'AE', SGP: 'SG', AUS: 'AU', CAN: 'CA', BRA: 'BR', JPN: 'JP' };
  var DEVTYPE = { 1: 'mobile', 2: 'desktop', 3: 'ctv', 4: 'mobile', 5: 'tablet', 6: 'ctv', 7: 'ctv' };
  function hostOf(url) { var m = /^[a-z]+:\/\/([^\/?#:]+)/i.exec(url || ''); return m ? m[1].toLowerCase() : null; }

  function normaliseRequest(b) {
    b = isObj(b) ? b : {};
    var dev = isObj(b.device) ? b.device : {}, geo = isObj(dev.geo) ? dev.geo : {}, site = isObj(b.site) ? b.site : {};
    var user = isObj(b.user) ? b.user : {}, regs = isObj(b.regs) ? b.regs : {};
    var warnings = [];
    var cats = [].concat(site.cat || [], site.pagecat || [], site.sectioncat || []).filter(function (x) { return typeof x === 'string'; });
    if (cats.length && site.cattax === undefined) warnings.push('site.cattax missing: assumed Content Taxonomy 1.0 (cattax 1). Always send cattax.');
    if (cats.length && site.cattax !== undefined && site.cattax !== 1) warnings.push('cattax ' + site.cattax + ' is not mapped in this prototype; category IDs are compared as given.');
    var aud = new Set();
    (Array.isArray(user.data) ? user.data : []).forEach(function (d) {
      (isObj(d) && Array.isArray(d.segment) ? d.segment : []).forEach(function (s) { if (isObj(s) && typeof s.id === 'string') aud.add(s.id); });
    });
    var cs = [user.consent, isObj(user.ext) ? user.ext.consent : null, regs.gpp].filter(function (x) { return typeof x === 'string' && x.length; })[0] || null;
    var dtype = typeof dev.type === 'string' ? dev.type.toLowerCase() : (DEVTYPE[dev.devicetype] || null);
    var country = typeof geo.country === 'string' ? geo.country.toUpperCase() : null;
    var region = typeof geo.region === 'string' ? geo.region.toUpperCase() : null;
    // Exchanges often send the bare subdivision ("WB") instead of ISO 3166-2 ("IN-WB"). Prefix it from the country.
    if (region && region.indexOf('-') < 0 && country && A3TOA2[country]) { warnings.push('region ' + region + ' expanded to ' + A3TOA2[country] + '-' + region + ' using country ' + country); region = A3TOA2[country] + '-' + region; }
    return {
      request_id: typeof b.id === 'string' ? b.id : null,
      country: country,
      region: region,
      device_type: dtype,
      os: typeof dev.os === 'string' ? dev.os.toLowerCase() : null,
      domain: typeof site.domain === 'string' ? site.domain.toLowerCase() : hostOf(site.page),
      cats: Array.from(new Set(cats)),
      audience: aud,
      consent: { present: !!cs, valid: !!cs && !/denied/i.test(cs) },
      warnings: warnings
    };
  }
  function valueOf(field, r) {
    switch (field) {
      case 'device.geo.country': return r.country;
      case 'device.geo.region': return r.region;
      case 'device.type': return r.device_type;
      case 'device.os': return r.os;
      case 'site.domain': return r.domain;
      case 'site.cat': return r.cats;
    }
    return null;
  }
  function domainHit(domain, list) {
    if (!domain) return null;
    for (var i = 0; i < list.length; i++) if (domain === list[i] || domain.slice(-(list[i].length + 1)) === '.' + list[i]) return list[i];
    return null;
  }
  function audienceUsable(r) { return r.consent.valid && r.audience.size > 0; }

  function evalCond(c, r, lists) {
    var f = c.field;
    if (isAudience(f)) {
      var id = f.slice('audience.'.length), has = r.consent.valid && r.audience.has(id);
      var want = c.eq !== false;
      return { pass: has === want, audience: true, text: id + (has ? '' : ' unavailable'), fail: 'audience signal ' + id + (r.consent.valid ? ' not present' : ' not usable without consent') };
    }
    var v = valueOf(f, r), spec = FIELDS[f], label = f === 'device.geo.region' ? 'region' : f === 'device.geo.country' ? 'country' : f === 'device.type' ? 'device' : f === 'device.os' ? 'os' : f === 'site.domain' ? 'site' : 'category';
    if ('in' in c) {
      var s = setOf(c.in);
      if (spec.kind === 'array') {
        var hit = (v || []).filter(function (x) { return s.has(x); });
        return hit.length ? { pass: true, text: label + ' in [' + c.in.join(', ') + ']' } : { pass: false, fail: label + ' [' + (v || []).join(', ') + '] has none of [' + c.in.join(', ') + ']' };
      }
      if (v == null) return { pass: false, fail: label + ' missing from request' };
      return s.has(v) ? { pass: true, text: label + ' ' + v + ' in [' + c.in.join(', ') + ']' } : { pass: false, fail: label + ' ' + v + ' not in [' + c.in.join(', ') + ']' };
    }
    if ('not_in' in c) {
      var s2 = setOf(c.not_in);
      if (spec.kind === 'array') { var h2 = (v || []).filter(function (x) { return s2.has(x); }); return h2.length ? { pass: false, fail: label + ' ' + h2.join(', ') + ' is excluded' } : { pass: true, text: label + ' not excluded' }; }
      if (v != null && s2.has(v)) return { pass: false, fail: label + ' ' + v + ' is excluded' };
      return { pass: true, text: label + ' not excluded' };
    }
    if ('eq' in c) return v === c.eq ? { pass: true, text: label + ' = ' + c.eq } : { pass: false, fail: label + ' ' + v + ' is not ' + c.eq };
    if ('not_in_list' in c) {
      var l = resolveList(lists, c.not_in_list), hitd = domainHit(v, l.domains || []);
      return hitd ? { pass: false, fail: "site '" + v + "' is on exclusion list " + c.not_in_list + ' (v' + l.version + ', entry ' + hitd + ')' } : { pass: true, text: 'site not on ' + c.not_in_list };
    }
    return { pass: false, fail: 'unsupported condition' };
  }

  function evalRule(rule, r, lists) {
    var passed = [];
    for (var i = 0; i < (rule.must || []).length; i++) {
      var res = evalCond(rule.must[i], r, lists);
      if (!res.pass) return { eligible: false, reason: res.fail };
      passed.push(res.text);
    }
    var tiers = (rule.should || []).slice().sort(function (a, b) { return a.tier - b.tier; });
    var anyAud = tiers.some(function (t) { return t.all.some(function (c) { return isAudience(c.field); }); });
    var usable = audienceUsable(r);
    if (anyAud && !usable) {
      if (rule.audience_required) return { eligible: false, reason: 'audience required, but no consented audience data on this request' };
      if (rule.if_audience_missing === 'ineligible') return { eligible: false, reason: 'audience data missing and policy is ineligible' };
    }
    var best = null, bestAud = false;
    for (var t = 0; t < tiers.length; t++) {
      var tier = tiers[t], ok = true, usesAud = false, texts = [];
      for (var j = 0; j < tier.all.length; j++) {
        if (isAudience(tier.all[j].field)) usesAud = true;
        var rc = evalCond(tier.all[j], r, lists);
        if (!rc.pass) { ok = false; break; }
        texts.push(rc.text);
      }
      if (rule.audience_required && !usesAud) continue;
      if (ok) { best = { tier: tier.tier, texts: texts }; bestAud = usesAud; break; }
    }
    if (rule.audience_required && !best) return { eligible: false, reason: 'audience required, but no matching audience signal' };
    var base = passed.join('; ');
    if (best) return { eligible: true, tier: best.tier, audience_used: bestAud, reason: base + '; tier ' + best.tier + ': ' + best.texts.join(' + ') + (bestAud || !anyAud ? '' : ' (context only, no consented audience)') };
    return { eligible: true, tier: null, reason: base + '; no priority tier matched, base priority' };
  }

  // ---------------------------------------------------------------- reach estimate
  // Replays a fixed, simulated sample of bid requests through the old and the new rule, so AdOps can see how many
  // impressions a change adds or removes. In production the sample would be real, anonymised traffic sent through the same evaluator.
  var SIM_DAILY_IMPRESSIONS = 20000000, SIM_SAMPLE_SIZE = 2000, _sample = null;
  function groupIN(n) {
    var s = String(Math.round(Math.abs(n)));
    if (s.length <= 3) return s;
    return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  }
  function simSample() {
    if (_sample) return _sample;
    var seed = 20261123;
    function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
    function pick(list, wi) { wi = wi || 1; var x = rnd(), acc = 0; for (var i = 0; i < list.length; i++) { acc += list[i][wi]; if (x < acc) return list[i]; } return list[list.length - 1]; }
    var regions = [['IN-MH', .16], ['IN-KA', .14], ['IN-DL', .12], ['IN-WB', .10], ['IN-TN', .09], ['IN-GJ', .07], ['IN-OD', .05], ['IN-HR', .04], ['IN-UP', .12], ['IN-RJ', .11]];
    var devices = [[4, .62], [2, .28], [5, .10]];
    var sites = [['beauty-blog.example', 'IAB18-1', .10], ['style-magazine.example', 'IAB18-3', .08], ['news-daily.example', 'IAB12', .25], ['tech-reviews.example', 'IAB19', .18],
      ['recipes.example', 'IAB8', .17], ['sports-hub.example', 'IAB17', .15], ['cheap-clicks.example', 'IAB18-1', .03], ['viral-feed.example', 'IAB14', .02], ['glow-deals-feed.example', 'IAB18-1', .02]];
    _sample = [];
    for (var i = 0; i < SIM_SAMPLE_SIZE; i++) {
      var st = pick(sites, 2), bid = { id: 'sim-' + i, device: { devicetype: pick(devices)[0], geo: { country: 'IND', region: pick(regions)[0] } }, site: { domain: st[0], cat: [st[1]], cattax: 1 } };
      if (rnd() < (st[1].indexOf('IAB18') === 0 ? 0.35 : 0.08)) bid.user = { data: [{ id: 'partner_a', segment: [{ id: 'purchase_skincare_30d' }] }] };
      if (rnd() < 0.70) bid.regs = { gpp: 'demo-gpp-granted' };
      _sample.push(normaliseRequest(bid));
    }
    return _sample;
  }
  function estimateReach(oldRule, newRule, lists) {
    var smp = simSample(), a = 0, b = 0, w = SIM_DAILY_IMPRESSIONS / smp.length;
    smp.forEach(function (r) { if (evalRule(oldRule, r, lists).eligible) a++; if (evalRule(newRule, r, lists).eligible) b++; });
    var before = Math.round(a * w), after = Math.round(b * w);
    return { before_per_day: before, after_per_day: after, delta_per_day: after - before, delta_pct: before > 0 ? Math.round((after - before) / before * 1000) / 10 : null,
      basis: 'Simulated sample of ' + smp.length + ' requests scaled to ' + groupIN(SIM_DAILY_IMPRESSIONS) + ' impressions a day. In production, sampled real traffic goes through the same evaluator.' };
  }
  function reachSentence(r) {
    if (r.delta_per_day === 0) return 'Estimated reach on the simulated sample: unchanged at about ' + groupIN(r.before_per_day) + ' impressions a day.';
    return 'Estimated reach on the simulated sample: from about ' + groupIN(r.before_per_day) + ' to about ' + groupIN(r.after_per_day) + ' impressions a day (' + (r.delta_per_day > 0 ? '+' : '-') + groupIN(Math.abs(r.delta_per_day)) + (r.delta_pct != null ? ', ' + (r.delta_pct > 0 ? '+' : '') + r.delta_pct + '%' : '') + ').';
  }

  function matchAgainst(segments, lists, r) {
    var matches = [], excluded = [];
    Object.keys(segments).sort().forEach(function (id) {
      var s = segments[id];
      if (s.paused) { excluded.push({ segment_id: id, reason: 'segment is paused' }); return; }
      var res = evalRule(s.rule, r, lists);
      if (res.eligible) matches.push(Object.assign({ segment_id: id, version: s.version, tier: res.tier, reason: res.reason }, s.deal_ids && s.deal_ids.length ? { deal_ids: s.deal_ids } : {}));
      else excluded.push({ segment_id: id, reason: res.reason });
    });
    return { matches: matches, excluded: excluded };
  }

  // ---------------------------------------------------------------- hub
  // EXPIRY doubles as two clocks on the server side:
  //  - how long a server may keep serving a wider copy of a segment after it learns a newer revision exists
  //  - how long a server may serve a segment without reading the head at all (its lease)
  var EXPIRY = { standard: 4 * 3600, strict: 15 * 60 };
  var HEARTBEAT_SECONDS = 30;
  // Normal propagation. A copy that is behind for less than this is not counted as exposure.
  var PROPAGATION_GRACE_SECONDS = 120;

  var CLUSTERS = { mumbai: 'Edge ad servers, Mumbai', us: 'Edge ad servers, US', singapore: 'Edge ad servers, Singapore', deal_tagger: 'Curated-deal tagger' };
  var DEFAULT_CONSUMERS = [
    { id: 'edge_mum_1', cluster: 'mumbai', label: 'Mumbai 1', traffic_share: 0.11 },
    { id: 'edge_mum_2', cluster: 'mumbai', label: 'Mumbai 2', traffic_share: 0.11 },
    { id: 'edge_us_1', cluster: 'us', label: 'US 1', traffic_share: 0.19 },
    { id: 'edge_us_2', cluster: 'us', label: 'US 2', traffic_share: 0.19 },
    { id: 'edge_sg_1', cluster: 'singapore', label: 'Singapore 1', traffic_share: 0.10 },
    { id: 'edge_sg_2', cluster: 'singapore', label: 'Singapore 2', traffic_share: 0.10 },
    { id: 'edge_sg_3', cluster: 'singapore', label: 'Singapore 3', traffic_share: 0.10 },
    { id: 'deal_tagger_1', cluster: 'deal_tagger', label: 'Deal tagger 1', traffic_share: 0.10 }
  ];
  var DEFAULT_TOKENS = {
    tok_priya_adops: { actor: 'priya', role: 'writer', advertisers: ['adv_glowroot'], label: 'Priya, AdOps (writer)' },
    tok_rahul_approver: { actor: 'rahul', role: 'approver', advertisers: ['adv_glowroot'], label: 'Rahul, approver' },
    tok_meera_approver: { actor: 'meera', role: 'approver', advertisers: ['adv_glowroot'], label: 'Meera, approver' },
    tok_analytics_reader: { actor: 'analytics', role: 'reader', advertisers: ['adv_glowroot'], label: 'Analytics (reader)' },
    tok_admin: { actor: 'admin', role: 'admin', advertisers: '*', label: 'Admin' },
    tok_other_writer: { actor: 'zed', role: 'writer', advertisers: ['adv_other'], label: 'Zed, other advertiser (writer)' },
    tok_other_approver: { actor: 'olga', role: 'approver', advertisers: ['adv_other'], label: 'Olga, other advertiser (approver)' }
  };
  DEFAULT_CONSUMERS.forEach(function (c) {
    DEFAULT_TOKENS['tok_' + c.id] = { actor: c.id, role: 'consumer', consumer_id: c.id, label: c.label + ' (machine)' };
  });
  var MODES = ['healthy', 'deferred', 'failing', 'not_integrated'];
  var SECRET = 'segment-hub-demo-signing-key';
  function sign(payload) { return 'sig_' + hash(SECRET + payload) + hash(payload + SECRET); }
  var DEAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  function firstSeen(list, rev) { for (var i = 0; i < list.length; i++) if (list[i][0] >= rev) return list[i][1]; return null; }
  function round1(x) { return Math.round(x * 10) / 10; }

  function createHub(opts) {
    opts = opts || {};
    var baseNow = opts.now || function () { return Date.now(); };
    var offset = 0;
    var maxDeltaRevs = opts.maxDeltaRevs || 50;
    var tokens = opts.tokens || DEFAULT_TOKENS;
    var S;
    function now() { return baseNow() + offset; }

    function init() {
      S = { seq: 0, audit: [], lists: {}, segments: {}, catalog: [], consumers: {}, idem: {}, matchLog: [], headCache: {}, exposureClosed: {},
        autoEdges: false, ticking: false, lastTick: null, hubDown: false };
      DEFAULT_CONSUMERS.forEach(function (c) {
        S.consumers[c.id] = { id: c.id, cluster: c.cluster, cluster_name: CLUSTERS[c.cluster], name: c.label, traffic_share: c.traffic_share,
          received_rev: null, accepted_rev: null, active_rev: null, last_ack_at: null, unreachable: false, exceptions: [],
          head_seen: [], reported_head_read_at: null, locally_stopped: [], mode: 'healthy',
          edge: { last_head_read_at: null, seen: [] } };
      });
      S.catalog.push(buildCatalogEntry('empty catalog', 'system', 0));
    }

    // ---- errors
    function fail(status, code, message, extra) {
      throw { http: { status: status, body: Object.assign({ error: code, message: message }, extra || {}) } };
    }
    function audit(actor, role, action, segId, version, detail) {
      if (S.audit.length > 2000) S.audit.shift();
      S.audit.push({ seq: ++S.seq, ts: iso(now()), actor: actor, role: role, action: action, segment_id: segId || null, version: version == null ? null : version, detail: detail || null });
    }

    // ---- auth
    function authn(headers) {
      var h = headers.authorization || '';
      var m = /^Bearer\s+(\S+)$/i.exec(h);
      if (!m) fail(401, 'unauthenticated', 'Send an Authorization: Bearer <token> header');
      var t = tokens[m[1]];
      if (!t) fail(401, 'invalid_token', 'Unknown or expired token');
      return t;
    }
    function needRole(t, roles) {
      if (roles.indexOf(t.role) < 0) fail(403, 'forbidden', "Role '" + t.role + "' cannot do this. Needs: " + roles.join(' or '));
    }
    function tenantOk(t, advId) { return t.advertisers === '*' || (t.advertisers || []).indexOf(advId) > -1; }
    function getSegment(t, id) {
      var s = S.segments[id];
      if (!s || !tenantOk(t, s.advertiser_id)) fail(404, 'segment_not_found', 'No segment ' + id);
      return s;
    }

    // ---- lists and catalog
    function listInfo(name) {
      var l = S.lists[name]; return l ? { latest: l.versions[l.versions.length - 1].version, versions: l.versions.length } : null;
    }
    function currentLists(rule) { // resolve refs of a rule against latest/pinned lists
      var m = {};
      Object.keys(S.lists).forEach(function (n) {
        var v = S.lists[n].versions[S.lists[n].versions.length - 1];
        m[n] = { version: v.version, domains: v.domains.slice() };
      });
      if (rule) listRefs(rule).forEach(function (ref) {
        var p = parseListRef(ref);
        if (p && p.pin && S.lists[p.name]) { var v = S.lists[p.name].versions[p.pin - 1]; if (v) m[ref] = { version: v.version, domains: v.domains.slice() }; }
      });
      return m;
    }
    function catalogLists() {
      var m = currentLists();
      Object.keys(S.segments).forEach(function (id) {
        var s = S.segments[id]; if (s.active_version == null) return;
        var v = s.versions[s.active_version - 1];
        listRefs(v.rule).forEach(function (ref) {
          var p = parseListRef(ref);
          if (p && p.pin && S.lists[p.name]) { var lv = S.lists[p.name].versions[p.pin - 1]; if (lv) m[ref] = { version: lv.version, domains: lv.domains.slice() }; }
        });
      });
      return m;
    }
    function buildCatalogEntry(reason, actor, rev) {
      var lists = catalogLists(), segs = {};
      Object.keys(S.segments).sort().forEach(function (id) {
        var s = S.segments[id]; if (s.active_version == null) return;
        var v = s.versions[s.active_version - 1];
        segs[id] = {
          segment_id: id, advertiser_id: s.advertiser_id, name: s.name, version: v.version, rule: clone(v.rule), deal_ids: (v.deal_ids || []).slice(), paused: !!s.paused,
          fingerprint: effectiveFingerprint(v.rule, lists, v.deal_ids),
          expiry_class: v.rule.strict_compliance ? 'strict' : 'standard',
          expiry_seconds: v.rule.strict_compliance ? EXPIRY.strict : EXPIRY.standard
        };
      });
      var h = hash(canon(Object.keys(segs).map(function (k) { return [k, segs[k].fingerprint, segs[k].paused, segs[k].version]; })) + '|' +
        canon(Object.keys(lists).sort().map(function (k) { return [k, lists[k].version, hash(canon(lists[k].domains.slice().sort()))]; })));
      return { rev: rev, created_at: now(), reason: reason, actor: actor, segments: segs, lists: lists, hash: h };
    }
    function bumpCatalog(reason, actor) {
      if (S.catalog.length >= 1500) fail(429, 'quota_exceeded', 'Prototype limit: 1500 catalog revisions. Use Reset demo');
      var e = buildCatalogEntry(reason, actor, S.catalog.length);
      S.catalog.push(e);
      // In the live demo, simulated servers read the new head straight away, the way a 30 second heartbeat would.
      if (S.autoEdges) beatAll();
      return e;
    }
    function cur() { return S.catalog[S.catalog.length - 1]; }
    // First revision after heldRev in which this segment's effective copy differs from the held one.
    function staleSinceRev(segId, heldRev) {
      var hs = S.catalog[heldRev].segments[segId];
      for (var r = heldRev + 1; r < S.catalog.length; r++) {
        var e = S.catalog[r].segments[segId];
        if (!hs ? !!e : (!e || e.fingerprint !== hs.fingerprint || e.paused !== hs.paused)) return r;
      }
      return null;
    }

    // ---- the head: a small signed document every server reads every 30 seconds
    // What a server must do on its own if it holds this kind of copy and cannot apply the active one.
    // The hub works this out once, at publish time, and ships it in the head. The server enforces it.
    function serverPolicy(act, cl) {
      if (cl.risk !== 'high') return { on_server: 'keep_serving', after_seconds: null };
      if (cl.consent_critical) return { on_server: 'stop_now', after_seconds: 0 };
      var rule = act.rule;
      if (rule.strict_compliance) return { on_server: 'stop_after', after_seconds: EXPIRY.strict };
      if (rule.audience_required) return { on_server: 'stop_after', after_seconds: EXPIRY.standard };
      var hasAud = (rule.should || []).some(function (t) { return t.all.some(function (c) { return isAudience(c.field); }); });
      return hasAud ? { on_server: 'context_only_after', after_seconds: EXPIRY.standard } : { on_server: 'keep_serving_alert', after_seconds: null };
    }
    function headDoc(rev) {
      if (S.headCache[rev]) return S.headCache[rev];
      var e = S.catalog[rev], segs = {}, revoked = [];
      Object.keys(e.segments).sort().forEach(function (id) {
        var a = e.segments[id];
        if (a.paused) revoked.push(id);
        var older = [], seen = {};
        seen[a.fingerprint + '|' + a.paused] = 1;
        for (var r = rev - 1; r >= 0 && r >= rev - 50 && older.length < 8; r--) {
          var h = S.catalog[r].segments[id]; if (!h) continue;
          var k = h.fingerprint + '|' + h.paused; if (seen[k]) continue; seen[k] = 1;
          var cl = classifyStale(h, a, S.catalog[r].lists, e.lists);
          older.push(Object.assign({ fingerprint: h.fingerprint, held_copy: cl.kind }, serverPolicy(a, cl)));
        }
        segs[id] = { fingerprint: a.fingerprint, deal_ids: a.deal_ids, expiry_class: a.expiry_class, if_holding_older: older,
          if_holding_unknown: Object.assign({ held_copy: 'unknown' }, serverPolicy(a, { kind: 'unclassified', risk: 'high' })) };
      });
      var o = { catalog_rev: rev, hash: e.hash, published_at: iso(e.created_at), revoked: revoked, segments: segs,
        lease_seconds: { strict: EXPIRY.strict, standard: EXPIRY.standard }, heartbeat_seconds: HEARTBEAT_SECONDS,
        rules_for_servers: [
          'Read this head every ' + HEARTBEAT_SECONDS + ' seconds. In production it is mirrored to object storage, so it stays readable when the hub API is down.',
          'If catalog_rev is newer than the revision you serve, pull the snapshot and apply it.',
          'Stop any segment in revoked at once.',
          'If you hold an older copy of a segment, find its fingerprint in if_holding_older (or use if_holding_unknown) and do what on_server says, counting after_seconds from the moment you first read a head that is newer than your copy.',
          'If you cannot read any head for lease_seconds.strict, stop every strict segment. A hub outage does not trigger this, because the head is in object storage.'
        ] };
      o.signature = sign(canon([o.catalog_rev, o.hash, o.revoked, hash(canon(o.segments))]));
      S.headCache[rev] = o;
      return o;
    }
    function getHead(t) {
      needRole(t, ['consumer', 'admin']);
      var h = headDoc(cur().rev);
      return { status: 200, body: h, headers: { etag: '"head' + h.catalog_rev + '-' + h.hash + '"', 'cache-control': 'max-age=10' } };
    }

    // ---- simulated servers (demo only). Each one computes its own decisions from what it holds and the heads it has read.
    function edgeSeeHead(c) {
      var r = cur().rev, last = c.edge.seen[c.edge.seen.length - 1];
      c.edge.last_head_read_at = now();
      if (!last || last[0] < r) c.edge.seen.push([r, now()]);
      if (c.edge.seen.length > 200) c.edge.seen.shift();
    }
    function edgeLocalStops(c) {
      if (c.active_rev == null) return [];
      var held = S.catalog[c.active_rev], seenRev = c.edge.seen.length ? c.edge.seen[c.edge.seen.length - 1][0] : c.active_rev;
      var head = headDoc(Math.max(seenRev, c.active_rev)), out = [], t = now();
      Object.keys(held.segments).sort().forEach(function (id) {
        var hs = held.segments[id], hseg = head.segments[id];
        if (hs.paused) return;
        var sr = staleSinceRev(id, c.active_rev), learned = sr == null ? null : firstSeen(c.edge.seen, sr);
        if (head.revoked.indexOf(id) > -1) { out.push({ segment_id: id, reason: 'revoked', since: iso(learned || t) }); return; }
        if (hs.expiry_class === 'strict' && c.edge.last_head_read_at != null && t - c.edge.last_head_read_at > EXPIRY.strict * 1000) {
          out.push({ segment_id: id, reason: 'lease_expired', since: iso(c.edge.last_head_read_at + EXPIRY.strict * 1000) }); return;
        }
        if (!hseg || hseg.fingerprint === hs.fingerprint || learned == null) return;
        var pol = hseg.if_holding_older.filter(function (x) { return x.fingerprint === hs.fingerprint; })[0] || hseg.if_holding_unknown;
        if (pol.on_server !== 'stop_now' && pol.on_server !== 'stop_after') return;
        var at = learned + pol.after_seconds * 1000;
        if (t >= at) out.push({ segment_id: id, reason: pol.on_server === 'stop_now' ? 'consent_critical' : 'deadline_passed', since: iso(at) });
      });
      return out;
    }
    function edgeAck(cid, tok, rev, state, extra) {
      var c = S.consumers[cid];
      return handle({ method: 'POST', path: '/v1/consumers/' + cid + '/acks', headers: { authorization: 'Bearer ' + tok }, body: Object.assign({
        catalog_rev: rev, hash: S.catalog[rev].hash, state: state, exceptions: [], head_rev: c.edge.seen.length ? c.edge.seen[c.edge.seen.length - 1][0] : rev,
        head_read_at: c.edge.last_head_read_at ? iso(c.edge.last_head_read_at) : null }, extra || {}) });
    }
    function tokenFor(cid) { return Object.keys(tokens).filter(function (k) { return tokens[k].consumer_id === cid; })[0]; }
    function consumerSync(cid) {
      var c = S.consumers[cid]; if (!c) fail(404, 'consumer_not_found', 'No consumer ' + cid);
      var tok = tokenFor(cid), steps = [];
      if (c.unreachable) fail(503, 'consumer_unreachable', cid + ' is cut off, so it cannot read the head, pull or ack');
      edgeSeeHead(c);
      steps.push({ call: 'GET /v1/catalog/head', status: 200, catalog_rev: cur().rev });
      var q = c.active_rev == null ? {} : { since_rev: String(c.active_rev) };
      var r1 = handle({ method: 'GET', path: '/v1/catalog/snapshot', query: q, headers: { authorization: 'Bearer ' + tok } });
      steps.push({ call: 'GET /v1/catalog/snapshot' + (q.since_rev ? '?since_rev=' + q.since_rev : ''), status: r1.status });
      if (r1.status === 200 && r1.body && r1.body.mode === 'object_url') {
        var loc = r1.body.url, parts = loc.split('?'), qq = {};
        parts[1].split('&').forEach(function (kv) { var p = kv.split('='); qq[p[0]] = p[1]; });
        r1 = handle({ method: 'GET', path: parts[0], query: qq, headers: {} });
        steps.push({ call: 'GET ' + parts[0] + ' (signed object-store copy)', status: r1.status });
      }
      if (r1.status === 304) {
        var hb = edgeAck(cid, tok, c.active_rev, 'active', { locally_stopped: edgeLocalStops(c) });
        steps.push({ call: 'POST /v1/consumers/' + cid + '/acks (heartbeat)', status: hb.status });
        return { status: 200, body: { consumer_id: cid, result: 'already current', steps: steps } };
      }
      if (r1.status !== 200) fail(502, 'pull_failed', 'Snapshot pull answered ' + r1.status, { steps: steps });
      var v = verifySnapshot(r1.body);
      steps.push({ call: 'verify signature and digest', status: v.ok ? 'ok' : v.reason });
      if (!v.ok) fail(422, 'snapshot_rejected', 'Server rejected the snapshot: ' + v.reason, { steps: steps });
      var newRev = r1.body.catalog_rev;
      if (c.mode === 'failing') {
        // The reload fails. The server keeps its last good copy, reports what it received, and applies the head's rules itself.
        var r3 = edgeAck(cid, tok, newRev, 'received', { exceptions: [{ error: 'apply_failed', catalog_rev: newRev, detail: 'reload failed, still serving rev ' + c.active_rev }], locally_stopped: edgeLocalStops(c) });
        steps.push({ call: 'apply rev ' + newRev, status: 'failed' }, { call: 'POST /v1/consumers/' + cid + '/acks (state received, apply_failed)', status: r3.status });
        return { status: 200, body: { consumer_id: cid, result: 'reload failed, still serving rev ' + c.active_rev, steps: steps, ack: r3.body } };
      }
      var r2 = edgeAck(cid, tok, newRev, 'active', { locally_stopped: [] });
      steps.push({ call: 'POST /v1/consumers/' + cid + '/acks (state active)', status: r2.status });
      return { status: 200, body: { consumer_id: cid, result: 'pulled and applied rev ' + newRev, steps: steps, ack: r2.body } };
    }
    function heartbeat(cid) {
      var c = S.consumers[cid];
      if (c.unreachable || c.mode === 'not_integrated') return;
      if (c.mode === 'healthy' || c.mode === 'failing' || c.active_rev == null) { consumerSync(cid); return; }
      // deferred: reads the head and reports, but applies only when someone presses "Sync now" (a reload window or deploy freeze)
      edgeSeeHead(c);
      edgeAck(cid, tokenFor(cid), c.active_rev, 'active', { locally_stopped: edgeLocalStops(c) });
    }
    function beatAll() {
      if (S.ticking) return;
      S.ticking = true;
      try { Object.keys(S.consumers).sort().forEach(function (cid) { try { heartbeat(cid); } catch (e) { /* a failing server never breaks the hub */ } }); }
      finally { S.ticking = false; S.lastTick = now(); }
    }
    function tick() {
      if (!S.autoEdges || S.ticking || S.hubDown) return;
      if (S.lastTick == null) { S.lastTick = now(); return; }
      if (now() - S.lastTick >= HEARTBEAT_SECONDS * 1000) beatAll();
    }

    // ---- per-server sync state for one segment, from what the servers have reported
    function syncFor(segId) {
      var c0 = cur(), act = c0.segments[segId], t = now();
      if (!act) return [];
      var actHead = headDoc(c0.rev).segments[segId];
      return Object.keys(S.consumers).sort().map(function (cid) {
        var c = S.consumers[cid];
        var row = {
          consumer_id: cid, name: c.name, cluster: c.cluster, cluster_name: c.cluster_name, traffic_share: c.traffic_share, mode: c.mode,
          state: 'unknown', held_rev: c.active_rev, received_rev: c.received_rev, held_version: null, held_fingerprint: null, active_fingerprint: act.fingerprint,
          held_copy: null, risk: null, unreachable: c.unreachable, expiry_class: act.expiry_class, on_server: null, hub_action: 'probe',
          exposure_traffic_minutes: 0, exceptions: c.exceptions, last_ack_at: c.last_ack_at ? iso(c.last_ack_at) : null
        };
        var stopped = (c.locally_stopped || []).filter(function (x) { return x.segment_id === segId; })[0];
        var headRead = c.reported_head_read_at || c.last_ack_at;
        function lease() {
          if (act.expiry_class !== 'strict' || headRead == null) return { action: 'keeps_last_copy', status: 'unknown', note: 'Standard segment: keeps serving its last copy while cut off. Alert only.' };
          var at = headRead + EXPIRY.strict * 1000;
          return { action: 'stop_by_lease', stop_at: iso(at), seconds_left: Math.max(0, Math.round((at - t) / 1000)), status: t >= at ? 'expected_stopped' : 'stops_by_lease', confirmed: false,
            note: 'Strict segment: the server stops it on its own ' + (EXPIRY.strict / 60) + ' minutes after its last head read. Not confirmed until it reports again.' };
        }
        if (c.active_rev == null) { row.note = 'Has never reported an active copy. Cannot judge, so it is unknown.'; return row; }
        var held = S.catalog[c.active_rev], hs = held.segments[segId];
        row.held_version = hs ? hs.version : null; row.held_fingerprint = hs ? hs.fingerprint : null;
        var same = hs && hs.fingerprint === act.fingerprint && hs.paused === act.paused;
        if (same) {
          row.held_copy = 'same'; row.risk = 'none';
          if (c.unreachable) { row.state = 'unknown'; row.note = 'Held the active copy at its last report, but has stopped reporting.'; row.on_server = lease(); }
          else { row.state = 'in_sync'; row.hub_action = 'none'; row.on_server = stopped ? { action: 'stopped', status: 'stopped', reason: stopped.reason, since: stopped.since, confirmed: true } : null; }
          return row;
        }
        var cl = classifyStale(hs, act, held.lists, c0.lists);
        row.held_copy = cl.kind; row.risk = cl.risk; row.summary = cl.summary; row.consent_critical = !!cl.consent_critical;
        row.state = c.unreachable ? 'unknown' : 'confirmed_stale';
        var sr = staleSinceRev(segId, c.active_rev), since = sr == null ? null : S.catalog[sr].created_at;
        if (since != null) { row.stale_since = iso(since); row.stale_since_rev = sr; row.minutes_behind = Math.max(0, round1((t - since) / 60000)); }
        var pol = hs ? (actHead.if_holding_older.filter(function (x) { return x.fingerprint === hs.fingerprint; })[0] || actHead.if_holding_unknown) : serverPolicy(act, cl);
        var learned = sr == null ? null : firstSeen(c.head_seen, sr);
        if (stopped) row.on_server = { action: 'stopped', status: 'stopped', reason: stopped.reason, since: stopped.since, confirmed: true };
        else if (c.unreachable) row.on_server = lease();
        else if (pol.on_server === 'stop_now' || pol.on_server === 'stop_after' || pol.on_server === 'context_only_after') {
          if (learned == null) row.on_server = { action: pol.on_server, status: 'not_yet_aware', note: 'The server has not yet reported reading a newer head. Its clock starts when it does.' };
          else {
            var at = learned + pol.after_seconds * 1000;
            row.on_server = { action: pol.on_server, learned_at: iso(learned), stop_at: iso(at), seconds_left: Math.max(0, Math.round((at - t) / 1000)),
              status: t < at ? (pol.on_server === 'context_only_after' ? 'will_drop_audience' : 'will_stop') : (pol.on_server === 'context_only_after' ? 'audience_dropped' : 'overdue') };
          }
        } else row.on_server = { action: pol.on_server, status: pol.on_server === 'keep_serving' ? 'keeps_serving' : 'keeps_serving_alert' };
        // Exposure: traffic share times minutes a wider copy stayed live. It stops growing when the server stops the segment.
        if (cl.risk === 'high' && since != null) {
          var end = t, os = row.on_server;
          if (os && (os.status === 'stopped' || os.status === 'expected_stopped')) end = Math.min(t, Date.parse(os.since || os.stop_at));
          row.exposure_traffic_minutes = round1(c.traffic_share * Math.max(0, end - since - PROPAGATION_GRACE_SECONDS * 1000) / 60000);
        }
        var serving = !(row.on_server && (row.on_server.status === 'stopped' || row.on_server.status === 'expected_stopped'));
        if (c.unreachable) row.hub_action = 'probe';
        else if (cl.risk === 'low') row.hub_action = 'alert_p2_refresh';
        else if (!serving) row.hub_action = 'alert_p1_fix_reload';
        else if (row.on_server.status === 'overdue') row.hub_action = 'alert_p0_server_not_stopping';
        else if (row.consent_critical) row.hub_action = 'alert_p0';
        else if (row.on_server.action === 'stop_after') row.hub_action = 'alert_p1_server_stops_at_deadline';
        else row.hub_action = 'alert_p1_decide_stop_everywhere';
        row.serving_wider_copy = cl.risk === 'high' && serving;
        return row;
      });
    }
    function syncSummary(rows, segId) {
      var ids = Object.keys(S.consumers), total = ids.length;
      var acked = ids.filter(function (k) { return S.consumers[k].active_rev != null; });
      var stale = 0, high = 0, unknown = 0, open = 0, stoppedN = 0, ackTraffic = 0, clusters = {};
      acked.forEach(function (k) { ackTraffic += S.consumers[k].traffic_share; });
      rows.forEach(function (r) {
        if (r.state === 'confirmed_stale') stale += r.traffic_share;
        if (r.serving_wider_copy) high += r.traffic_share;
        if (r.state === 'unknown') unknown += r.traffic_share;
        open += r.exposure_traffic_minutes || 0;
        if (r.on_server && (r.on_server.status === 'stopped' || r.on_server.status === 'expected_stopped')) stoppedN++;
        var cs = clusters[r.cluster] || (clusters[r.cluster] = { cluster: r.cluster, name: r.cluster_name, instances: 0, in_sync: 0, stale: 0, unknown: 0, traffic_share: 0 });
        cs.instances++; cs.traffic_share += r.traffic_share;
        if (r.state === 'in_sync') cs.in_sync++; else if (r.state === 'confirmed_stale') cs.stale++; else cs.unknown++;
      });
      Object.keys(clusters).forEach(function (k) {
        var cs = clusters[k]; cs.traffic_share = round1(cs.traffic_share * 100) / 100;
        cs.one_report_per_cluster_would_say = cs.in_sync * 2 > cs.instances ? 'in sync' : cs.stale * 2 > cs.instances ? 'stale' : 'unclear';
        cs.hides_a_problem = cs.one_report_per_cluster_would_say === 'in sync' && cs.in_sync < cs.instances;
      });
      function p(x) { return round1(x * 100); }
      var closed = S.exposureClosed[segId] || 0;
      return { instances: total, ack_coverage_pct: p(acked.length / total), ack_coverage_traffic_pct: p(ackTraffic), stale_version_traffic_share_pct: p(stale),
        serving_wider_copy_share_pct: p(high), unknown_share_pct: p(unknown), stopped_locally: stoppedN,
        high_risk_stale_exposure_traffic_minutes: round1(open + closed), exposure_still_growing: high > 0,
        clusters: Object.keys(clusters).sort().map(function (k) { return clusters[k]; }),
        note: 'Traffic shares are simulated. Unknown servers are not counted as stale, which is why coverage sits next to the headline. Exposure is traffic share times minutes a wider copy stayed live beyond a ' + (PROPAGATION_GRACE_SECONDS / 60) + ' minute propagation window, kept as a running total. It needs server reports only, not impression logs.' };
    }

    // ---- views
    function versionView(v) {
      var o = { version: v.version, status: v.status, fingerprint: v.fingerprint, deal_ids: v.deal_ids || [], created_by: v.created_by, created_at: iso(v.created_at) };
      ['submitted_by', 'approved_by', 'published_by'].forEach(function (k) { if (v[k]) o[k] = v[k]; });
      if (v.published_at) o.published_at = iso(v.published_at);
      if (v.blast_radius) o.blast_radius = v.blast_radius;
      return o;
    }
    function segmentView(s, include) {
      var cl = cur();
      var act = s.active_version != null ? s.versions[s.active_version - 1] : null;
      var o = {
        segment_id: s.id, name: s.name, advertiser_id: s.advertiser_id, active_version: s.active_version, paused: !!s.paused,
        active: act ? { version: act.version, rule: act.rule, deal_ids: act.deal_ids || [], fingerprint: act.fingerprint, effective_fingerprint: cl.segments[s.id] ? cl.segments[s.id].fingerprint : null } : null,
        versions: s.versions.map(versionView),
        history: S.audit.filter(function (a) { return a.segment_id === s.id; }).slice(-40)
      };
      if (include === 'sync') { var rows = syncFor(s.id); o.sync = { catalog_rev: cl.rev, consumers: rows, summary: syncSummary(rows, s.id) }; }
      return o;
    }

    // ---- idempotency wrapper
    function idem(t, method, path, headers, body, fn) {
      var key = headers['idempotency-key'];
      if (!key) return fn();
      var k = t.actor + '|' + method + '|' + path + '|' + key, b = hash(canon(body || null));
      var hit = S.idem[k];
      if (hit) {
        if (hit.b !== b) fail(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request body');
        return { status: hit.res.status, body: hit.res.body, headers: Object.assign({}, hit.res.headers || {}, { 'idempotent-replay': 'true' }) };
      }
      var res = fn();
      if (res.status < 500) { if (Object.keys(S.idem).length > 2000) S.idem = {}; S.idem[k] = { b: b, res: clone(res) }; }
      return res;
    }

    // ---- endpoint handlers
    function readDeals(body) {
      if (body.deal_ids === undefined) return [];
      if (!Array.isArray(body.deal_ids) || body.deal_ids.length > 20) fail(400, 'invalid_body', 'deal_ids must be an array of at most 20 Deal IDs');
      body.deal_ids.forEach(function (d) { if (typeof d !== 'string' || !DEAL_RE.test(d)) fail(400, 'invalid_body', "Invalid Deal ID '" + d + "'", { path: 'deal_ids' }); });
      return Array.from(new Set(body.deal_ids)).sort();
    }
    function createSegment(t, headers, body) {
      needRole(t, ['writer', 'admin']);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send a JSON object');
      if (typeof body.advertiser_id !== 'string') fail(400, 'invalid_body', 'advertiser_id is required');
      if (!tenantOk(t, body.advertiser_id)) fail(403, 'forbidden_advertiser', 'Your token cannot write for ' + body.advertiser_id);
      var name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : null;
      if (!name) fail(400, 'invalid_body', 'name is required');
      var id = typeof body.segment_id === 'string' ? body.segment_id : 'seg_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
      if (!/^seg_[a-z0-9_]{1,60}$/.test(id)) fail(400, 'invalid_body', "segment_id must look like seg_my_segment");
      if (Object.keys(S.segments).length >= 300) fail(429, 'quota_exceeded', 'Prototype limit: 300 segments. Use Reset demo');
      if (S.segments[id]) fail(409, 'segment_exists', 'Segment ' + id + ' already exists. Add a version instead');
      var deals = readDeals(body);
      var rule = clone(body.rule);
      var v = validateRule(rule, listInfo);
      if (!v.ok) failRule(v);
      var nr = normalizeRule(rule);
      S.segments[id] = { id: id, name: name, advertiser_id: body.advertiser_id, versions: [], active_version: null, paused: false };
      var ver = addVersion(S.segments[id], nr, deals, t);
      audit(t.actor, t.role, 'create_segment', id, 1);
      return { status: 201, body: { segment_id: id, version: 1, status: 'draft', fingerprint: ver.fingerprint, deal_ids: deals, validation: { valid: true, warnings: v.warnings } } };
    }
    function failRule(v) {
      var e = v.errors[0];
      var status = e.error === 'rule_too_large' ? 413 : 400;
      throw { http: { status: status, body: { error: e.error, message: e.message, rule_index: 0, path: e.path, details: v.errors } } };
    }
    function addVersion(seg, nr, deals, t) {
      if (seg.versions.length >= 50) fail(429, 'quota_exceeded', 'Prototype limit: 50 versions per segment');
      var ver = { version: seg.versions.length + 1, rule: nr, deal_ids: deals, fingerprint: hash(canon(nr) + (deals.length ? '|deals:' + deals.join(',') : '')), status: 'draft', created_by: t.actor, created_at: now() };
      seg.versions.push(ver); return ver;
    }
    function createVersion(t, id, body) {
      needRole(t, ['writer', 'admin']);
      var seg = getSegment(t, id);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send a JSON object with a rule');
      // A new version keeps the current deal bindings unless deal_ids is sent.
      var cur0 = seg.versions[(seg.active_version || seg.versions.length) - 1];
      var deals = body.deal_ids === undefined ? (cur0.deal_ids || []).slice() : readDeals(body);
      var rule = clone(body.rule), v = validateRule(rule, listInfo);
      if (!v.ok) failRule(v);
      var ver = addVersion(seg, normalizeRule(rule), deals, t);
      audit(t.actor, t.role, 'create_version', id, ver.version);
      return { status: 201, body: { segment_id: id, version: ver.version, status: 'draft', fingerprint: ver.fingerprint, deal_ids: deals, validation: { valid: true, warnings: v.warnings } } };
    }
    function radiusFor(seg, ver) {
      if (seg.active_version == null) return { vs_active: null, new_version_change: 'new_segment', publish_risk: 'none', old_copy_would_be: 'not_applicable', stale_copy_risk: 'none', dimensions: [], plain_language: 'First live version of this segment. No earlier version to compare with.' };
      var act = seg.versions[seg.active_version - 1], lists = currentLists(null);
      var l = Object.assign({}, lists);
      listRefs(act.rule).concat(listRefs(ver.rule)).forEach(function (ref) { var p = parseListRef(ref); if (p && p.pin) { var lv = S.lists[p.name] && S.lists[p.name].versions[p.pin - 1]; if (lv) l[ref] = { version: lv.version, domains: lv.domains.slice() }; } });
      var br = blastRadius(compareRules(act.rule, ver.rule, l, l, act.deal_ids, ver.deal_ids), act.version);
      br.estimated_reach = estimateReach(act.rule, ver.rule, l);
      br.plain_language += ' ' + reachSentence(br.estimated_reach);
      return br;
    }
    // One principle decides who may act alone: anything that can only stop or narrow delivery can be done by one person with a reason.
    // Anything that can widen reach, or bring in content nobody reviewed, needs a second person.
    function transition(t, id, headers, body) {
      var seg = getSegment(t, id);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send {action, version, reason}');
      var action = body.action;
      var acts = ['submit', 'approve', 'publish', 'rollback', 'pause', 'resume'];
      if (acts.indexOf(action) < 0) fail(400, 'invalid_action', 'action must be one of ' + acts.join(', '));
      needRole(t, ['submit', 'rollback', 'pause'].indexOf(action) > -1 ? ['writer', 'approver', 'admin'] : ['approver', 'admin']);
      var reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (['publish', 'rollback', 'pause', 'resume'].indexOf(action) > -1 && reason.length < 3) fail(400, 'reason_required', 'A reason of at least 3 characters is required for ' + action);
      var ver = null;
      if (action !== 'pause' && action !== 'resume') {
        if (!Number.isInteger(body.version)) fail(400, 'invalid_body', 'version (integer) is required');
        ver = seg.versions[body.version - 1];
        if (!ver) fail(404, 'version_not_found', 'Segment ' + id + ' has no version ' + body.version);
      }
      function need(state) { if (ver.status !== state) fail(409, 'invalid_state', 'Version ' + ver.version + ' is ' + ver.status + ", not '" + state + "'. " + action + ' needs ' + state); }
      if (action === 'submit') {
        need('draft'); ver.status = 'submitted'; ver.submitted_by = t.actor;
        ver.blast_radius = radiusFor(seg, ver);
        audit(t.actor, t.role, 'submit', id, ver.version, reason || null);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'submitted', blast_radius: ver.blast_radius, next: 'approve, by someone other than ' + ver.created_by } };
      }
      if (action === 'approve') {
        need('submitted');
        if (t.actor === ver.created_by) fail(403, 'four_eyes_violation', 'The creator of a version cannot approve it');
        ver.status = 'approved'; ver.approved_by = t.actor;
        audit(t.actor, t.role, 'approve', id, ver.version, reason || null);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'approved', approved_by: t.actor, next: 'publish' } };
      }
      if (action === 'publish') {
        need('approved');
        if (t.actor === ver.created_by) fail(403, 'four_eyes_violation', 'The creator of a version cannot publish it');
        var br = ver.blast_radius || radiusFor(seg, ver);
        if (seg.active_version != null) seg.versions[seg.active_version - 1].status = 'superseded';
        ver.status = 'active'; ver.published_by = t.actor; ver.published_at = now(); seg.active_version = ver.version; seg.paused = false;
        audit(t.actor, t.role, 'publish', id, ver.version, reason);
        var e = bumpCatalog('publish ' + id + ' v' + ver.version, t.actor);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'active', catalog_rev: e.rev, effective_fingerprint: e.segments[id].fingerprint, blast_radius: br, next: 'servers read the head, pull the snapshot and ack catalog_rev ' + e.rev } };
      }
      if (action === 'rollback') {
        if (ver.status !== 'superseded') fail(409, 'invalid_state', 'Only a version that was live before can be rolled back to. Version ' + ver.version + ' is ' + ver.status);
        var prev = seg.active_version, br2 = prev != null ? radiusFor(seg, ver) : null;
        if (prev != null) {
          // An emergency rollback must not undo a privacy tightening or quietly widen reach.
          var pv = seg.versions[prev - 1];
          var rb = compareRules(pv.rule, ver.rule, currentLists(pv.rule), currentLists(ver.rule), pv.deal_ids, ver.deal_ids);
          if (rb.dimensions.some(function (d) { return d.dimension === 'audience_gate' && d.change === 'wider'; }))
            fail(403, 'rollback_loosens_consent', 'Version ' + ver.version + ' allows delivery with less audience data than the active version. Publish it as a new version so a second person approves it.');
          if (['expands_reach', 'mixed_change', 'unclassified'].indexOf(rb.kind) > -1 && t.role === 'writer')
            fail(403, 'rollback_widens', 'Version ' + ver.version + ' is wider than the active version. A rollback that widens reach needs an approver.');
        }
        if (prev != null) seg.versions[prev - 1].status = 'superseded';
        ver.status = 'active'; ver.published_by = t.actor; ver.published_at = now(); seg.active_version = ver.version;
        audit(t.actor, t.role, 'rollback', id, ver.version, reason);
        var e2 = bumpCatalog('rollback ' + id + ' to v' + ver.version, t.actor);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'active', rolled_back_from: prev, catalog_rev: e2.rev, blast_radius: br2 } };
      }
      if (seg.active_version == null) fail(409, 'invalid_state', 'Segment has no active version');
      if (action === 'resume') {
        if (!seg.paused) fail(409, 'invalid_state', 'Segment ' + id + ' is not stopped');
        seg.paused = false; audit(t.actor, t.role, 'resume', id, seg.active_version, reason);
        var e3 = bumpCatalog('resume ' + id, t.actor);
        return { status: 200, body: { segment_id: id, status: 'resumed', catalog_rev: e3.rev, note: 'Resuming restores reach, so it needs an approver.' } };
      }
      // pause: stop the segment on every server. One person may do it, because it can only reduce delivery.
      if (seg.paused) fail(409, 'invalid_state', 'Segment ' + id + ' is already stopped');
      seg.paused = true; audit(t.actor, t.role, 'pause', id, seg.active_version, reason);
      var e4 = bumpCatalog('stop ' + id + ' everywhere', t.actor);
      var waiting = Object.keys(S.consumers).sort().filter(function (k) {
        var c = S.consumers[k]; if (c.active_rev == null) return false;
        var last = c.head_seen[c.head_seen.length - 1]; return !last || last[0] < e4.rev;
      });
      return { status: 200, body: { segment_id: id, status: 'stopped_everywhere', catalog_rev: e4.rev,
        how: 'The segment is now on the revoked list in the head. Every server stops it on its next head read, within ' + HEARTBEAT_SECONDS + ' seconds, even a server whose reload is failing.',
        not_yet_confirmed: waiting, next: 'resume needs an approver, because it restores reach' } };
    }

    // ---- exclusion lists: adding a site narrows reach, so one person may publish it. Removing a site widens reach, so it needs an approver.
    function getList(t, name) {
      var l = S.lists[name];
      if (!l || !tenantOk(t, l.advertiser_id)) fail(404, 'list_not_found', 'No list ' + name);
      return l;
    }
    function listView(l) {
      var v = l.versions[l.versions.length - 1];
      return { name: l.name, advertiser_id: l.advertiser_id, version: v.version, domains: v.domains,
        used_by: Object.keys(S.segments).sort().filter(function (id) { var s = S.segments[id]; return s.active_version != null && listRefs(s.versions[s.active_version - 1].rule).some(function (r) { return parseListRef(r).name === l.name; }); }),
        versions: l.versions.map(function (x) { return { version: x.version, created_by: x.created_by || 'seed', approved_by: x.approved_by || null, created_at: iso(x.created_at), added: x.added || [], removed: x.removed || [], reason: x.reason || null }; }),
        pending: l.pending || null };
    }
    function normDomains(arr, field) {
      if (arr === undefined) return [];
      if (!Array.isArray(arr) || arr.length > 200) fail(400, 'invalid_body', field + ' must be an array of at most 200 domains');
      return Array.from(new Set(arr.map(function (d) {
        var x = typeof d === 'string' ? d.toLowerCase().trim() : '';
        if (!FIELDS['site.domain'].pattern.test(x)) fail(400, 'invalid_body', "Invalid domain '" + d + "' in " + field, { path: field });
        return x;
      }))).sort();
    }
    function publishList(l, add, remove, actor, reason, approver) {
      var last = l.versions[l.versions.length - 1], set = new Set(last.domains);
      add.forEach(function (d) { set.add(d); }); remove.forEach(function (d) { set.delete(d); });
      var nv = { version: last.version + 1, domains: Array.from(set).sort(), created_at: now(), created_by: actor, approved_by: approver || null, added: add, removed: remove, reason: reason };
      l.versions.push(nv); l.pending = null;
      audit(actor, approver ? 'approver' : 'writer', 'list_publish', null, null, l.name + ' v' + nv.version + (add.length ? ' adds ' + add.join(', ') : '') + (remove.length ? ' removes ' + remove.join(', ') : '') + (approver ? ', approved by ' + approver : ''));
      var e = bumpCatalog('list ' + l.name + ' v' + nv.version + (add.length ? ' adds ' + add.join(', ') : '') + (remove.length ? ' removes ' + remove.join(', ') : ''), actor);
      var prevCat = S.catalog[e.rev - 1];
      var affected = Object.keys(e.segments).filter(function (id) { return prevCat.segments[id] && prevCat.segments[id].fingerprint !== e.segments[id].fingerprint; })
        .map(function (id) { return { segment_id: id, new_effective_fingerprint: e.segments[id].fingerprint, previous: prevCat.segments[id].fingerprint }; });
      return { list: l.name, version: nv.version, status: 'active', catalog_rev: e.rev, affected_segments: affected };
    }
    function createListVersion(t, name, body) {
      needRole(t, ['writer', 'admin']);
      var l = getList(t, name);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send {add, remove, reason}');
      var add = normDomains(body.add, 'add'), remove = normDomains(body.remove, 'remove');
      var reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 3) fail(400, 'reason_required', 'A reason of at least 3 characters is required');
      var last = l.versions[l.versions.length - 1];
      add = add.filter(function (d) { return last.domains.indexOf(d) < 0; });
      remove.forEach(function (d) { if (last.domains.indexOf(d) < 0) fail(400, 'not_listed', d + ' is not on ' + name, { path: 'remove' }); });
      if (!add.length && !remove.length) fail(409, 'no_change', 'Every site in add is already on ' + name);
      if (!remove.length) {
        var r = publishList(l, add, [], t.actor, reason, null);
        r.review = 'Adding sites only narrows reach, so one person may publish it with a reason. Removing a site needs an approver.';
        return { status: 201, body: r };
      }
      if (l.pending) fail(409, 'pending_exists', 'A change to ' + name + ' is already waiting for approval');
      l.pending = { add: add, remove: remove, created_by: t.actor, created_at: iso(now()), reason: reason };
      audit(t.actor, t.role, 'list_submit', null, null, name + ' removes ' + remove.join(', '));
      return { status: 202, body: { list: name, status: 'waiting_for_approval', pending: l.pending, next: 'approve, by someone other than ' + t.actor, why: 'Removing a site from an exclusion list widens reach, so a second person must approve it.' } };
    }
    function listTransition(t, name, body) {
      needRole(t, ['approver', 'admin']);
      var l = getList(t, name);
      if (!isObj(body) || ['approve', 'reject'].indexOf(body.action) < 0) fail(400, 'invalid_action', "action must be 'approve' or 'reject'");
      if (!l.pending) fail(409, 'invalid_state', 'Nothing is waiting for approval on ' + name);
      if (l.pending.created_by === t.actor) fail(403, 'four_eyes_violation', 'The person who proposed a change cannot approve it');
      if (body.action === 'reject') { audit(t.actor, t.role, 'list_reject', null, null, name); l.pending = null; return { status: 200, body: { list: name, status: 'rejected' } }; }
      var p = l.pending;
      return { status: 200, body: publishList(l, p.add, p.remove, p.created_by, p.reason, t.actor) };
    }

    function snapshotBody(rev, since) {
      var e = S.catalog[rev], base = since != null ? S.catalog[since] : null;
      var segs = [], removed = [], lists = [];
      Object.keys(e.segments).sort().forEach(function (id) {
        var b = base && base.segments[id];
        if (!b || b.fingerprint !== e.segments[id].fingerprint || b.paused !== e.segments[id].paused) segs.push(e.segments[id]);
      });
      if (base) Object.keys(base.segments).forEach(function (id) { if (!e.segments[id]) removed.push(id); });
      Object.keys(e.lists).sort().forEach(function (n) {
        var b = base && base.lists[n];
        if (!b || b.version !== e.lists[n].version) lists.push({ name: n, version: e.lists[n].version, domains: e.lists[n].domains });
      });
      var o = { catalog_rev: rev, since_rev: since == null ? null : since, full: since == null, hash: e.hash, created_at: iso(e.created_at), reason: e.reason,
        segments: segs, removed_segments: removed, lists: lists, expiry_defaults: { standard_seconds: EXPIRY.standard, strict_seconds: EXPIRY.strict },
        head: { path: '/v1/catalog/head', note: 'Stops, revocations and deadlines travel in the head, not here, so they reach a server even when applying this snapshot fails' } };
      o.body_digest = hash(canon([o.segments, o.removed_segments, o.lists]));
      o.signed_at = iso(now());
      o.signature = sign(canon([o.catalog_rev, o.since_rev, o.hash, o.body_digest]));
      return o;
    }
    function verifySnapshot(snap) {
      if (!snap || !snap.signature) return { ok: false, reason: 'unsigned snapshot' };
      var digest = hash(canon([snap.segments, snap.removed_segments, snap.lists]));
      if (digest !== snap.body_digest) return { ok: false, reason: 'body does not match digest (tampered)' };
      if (sign(canon([snap.catalog_rev, snap.since_rev, snap.hash, snap.body_digest])) !== snap.signature) return { ok: false, reason: 'bad signature' };
      return { ok: true };
    }
    function verifyHead(h) {
      if (!h || !h.signature) return { ok: false, reason: 'unsigned head' };
      return sign(canon([h.catalog_rev, h.hash, h.revoked, hash(canon(h.segments))])) === h.signature ? { ok: true } : { ok: false, reason: 'bad signature' };
    }
    function getSnapshot(t, query, headers) {
      needRole(t, ['consumer', 'admin']);
      var c = cur(), since = query.since_rev === undefined || query.since_rev === '' ? null : Number(query.since_rev);
      if (since !== null && (!Number.isInteger(since) || since < 0)) fail(400, 'invalid_since_rev', 'since_rev must be a non-negative integer');
      if (since !== null && since > c.rev) fail(400, 'since_rev_in_future', 'since_rev ' + since + ' is newer than the catalog (' + c.rev + ')');
      var etag = '"rev' + c.rev + '-' + c.hash + '"';
      if (headers['if-none-match'] === etag || since === c.rev) return { status: 304, body: null, headers: { etag: etag } };
      if (since === null || c.rev - since > maxDeltaRevs) {
        var exp = now() + 300000, sig = sign('obj|' + c.rev + '|' + exp);
        // 200 with a manifest, not a 302: the consumer fetches the signed URL without its bearer token, so the token cannot leak to the object store.
        return { status: 200, body: { mode: 'object_url', reason: since === null ? 'cold start' : 'since_rev too old to diff', catalog_rev: c.rev, url: '/v1/catalog/objects/rev-' + c.rev + '.json?exp=' + exp + '&sig=' + sig, expires_at: iso(exp), body_digest: snapshotBody(c.rev, null).body_digest },
          headers: { etag: etag } };
      }
      return { status: 200, body: snapshotBody(c.rev, since), headers: { etag: etag } };
    }
    function getObject(path, query) {
      if (path === '/v1/catalog/objects/head.json') {
        var h = headDoc(cur().rev);
        return { status: 200, body: h, headers: { 'cache-control': 'max-age=10', etag: '"head' + h.catalog_rev + '-' + h.hash + '"' } };
      }
      var m = /^\/v1\/catalog\/objects\/rev-(\d+)\.json$/.exec(path), rev = m ? Number(m[1]) : -1;
      if (!S.catalog[rev]) fail(404, 'not_found', 'No such catalog object');
      if (!query.sig || sign('obj|' + rev + '|' + query.exp) !== query.sig) fail(403, 'bad_signature', 'Signed URL is invalid');
      if (Number(query.exp) < now()) fail(403, 'link_expired', 'Signed URL has expired');
      return { status: 200, body: snapshotBody(rev, null), headers: { 'cache-control': 'public, max-age=31536000, immutable', etag: '"rev' + rev + '-' + S.catalog[rev].hash + '"' } };
    }

    function runMatch(t, query, body) {
      needRole(t, ['writer', 'approver', 'reader', 'admin']);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send an OpenRTB-style bid request as JSON');
      var r = normaliseRequest(body), c = cur(), against;
      function visible(map) {
        var o = {}; Object.keys(map).forEach(function (id) { if (tenantOk(t, map[id].advertiser_id)) o[id] = map[id]; }); return o;
      }
      function evalAt(rev) { var e = S.catalog[rev]; return matchAgainst(visible(e.segments), e.lists, r); }
      var result;
      if (query.segment_id) {
        var seg = getSegment(t, query.segment_id), vn = query.version ? Number(query.version) : seg.active_version;
        var ver = seg.versions[vn - 1];
        if (!ver) fail(404, 'version_not_found', 'No version ' + query.version);
        var l = currentLists(ver.rule);
        var res = evalRule(ver.rule, r, l);
        against = { type: 'segment_version', segment_id: seg.id, version: vn, status: ver.status };
        result = res.eligible ? { matches: [Object.assign({ segment_id: seg.id, version: vn, tier: res.tier, reason: res.reason }, ver.deal_ids && ver.deal_ids.length ? { deal_ids: ver.deal_ids } : {})], excluded: [] } : { matches: [], excluded: [{ segment_id: seg.id, reason: res.reason }] };
      } else if (query.catalog_rev !== undefined) {
        var rev = Number(query.catalog_rev);
        if (!Number.isInteger(rev) || !S.catalog[rev]) fail(404, 'catalog_rev_not_found', 'No catalog revision ' + query.catalog_rev);
        against = { type: 'catalog_rev', catalog_rev: rev };
        result = evalAt(rev);
      } else { against = { type: 'catalog_rev', catalog_rev: c.rev, note: 'active catalog' }; result = evalAt(c.rev); }
      var out = {
        request_id: r.request_id, evaluated_against: against,
        normalised: { region: r.region, country: r.country, device: r.device_type, os: r.os, domain: r.domain, categories: r.cats, 'consent.valid': r.consent.valid, 'audience.signals': r.audience.size },
        matches: result.matches, excluded: result.excluded,
        meaning: 'A match means the request is eligible for the segment and its deals. Whether an ad is then bid on, wins and serves is decided later, by the buyer and the auction.'
      };
      if (r.warnings.length) out.warnings = r.warnings;
      if (query.compare === 'active' && against.type === 'catalog_rev' && against.catalog_rev !== c.rev) {
        var act = evalAt(c.rev);
        var ids = {};
        result.matches.concat(act.matches).forEach(function (m) { ids[m.segment_id] = 1; });
        var diffs = Object.keys(ids).sort().map(function (id) {
          var h = result.matches.filter(function (m) { return m.segment_id === id; })[0], a = act.matches.filter(function (m) { return m.segment_id === id; })[0];
          var hv = h ? 'eligible, tier ' + h.tier : 'not eligible', av = a ? 'eligible, tier ' + a.tier : 'not eligible';
          return { segment_id: id, held: hv, active: av, diverges: (h ? h.tier : 'x') !== (a ? a.tier : 'x') || !!h !== !!a };
        }).filter(function (d) { return d.diverges; });
        out.compare = { held_rev: against.catalog_rev, active_rev: c.rev, diverges: diffs.length > 0, differences: diffs, active: { matches: act.matches, excluded: act.excluded } };
      }
      // no PII persisted: request id, outcome and versions only
      S.matchLog.push({ ts: iso(now()), request_id: r.request_id, against: against.type === 'catalog_rev' ? 'rev ' + against.catalog_rev : 'seg ' + against.segment_id + ' v' + against.version, matched: result.matches.map(function (m) { return m.segment_id + '@v' + m.version + ' tier ' + m.tier; }), excluded_count: result.excluded.length });
      if (S.matchLog.length > 200) S.matchLog.shift();
      return { status: 200, body: out };
    }

    function postAck(t, cid, body) {
      needRole(t, ['consumer']);
      if (t.consumer_id !== cid || !S.consumers[cid]) fail(403, 'ack_identity_mismatch', 'Your token identifies ' + t.consumer_id + ', so you cannot ack for ' + cid);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send {catalog_rev, hash, state}');
      var states = ['received', 'accepted', 'active'];
      if (states.indexOf(body.state) < 0) fail(400, 'invalid_state', 'state must be received, accepted or active');
      var rev = body.catalog_rev;
      if (!Number.isInteger(rev) || rev < 0 || rev > cur().rev) fail(400, 'invalid_catalog_rev', 'catalog_rev must be between 0 and ' + cur().rev);
      var c = S.consumers[cid], e = S.catalog[rev];
      if (body.hash !== e.hash) {
        c.exceptions = [{ at: iso(now()), error: 'hash_mismatch', catalog_rev: rev }];
        fail(409, 'hash_mismatch', 'Hash does not match catalog revision ' + rev + '. Treat the copy as corrupt and re-pull', { expected_hash: e.hash });
      }
      var before = [c.active_rev, c.received_rev, JSON.stringify(c.locally_stopped)].join('|');
      // Moving to a newer active copy closes the exposure the old copy built up, so the running total keeps it.
      if (body.state === 'active' && c.active_rev != null && rev !== c.active_rev) {
        Object.keys(cur().segments).forEach(function (sid) {
          var r0 = syncFor(sid).filter(function (x) { return x.consumer_id === cid; })[0];
          if (r0 && r0.exposure_traffic_minutes) S.exposureClosed[sid] = round1((S.exposureClosed[sid] || 0) + r0.exposure_traffic_minutes);
        });
      }
      c.last_ack_at = now(); c.unreachable = false;
      c.received_rev = Math.max(rev, c.received_rev == null ? -1 : c.received_rev);
      if (body.state === 'accepted' || body.state === 'active') c.accepted_rev = rev;
      if (body.state === 'active') c.active_rev = rev;
      c.exceptions = Array.isArray(body.exceptions) ? body.exceptions.slice(0, 20) : [];
      var headRev = Number.isInteger(body.head_rev) ? Math.min(body.head_rev, cur().rev) : rev;
      var seenRev = Math.max(headRev, c.received_rev), lastSeen = c.head_seen[c.head_seen.length - 1];
      if (!lastSeen || lastSeen[0] < seenRev) { c.head_seen.push([seenRev, now()]); if (c.head_seen.length > 200) c.head_seen.shift(); }
      var hr = typeof body.head_read_at === 'string' ? Date.parse(body.head_read_at) : NaN;
      c.reported_head_read_at = Number.isFinite(hr) ? Math.min(hr, now()) : now();
      c.locally_stopped = (Array.isArray(body.locally_stopped) ? body.locally_stopped : []).slice(0, 100).map(function (x) {
        return typeof x === 'string' ? { segment_id: x, reason: 'reported', since: iso(now()) } : { segment_id: String(x.segment_id), reason: String(x.reason || 'reported'), since: typeof x.since === 'string' ? x.since : iso(now()) };
      });
      var after = [c.active_rev, c.received_rev, JSON.stringify(c.locally_stopped)].join('|');
      if (before !== after) audit(cid, 'consumer', 'ack', null, null, 'rev ' + rev + ' ' + body.state + (c.exceptions.length ? ' (' + c.exceptions[0].error + ')' : '') + (c.locally_stopped.length ? ', stopped locally: ' + c.locally_stopped.map(function (x) { return x.segment_id; }).join(', ') : ''));
      var detail = [];
      Object.keys(cur().segments).forEach(function (sid) {
        var r = syncFor(sid).filter(function (x) { return x.consumer_id === cid; })[0];
        if (r && r.state !== 'in_sync') detail.push({ segment_id: sid, held_version: r.held_version, held_copy: r.held_copy, risk: r.risk, on_server: r.on_server });
      });
      var inSync = body.state === 'active' && c.active_rev === cur().rev;
      return { status: 200, body: { consumer_id: cid, recorded: { received_rev: c.received_rev, accepted_rev: c.accepted_rev, active_rev: c.active_rev }, current_catalog_rev: cur().rev,
        counts_as_in_sync: inSync, behind_by: cur().rev - (c.active_rev == null ? 0 : c.active_rev), sync_required: !inSync, stale_detail: detail, revoked: headDoc(cur().rev).revoked,
        note: inSync ? null : 'Pull the snapshot and apply it. Until then, follow the head: stop any segment whose deadline passes. The hub does not send stop commands.' } };
    }

    function listSegments(t, query) {
      needRole(t, ['writer', 'approver', 'reader', 'admin']);
      var ids = Object.keys(S.segments).sort().filter(function (id) { return tenantOk(t, S.segments[id].advertiser_id); });
      if (query.advertiser_id) ids = ids.filter(function (id) { return S.segments[id].advertiser_id === query.advertiser_id; });
      if (query.status) ids = ids.filter(function (id) { return S.segments[id].versions.some(function (v) { return v.status === query.status; }); });
      var limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100), start = parseInt(query.cursor || '0', 10) || 0;
      var page = ids.slice(start, start + limit);
      return { status: 200, body: { items: page.map(function (id) { var s = S.segments[id], av = s.active_version ? s.versions[s.active_version - 1] : null; return { segment_id: id, name: s.name, advertiser_id: s.advertiser_id, active_version: s.active_version, deal_ids: av ? av.deal_ids || [] : [], paused: !!s.paused, versions: s.versions.length, latest_status: s.versions[s.versions.length - 1].status }; }),
        next_cursor: start + limit < ids.length ? String(start + limit) : null, total: ids.length } };
    }

    // ---- demo-only endpoints (not part of the product API)
    function hubOutage(minutes) {
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) fail(400, 'invalid_body', 'minutes must be between 1 and 120');
      var integrated = Object.keys(S.consumers).filter(function (k) { var c = S.consumers[k]; return !c.unreachable && c.mode !== 'not_integrated' && c.active_rev != null; });
      var strictHeld = 0;
      integrated.forEach(function (k) { var held = S.catalog[S.consumers[k].active_rev]; Object.keys(held.segments).forEach(function (id) { if (held.segments[id].expiry_class === 'strict' && !held.segments[id].paused) strictHeld++; }); });
      S.hubDown = true;
      try {
        for (var i = 0; i < minutes * 2; i++) { offset += HEARTBEAT_SECONDS * 1000; integrated.forEach(function (k) { edgeSeeHead(S.consumers[k]); }); }
      } finally { S.hubDown = false; }
      beatAll();
      var byLease = 0, other = [];
      integrated.forEach(function (k) { (S.consumers[k].locally_stopped || []).forEach(function (x) { if (x.reason === 'lease_expired') byLease++; else other.push(k + ': ' + x.segment_id + ' (' + x.reason + ')'); }); });
      return { status: 200, body: { minutes: minutes, hub_api: 'down for ' + minutes + ' minutes, nothing could be published', head_reads: 'continued from object storage every ' + HEARTBEAT_SECONDS + ' seconds',
        strict_copies_stopped_by_lease: byLease, strict_copies_that_would_stop_if_the_lease_counted_from_the_hub_api: minutes * 60 > EXPIRY.strict ? strictHeld : 0,
        other_stops_during_the_outage: other,
        meaning: 'A hub outage stops nothing that was correct. A server that already knew it was behind on a strict segment still stops it at its own deadline, because that rule never depended on the hub.' } };
    }
    function demoRoute(method, path, query, body) {
      if (method === 'GET' && path === '/v1/demo/state') {
        return { status: 200, body: { now: iso(now()), catalog_rev: cur().rev, catalog: S.catalog.map(function (e) { return { rev: e.rev, created_at: iso(e.created_at), reason: e.reason, hash: e.hash }; }),
          lists: Object.keys(S.lists).map(function (n) { var l = S.lists[n], v = l.versions; return { name: n, advertiser_id: l.advertiser_id, version: v[v.length - 1].version, domains: v[v.length - 1].domains, pending: l.pending || null }; }),
          segments: Object.keys(S.segments).sort().map(function (id) { var s = S.segments[id]; return { segment_id: id, name: s.name, advertiser_id: s.advertiser_id, active_version: s.active_version, versions: s.versions.length, paused: !!s.paused }; }),
          consumers: Object.keys(S.consumers).map(function (k) { var c = S.consumers[k]; return { id: c.id, name: c.name, cluster: c.cluster, cluster_name: c.cluster_name, traffic_share: c.traffic_share, active_rev: c.active_rev, received_rev: c.received_rev, unreachable: c.unreachable, mode: c.mode }; }),
          tokens: Object.keys(tokens).map(function (k) { return { token: k, actor: tokens[k].actor, role: tokens[k].role, label: tokens[k].label }; }),
          audit: S.audit.slice(-60), match_log: S.matchLog.slice(-20) } };
      }
      if (method === 'POST' && path === '/v1/demo/reset') { hub.reset(); return { status: 200, body: { status: 'reset', catalog_rev: cur().rev } }; }
      if (method === 'POST' && path === '/v1/demo/advance') {
        var sec = Number(body && body.seconds);
        if (!Number.isFinite(sec) || sec <= 0 || sec > 86400) fail(400, 'invalid_body', 'seconds must be between 1 and 86400');
        offset += sec * 1000; if (S.autoEdges) beatAll();
        return { status: 200, body: { now: iso(now()), advanced_seconds: sec } };
      }
      if (method === 'POST' && path === '/v1/demo/hub-outage') return hubOutage(Number(body && body.minutes));
      var m = /^\/v1\/demo\/consumers\/([a-z0-9_]+)\/(sync|unreachable|mode)$/.exec(path);
      if (method === 'POST' && m) {
        var c = S.consumers[m[1]];
        if (!c) fail(404, 'consumer_not_found', 'No consumer ' + m[1]);
        if (m[2] === 'sync') return consumerSync(m[1]);
        if (m[2] === 'mode') {
          if (MODES.indexOf(body && body.mode) < 0) fail(400, 'invalid_body', 'mode must be one of ' + MODES.join(', '));
          c.mode = body.mode; return { status: 200, body: { consumer_id: m[1], mode: c.mode } };
        }
        c.unreachable = !(body && body.value === false);
        return { status: 200, body: { consumer_id: m[1], unreachable: c.unreachable } };
      }
      m = /^\/v1\/demo\/lists\/([a-z0-9_]+)\/domains$/.exec(path);
      if (method === 'POST' && m) {
        var l = S.lists[m[1]]; if (!l) fail(404, 'unknown_list', 'No list ' + m[1]);
        var d = body && typeof body.domain === 'string' ? body.domain.toLowerCase() : '';
        if (!FIELDS['site.domain'].pattern.test(d)) fail(400, 'invalid_body', 'domain looks invalid');
        if (l.versions[l.versions.length - 1].domains.indexOf(d) > -1) fail(409, 'already_listed', d + ' is already on ' + m[1]);
        var r = publishList(l, [d], [], 'list_owner', 'demo: add ' + d, null);
        r.note = 'Adding a site narrows reach, so one person publishes it. No new segment versions were minted. Effective fingerprints changed, so servers on the old revision now hold a wider copy.';
        return { status: 200, body: r };
      }
      fail(404, 'not_found', 'No such demo route');
    }

    // ---- router
    function handle(req) {
      S.depth = (S.depth || 0) + 1;
      try { return route(req); } finally { S.depth--; }
    }
    function route(req) {
      var method = String(req.method || 'GET').toUpperCase();
      var path = String(req.path || '/').replace(/\/+$/, '') || '/';
      var query = req.query || {}, headers = lower(req.headers), body = req.body;
      try {
        if (method === 'GET' && path === '/v1/health') return { status: 200, body: { ok: true, service: 'segment-hub', catalog_rev: cur().rev } };
        if (path.indexOf('/v1/demo/') === 0) return demoRoute(method, path, query, body);
        if (method === 'GET' && (path === '/v1/catalog/objects/head.json' || /^\/v1\/catalog\/objects\/rev-\d+\.json$/.test(path))) return getObject(path, query);
        if (S.hubDown) fail(503, 'hub_unavailable', 'The hub API is down (demo outage). Servers keep reading the head from object storage.');
        if (S.depth === 1) tick();
        var t = authn(headers), m;
        if (method === 'POST' && path === '/v1/segments') return idem(t, method, path, headers, body, function () { return createSegment(t, headers, body); });
        if (method === 'GET' && path === '/v1/segments') return listSegments(t, query);
        if ((m = /^\/v1\/segments\/([a-z0-9_]+)\/versions$/.exec(path)) && method === 'POST') return idem(t, method, path, headers, body, function () { return createVersion(t, m[1], body); });
        if ((m = /^\/v1\/segments\/([a-z0-9_]+)\/transitions$/.exec(path)) && method === 'POST') return idem(t, method, path, headers, body, function () { return transition(t, m[1], headers, body); });
        if ((m = /^\/v1\/segments\/([a-z0-9_]+)$/.exec(path)) && method === 'GET') {
          needRole(t, ['writer', 'approver', 'reader', 'admin']);
          if (query.include && query.include !== 'sync') fail(400, 'invalid_include', "include supports only 'sync'");
          return { status: 200, body: segmentView(getSegment(t, m[1]), query.include) };
        }
        if ((m = /^\/v1\/lists\/([a-z0-9_]+)$/.exec(path)) && method === 'GET') { needRole(t, ['writer', 'approver', 'reader', 'admin']); return { status: 200, body: listView(getList(t, m[1])) }; }
        if ((m = /^\/v1\/lists\/([a-z0-9_]+)\/versions$/.exec(path)) && method === 'POST') return idem(t, method, path, headers, body, function () { return createListVersion(t, m[1], body); });
        if ((m = /^\/v1\/lists\/([a-z0-9_]+)\/transitions$/.exec(path)) && method === 'POST') return idem(t, method, path, headers, body, function () { return listTransition(t, m[1], body); });
        if (method === 'GET' && path === '/v1/catalog/head') return getHead(t);
        if (method === 'GET' && path === '/v1/catalog/snapshot') return getSnapshot(t, query, headers);
        if (method === 'POST' && path === '/v1/match') return runMatch(t, query, body);
        if ((m = /^\/v1\/consumers\/([a-z0-9_]+)\/acks$/.exec(path)) && method === 'POST') return postAck(t, m[1], body);
        fail(404, 'not_found', 'No route for ' + method + ' ' + path);
      } catch (e) {
        if (e && e.http) return e.http;
        return { status: 500, body: { error: 'internal_error', message: String(e && e.message || e) } };
      }
    }

    // ---- seed: the GlowRoot story
    function seed() {
      function T(min) { offset = min * 60000; }
      function call(tok, method, path, body, query) {
        var r = handle({ method: method, path: path, query: query || {}, headers: { authorization: 'Bearer ' + tok }, body: body });
        if (r.status >= 300) throw new Error('seed failed ' + method + ' ' + path + ' ' + r.status + ' ' + JSON.stringify(r.body));
        return r.body;
      }
      function go(id, rule, name, deals) {
        var cr = name ? call('tok_priya_adops', 'POST', '/v1/segments', { segment_id: id, name: name, advertiser_id: 'adv_glowroot', rule: rule, deal_ids: deals }) : call('tok_priya_adops', 'POST', '/v1/segments/' + id + '/versions', { rule: rule });
        call('tok_priya_adops', 'POST', '/v1/segments/' + id + '/transitions', { action: 'submit', version: cr.version });
        call('tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'approve', version: cr.version });
        return call('tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'publish', version: cr.version, reason: 'Seed data for the demo' });
      }
      function sync(ids) { ids.forEach(function (cid) { consumerSync(cid); }); }
      var tier = function (cats) { return [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] }, { tier: 2, all: [{ field: 'site.cat', in: cats }] }]; };
      var festive = function (regions, cats) {
        return { must: [{ field: 'device.geo.region', in: regions }, { field: 'device.type', in: ['mobile', 'tablet'] }, { field: 'site.domain', not_in_list: 'excl_buyer_blocklist' }], should: tier(cats), if_audience_missing: 'fall_back_to_context' };
      };
      var edges = ['edge_mum_1', 'edge_mum_2', 'edge_us_1', 'edge_us_2', 'edge_sg_1', 'edge_sg_2', 'edge_sg_3'];
      T(-360);
      S.lists.excl_buyer_blocklist = { name: 'excl_buyer_blocklist', advertiser_id: 'adv_glowroot', pending: null, versions: [{ version: 1, domains: ['cheap-clicks.example', 'viral-feed.example'], created_at: now(), created_by: 'seed', reason: 'Buyer blocklist at launch' }] };
      go('seg_glowroot_festive_east', festive(['IN-WB'], ['IAB18-1']), 'GlowRoot Festive East India', ['MN-GLOW-FESTIVE-E']);
      T(-359);
      go('seg_glowroot_premium_north', { must: [{ field: 'device.geo.region', in: ['IN-DL', 'IN-HR'] }, { field: 'device.type', in: ['mobile', 'tablet', 'desktop'] }, { field: 'site.domain', not_in_list: 'excl_buyer_blocklist' }],
        should: [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] }, { tier: 2, all: [{ field: 'site.cat', in: ['IAB18-1'] }] }], if_audience_missing: 'fall_back_to_context', strict_compliance: true }, 'GlowRoot Premium North', ['MN-GLOW-PREMIUM-N']);
      T(-300);
      go('seg_glowroot_festive_east', festive(['IN-WB'], ['IAB18-1', 'IAB18-3']));
      T(-290); sync(edges);
      S.consumers.edge_mum_1.mode = 'deferred'; S.consumers.edge_mum_2.mode = 'deferred';
      S.consumers.edge_sg_1.mode = 'failing'; S.consumers.deal_tagger_1.mode = 'not_integrated';
      T(-5);
      var l = S.lists.excl_buyer_blocklist;
      publishList(l, ['glow-deals-feed.example'], [], 'priya', 'Buyer reported glow-deals-feed.example as off-brand', null);
      T(-4.5); sync(['edge_sg_1']);
      T(-4); sync(['edge_mum_1', 'edge_mum_2', 'edge_us_1', 'edge_us_2', 'edge_sg_2', 'edge_sg_3']);
      T(-3);
      go('seg_glowroot_festive_east', festive(['IN-WB', 'IN-OD'], ['IAB18-1', 'IAB18-3']));
      T(-2.5); heartbeat('edge_sg_1'); heartbeat('edge_mum_1'); heartbeat('edge_mum_2');
      T(-2); sync(['edge_us_1', 'edge_us_2', 'edge_sg_2', 'edge_sg_3']);
      T(0);
      S.autoEdges = true; S.lastTick = now();
    }

    var hub = {
      handle: handle,
      verifySnapshot: verifySnapshot,
      verifyHead: verifyHead,
      tokens: tokens,
      now: now,
      advance: function (sec) { offset += sec * 1000; },
      reset: function () { offset = 0; init(); if (opts.seed) seed(); else if (opts.autoEdges) { S.autoEdges = true; S.lastTick = now(); } },
      state: function () { return S; }
    };
    init();
    if (opts.seed) seed(); else if (opts.autoEdges) { S.autoEdges = true; S.lastTick = now(); }
    return hub;
  }

  return {
    createHub: createHub, validateRule: validateRule, normalizeRule: normalizeRule, compareRules: compareRules, blastRadius: blastRadius,
    normaliseRequest: normaliseRequest, evalRule: evalRule, effectiveFingerprint: effectiveFingerprint, classifyStale: classifyStale,
    hash: hash, canon: canon, DEFAULT_TOKENS: DEFAULT_TOKENS, DEFAULT_CONSUMERS: DEFAULT_CONSUMERS, EXPIRY: EXPIRY, HEARTBEAT_SECONDS: HEARTBEAT_SECONDS, PROPAGATION_GRACE_SECONDS: PROPAGATION_GRACE_SECONDS
  };
});
