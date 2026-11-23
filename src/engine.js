/* Segment Hub engine.
 * One module, two homes: runs in Node (server.js) and in the browser (demo page).
 * All seven endpoints, in six groups, are served by hub.handle({method, path, query, headers, body}).
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
  function effectiveFingerprint(rule, lists) {
    var nr = normalizeRule(rule);
    var parts = listRefs(nr).map(function (ref) {
      var l = resolveList(lists, ref);
      return ref + ':' + l.version + ':' + hash(canon((l.domains || []).slice().sort()));
    });
    return hash(canon(nr) + '|' + parts.join(','));
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
  function compareRules(oldRule, newRule, oldLists, newLists) {
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
      stale_copy_behavior: k === 'expands_reach' ? 'narrower_subset' : k === 'narrows_reach' ? 'wider_superset' : k === 'no_change' ? 'same_eligibility' : 'mixed',
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

  // Classify a copy a consumer holds against what is active now.
  function classifyStale(held, active, heldLists, curLists) {
    if (!held) return { kind: 'missing_in_held', risk: 'low', summary: 'Consumer does not hold this segment yet, so it serves nothing for it (under-delivery).' };
    if (held.paused && !active.paused) return { kind: 'narrower_subset', risk: 'low', summary: 'Consumer holds a paused copy; active is live (under-delivery).' };
    if (!held.paused && active.paused) return { kind: 'wider_superset', risk: 'high', summary: 'Active segment is paused but this consumer is still serving it.' };
    var cmp = compareRules(held.rule, active.rule, heldLists, curLists);
    var dims = cmp.dimensions.map(function (d) { return d.dimension + ': ' + d.detail; }).join('; ');
    // The active version asks for audience data more strictly, so this copy delivers with less consent and audience data than it should.
    var crit = cmp.dimensions.some(function (d) { return d.dimension === 'audience_gate' && d.change === 'narrower'; });
    if (cmp.kind === 'expands_reach') return { kind: 'narrower_subset', risk: 'low', summary: 'Stale copy is narrower than active (under-delivery, no leak). What the active version has that this copy lacks: ' + dims, dimensions: cmp.dimensions };
    if (cmp.kind === 'narrows_reach') return { kind: 'wider_superset', risk: 'high', consent_critical: crit, summary: 'Stale copy is wider than active (can serve outside the target). What the active version changed: ' + dims, dimensions: cmp.dimensions };
    if (cmp.kind === 'no_change') return { kind: 'tier_only', risk: 'low', summary: 'Only priority tiers differ.', dimensions: [] };
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
      if (res.eligible) matches.push({ segment_id: id, version: s.version, tier: res.tier, reason: res.reason });
      else excluded.push({ segment_id: id, reason: res.reason });
    });
    return { matches: matches, excluded: excluded };
  }

  // ---------------------------------------------------------------- hub
  var EXPIRY = { standard: 4 * 3600, strict: 15 * 60 };

  var DEFAULT_TOKENS = {
    tok_priya_adops: { actor: 'priya', role: 'writer', advertisers: ['adv_glowroot'], label: 'Priya, AdOps (writer)' },
    tok_rahul_approver: { actor: 'rahul', role: 'approver', advertisers: ['adv_glowroot'], label: 'Rahul, approver' },
    tok_meera_approver: { actor: 'meera', role: 'approver', advertisers: ['adv_glowroot'], label: 'Meera, approver' },
    tok_analytics_reader: { actor: 'analytics', role: 'reader', advertisers: ['adv_glowroot'], label: 'Analytics (reader)' },
    tok_admin: { actor: 'admin', role: 'admin', advertisers: '*', label: 'Admin' },
    tok_other_writer: { actor: 'zed', role: 'writer', advertisers: ['adv_other'], label: 'Zed, other advertiser (writer)' },
    tok_other_approver: { actor: 'olga', role: 'approver', advertisers: ['adv_other'], label: 'Olga, other advertiser (approver)' },
    tok_edge_mum_1: { actor: 'edge_mum_1', role: 'consumer', consumer_id: 'edge_mum_1', label: 'Edge Mumbai 1 (machine)' },
    tok_edge_us_1: { actor: 'edge_us_1', role: 'consumer', consumer_id: 'edge_us_1', label: 'Edge US 1 (machine)' },
    tok_edge_sg_1: { actor: 'edge_sg_1', role: 'consumer', consumer_id: 'edge_sg_1', label: 'Edge Singapore 1 (machine)' },
    tok_deal_tagger_1: { actor: 'deal_tagger_1', role: 'consumer', consumer_id: 'deal_tagger_1', label: 'Deal tagger (machine)' }
  };
  var DEFAULT_CONSUMERS = [
    { id: 'edge_mum_1', name: 'Edge ad servers, Mumbai', traffic_share: 0.22 },
    { id: 'edge_us_1', name: 'Edge ad servers, US', traffic_share: 0.38 },
    { id: 'edge_sg_1', name: 'Edge ad servers, Singapore', traffic_share: 0.30 },
    { id: 'deal_tagger_1', name: 'Curated-deal tagger', traffic_share: 0.10 }
  ];
  var SECRET = 'segment-hub-demo-signing-key';
  function sign(payload) { return 'sig_' + hash(SECRET + payload) + hash(payload + SECRET); }

  function createHub(opts) {
    opts = opts || {};
    var baseNow = opts.now || function () { return Date.now(); };
    var offset = 0;
    var maxDeltaRevs = opts.maxDeltaRevs || 50;
    var tokens = opts.tokens || DEFAULT_TOKENS;
    var S;
    function now() { return baseNow() + offset; }

    function init() {
      S = { seq: 0, audit: [], lists: {}, segments: {}, catalog: [], consumers: {}, pauses: {}, idem: {}, matchLog: [] };
      DEFAULT_CONSUMERS.forEach(function (c) {
        S.consumers[c.id] = { id: c.id, name: c.name, traffic_share: c.traffic_share, received_rev: null, accepted_rev: null, active_rev: null, last_ack_at: null, unreachable: false, exceptions: [] };
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
          segment_id: id, advertiser_id: s.advertiser_id, name: s.name, version: v.version, rule: clone(v.rule), paused: !!s.paused,
          fingerprint: effectiveFingerprint(v.rule, lists),
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
      S.catalog.push(e); return e;
    }
    function cur() { return S.catalog[S.catalog.length - 1]; }

    // ---- per-consumer sync state for one segment
    function expiryOutcome(entry) {
      var rule = entry.rule;
      if (rule.strict_compliance || rule.audience_required) return 'fail_closed';
      var hasAud = (rule.should || []).some(function (t) { return t.all.some(function (c) { return isAudience(c.field); }); });
      return hasAud ? 'degrade_to_context_only' : 'keep_serving_with_alert';
    }
    function syncFor(segId) {
      var c0 = cur(), act = c0.segments[segId];
      if (!act) return [];
      return Object.keys(S.consumers).sort().map(function (cid) {
        var c = S.consumers[cid];
        var row = {
          consumer_id: cid, name: c.name, traffic_share: c.traffic_share, state: 'unknown', held_rev: c.active_rev, held_version: null,
          held_fingerprint: null, active_fingerprint: act.fingerprint, classification: null, risk: null,
          unreachable: c.unreachable, expiry_class: act.expiry_class, expiry_seconds: act.expiry_seconds,
          seconds_until_local_expiry: null, local_expiry_outcome: null, pause: (S.pauses[segId + '|' + cid] || {}).state || 'none',
          recommended_action: 'probe_and_alert', last_ack_at: c.last_ack_at ? iso(c.last_ack_at) : null
        };
        if (c.active_rev == null) { row.note = 'Never acked an active catalog. Cannot judge, so it is unknown.'; return row; }
        var held = S.catalog[c.active_rev], hs = held.segments[segId];
        row.held_version = hs ? hs.version : null; row.held_fingerprint = hs ? hs.fingerprint : null;
        var same = hs && hs.fingerprint === act.fingerprint && hs.paused === act.paused;
        if (same) {
          row.classification = 'same'; row.risk = 'none';
          if (c.unreachable) { row.state = 'unknown'; row.note = 'Holds the active copy as of its last ack, but is not answering probes.'; row.recommended_action = 'probe_and_alert'; }
          else { row.state = 'in_sync'; row.recommended_action = 'none'; }
          return row;
        }
        var cl = classifyStale(hs, act, held.lists, c0.lists);
        row.classification = cl.kind; row.risk = cl.risk; row.summary = cl.summary;
        row.state = c.unreachable ? 'unknown' : 'confirmed_stale';
        // when did this copy become stale?
        var since = null;
        for (var r = c.active_rev + 1; r < S.catalog.length; r++) {
          var e = S.catalog[r].segments[segId];
          if (!hs ? !!e : (!e || e.fingerprint !== hs.fingerprint || e.paused !== hs.paused)) { since = S.catalog[r].created_at; row.stale_since = iso(since); row.stale_since_rev = r; break; }
        }
        if (since != null) {
          row.minutes_behind = Math.max(0, Math.round((now() - since) / 6000) / 10);
          row.seconds_until_local_expiry = Math.round(act.expiry_seconds - (now() - since) / 1000);
          row.local_expiry_outcome = row.seconds_until_local_expiry <= 0 ? expiryOutcome(act) : null;
        }
        row.consent_critical = !!cl.consent_critical;
        if (cl.risk === 'low') row.recommended_action = 'alert_p2_and_refresh';
        else if (row.consent_critical) row.recommended_action = 'kill_switch_now';
        else row.recommended_action = c.unreachable ? 'kill_switch_then_expiry' : (row.pause === 'none' ? 'request_pause' : 'pause_' + row.pause);
        return row;
      });
    }
    function syncSummary(rows) {
      var total = Object.keys(S.consumers).length;
      var acked = Object.keys(S.consumers).filter(function (k) { return S.consumers[k].active_rev != null; }).length;
      var stale = 0, high = 0, unknown = 0, exposure = 0, exposureHigh = 0;
      rows.forEach(function (r) {
        if (r.state === 'confirmed_stale') { stale += r.traffic_share; exposure += r.traffic_share * (r.minutes_behind || 0); if (r.risk === 'high') { high += r.traffic_share; exposureHigh += r.traffic_share * (r.minutes_behind || 0); } }
        if (r.state === 'unknown') unknown += r.traffic_share;
      });
      function p(x) { return Math.round(x * 1000) / 10; }
      return { ack_coverage_pct: p(acked / total), stale_version_impression_share_pct: p(stale), high_risk_stale_share_pct: p(high), unknown_share_pct: p(unknown),
        stale_exposure_traffic_minutes: Math.round(exposure * 10) / 10, high_risk_stale_exposure_traffic_minutes: Math.round(exposureHigh * 10) / 10,
        note: 'Traffic shares are simulated. Unknown consumers are not counted as stale, which is why ack coverage is reported next to the headline. Exposure is traffic share times minutes behind, and needs acknowledgements only, not impression logs.' };
    }

    // ---- views
    function versionView(v) {
      var o = { version: v.version, status: v.status, fingerprint: v.fingerprint, created_by: v.created_by, created_at: iso(v.created_at) };
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
        active: act ? { version: act.version, rule: act.rule, fingerprint: act.fingerprint, effective_fingerprint: cl.segments[s.id] ? cl.segments[s.id].fingerprint : null } : null,
        versions: s.versions.map(versionView),
        history: S.audit.filter(function (a) { return a.segment_id === s.id; }).slice(-40)
      };
      if (include === 'sync') { var rows = syncFor(s.id); o.sync = { catalog_rev: cl.rev, consumers: rows, summary: syncSummary(rows) }; }
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
      var rule = clone(body.rule);
      var v = validateRule(rule, listInfo);
      if (!v.ok) failRule(v);
      var nr = normalizeRule(rule);
      S.segments[id] = { id: id, name: name, advertiser_id: body.advertiser_id, versions: [], active_version: null, paused: false };
      var ver = addVersion(S.segments[id], nr, t);
      audit(t.actor, t.role, 'create_segment', id, 1);
      return { status: 201, body: { segment_id: id, version: 1, status: 'draft', fingerprint: ver.fingerprint, validation: { valid: true, warnings: v.warnings } } };
    }
    function failRule(v) {
      var e = v.errors[0];
      var status = e.error === 'rule_too_large' ? 413 : 400;
      throw { http: { status: status, body: { error: e.error, message: e.message, rule_index: 0, path: e.path, details: v.errors } } };
    }
    function addVersion(seg, nr, t) {
      if (seg.versions.length >= 50) fail(429, 'quota_exceeded', 'Prototype limit: 50 versions per segment');
      var ver = { version: seg.versions.length + 1, rule: nr, fingerprint: hash(canon(nr)), status: 'draft', created_by: t.actor, created_at: now() };
      seg.versions.push(ver); return ver;
    }
    function createVersion(t, id, body) {
      needRole(t, ['writer', 'admin']);
      var seg = getSegment(t, id);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send a JSON object with a rule');
      var rule = clone(body.rule), v = validateRule(rule, listInfo);
      if (!v.ok) failRule(v);
      var ver = addVersion(seg, normalizeRule(rule), t);
      audit(t.actor, t.role, 'create_version', id, ver.version);
      return { status: 201, body: { segment_id: id, version: ver.version, status: 'draft', fingerprint: ver.fingerprint, validation: { valid: true, warnings: v.warnings } } };
    }
    function radiusFor(seg, ver) {
      if (seg.active_version == null) return { vs_active: null, new_version_change: 'new_segment', publish_risk: 'none', stale_copy_behavior: 'not_applicable', stale_copy_risk: 'none', dimensions: [], plain_language: 'First live version of this segment. No earlier version to compare with.' };
      var act = seg.versions[seg.active_version - 1], lists = currentLists(null);
      var l = Object.assign({}, lists);
      listRefs(act.rule).concat(listRefs(ver.rule)).forEach(function (ref) { var p = parseListRef(ref); if (p && p.pin) { var lv = S.lists[p.name] && S.lists[p.name].versions[p.pin - 1]; if (lv) l[ref] = { version: lv.version, domains: lv.domains.slice() }; } });
      var br = blastRadius(compareRules(act.rule, ver.rule, l, l), act.version);
      br.estimated_reach = estimateReach(act.rule, ver.rule, l);
      br.plain_language += ' ' + reachSentence(br.estimated_reach);
      return br;
    }
    function transition(t, id, headers, body) {
      var seg = getSegment(t, id);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send {action, version, reason}');
      var action = body.action;
      var acts = ['submit', 'approve', 'publish', 'rollback', 'pause', 'resume'];
      if (acts.indexOf(action) < 0) fail(400, 'invalid_action', 'action must be one of ' + acts.join(', '));
      // Approve and publish bring in new, unreviewed rule content, so they need an approver (and four-eyes below).
      // Rollback, pause and resume only restore a version that was already live or reduce delivery, so a writer may do them alone. Reason is required and audited.
      needRole(t, ['submit', 'rollback', 'pause', 'resume'].indexOf(action) > -1 ? ['writer', 'approver', 'admin'] : ['approver', 'admin']);
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
        var e = bumpCatalog('publish ' + id + ' v' + ver.version, t.actor);
        audit(t.actor, t.role, 'publish', id, ver.version, reason);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'active', catalog_rev: e.rev, effective_fingerprint: e.segments[id].fingerprint, blast_radius: br, next: 'consumers pull the snapshot and ack catalog_rev ' + e.rev } };
      }
      if (action === 'rollback') {
        if (ver.status !== 'superseded') fail(409, 'invalid_state', 'Only a version that was live before can be rolled back to. Version ' + ver.version + ' is ' + ver.status);
        var prev = seg.active_version, br2 = prev != null ? radiusFor(seg, ver) : null;
        if (prev != null) {
          // An emergency rollback must not undo a privacy tightening or quietly widen reach.
          var rb = compareRules(seg.versions[prev - 1].rule, ver.rule, currentLists(seg.versions[prev - 1].rule), currentLists(ver.rule));
          if (rb.dimensions.some(function (d) { return d.dimension === 'audience_gate' && d.change === 'wider'; }))
            fail(403, 'rollback_loosens_consent', 'Version ' + ver.version + ' allows delivery with less audience data than the active version. Publish it as a new version so a second person approves it.');
          if (['expands_reach', 'mixed_change', 'unclassified'].indexOf(rb.kind) > -1 && t.role === 'writer')
            fail(403, 'rollback_widens', 'Version ' + ver.version + ' is wider than the active version. A rollback that widens reach needs an approver.');
        }
        if (prev != null) seg.versions[prev - 1].status = 'superseded';
        ver.status = 'active'; ver.published_by = t.actor; ver.published_at = now(); seg.active_version = ver.version;
        var e2 = bumpCatalog('rollback ' + id + ' to v' + ver.version, t.actor);
        audit(t.actor, t.role, 'rollback', id, ver.version, reason);
        return { status: 200, body: { segment_id: id, version: ver.version, status: 'active', rolled_back_from: prev, catalog_rev: e2.rev, blast_radius: br2 } };
      }
      if (seg.active_version == null) fail(409, 'invalid_state', 'Segment has no active version');
      if (action === 'resume') {
        seg.paused = false; var e3 = bumpCatalog('resume ' + id, t.actor); audit(t.actor, t.role, 'resume', id, seg.active_version, reason);
        Object.keys(S.pauses).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete S.pauses[k]; });
        return { status: 200, body: { segment_id: id, status: 'resumed', catalog_rev: e3.rev } };
      }
      // pause
      if (body.scope === 'all') {
        seg.paused = true; var e4 = bumpCatalog('pause ' + id, t.actor); audit(t.actor, t.role, 'pause_all', id, seg.active_version, reason);
        return { status: 202, body: { segment_id: id, status: 'pause_requested', scope: 'all', catalog_rev: e4.rev, pending: Object.keys(S.consumers).filter(function (k) { return S.consumers[k].active_rev !== null; }), confirmed_by: [], backstop: "kill switch, then the segment's expiry class" } };
      }
      var rows = syncFor(id), pending = [], skipped = [], probe = [];
      rows.forEach(function (r) {
        if (r.state === 'in_sync') return;
        if (r.held_rev == null) { probe.push({ consumer_id: r.consumer_id, reason: 'never acked, probe and alert' }); return; }
        if (r.risk === 'high') { pending.push(r.consumer_id); S.pauses[id + '|' + r.consumer_id] = { state: 'requested', requested_at: now() }; }
        else skipped.push({ consumer_id: r.consumer_id, reason: r.classification + ': under-delivery only, alert and refresh instead of pausing' });
      });
      audit(t.actor, t.role, 'pause_request', id, seg.active_version, reason + ' | pending=' + pending.join(','));
      if (!pending.length) return { status: 200, body: { segment_id: id, status: 'no_pause_needed', message: 'No consumer holds a wider or weaker stale copy. Narrower copies are never paused.', skipped: skipped, probe: probe } };
      return { status: 202, body: { segment_id: id, status: 'pause_requested', confirmed_by: [], pending: pending, skipped: skipped, probe: probe,
        unreachable: pending.filter(function (k) { return S.consumers[k].unreachable; }), backstop: "kill switch, then the segment's expiry class" } };
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
        kill_switch: { channel: 'out-of-band', note: 'Urgent revocations bypass this snapshot channel' } };
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
      var m = /^\/v1\/catalog\/objects\/rev-(\d+)\.json$/.exec(path), rev = m ? Number(m[1]) : -1;
      if (!S.catalog[rev]) fail(404, 'not_found', 'No such catalog object');
      if (!query.sig || sign('obj|' + rev + '|' + query.exp) !== query.sig) fail(403, 'bad_signature', 'Signed URL is invalid');
      if (Number(query.exp) < now()) fail(403, 'link_expired', 'Signed URL has expired');
      return { status: 200, body: snapshotBody(rev, null), headers: { 'cache-control': 'public, max-age=31536000, immutable', etag: '"rev' + rev + '-' + S.catalog[rev].hash + '"' } };
    }

    function runMatch(t, query, body) {
      needRole(t, ['writer', 'approver', 'reader', 'admin']);
      if (!isObj(body)) fail(400, 'invalid_body', 'Send an OpenRTB-style bid request as JSON');
      var r = normaliseRequest(body), c = cur(), segs, lists, against;
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
        result = res.eligible ? { matches: [{ segment_id: seg.id, version: vn, tier: res.tier, reason: res.reason }], excluded: [] } : { matches: [], excluded: [{ segment_id: seg.id, reason: res.reason }] };
      } else if (query.catalog_rev !== undefined) {
        var rev = Number(query.catalog_rev);
        if (!Number.isInteger(rev) || !S.catalog[rev]) fail(404, 'catalog_rev_not_found', 'No catalog revision ' + query.catalog_rev);
        against = { type: 'catalog_rev', catalog_rev: rev };
        result = evalAt(rev);
      } else { against = { type: 'catalog_rev', catalog_rev: c.rev, note: 'active catalog' }; result = evalAt(c.rev); }
      var out = {
        request_id: r.request_id, evaluated_against: against,
        normalised: { region: r.region, country: r.country, device: r.device_type, os: r.os, domain: r.domain, categories: r.cats, 'consent.valid': r.consent.valid, 'audience.signals': r.audience.size },
        matches: result.matches, excluded: result.excluded
      };
      if (r.warnings.length) out.warnings = r.warnings;
      if (query.compare === 'active' && against.type === 'catalog_rev' && against.catalog_rev !== c.rev) {
        var act = evalAt(c.rev);
        var ids = {};
        result.matches.concat(act.matches).forEach(function (m) { ids[m.segment_id] = 1; });
        var diffs = Object.keys(ids).sort().map(function (id) {
          var h = result.matches.filter(function (m) { return m.segment_id === id; })[0], a = act.matches.filter(function (m) { return m.segment_id === id; })[0];
          var hv = h ? 'match tier ' + h.tier : 'no match', av = a ? 'match tier ' + a.tier : 'no match';
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
      c.last_ack_at = now(); c.unreachable = false;
      c.received_rev = rev;
      if (body.state === 'accepted' || body.state === 'active') c.accepted_rev = rev;
      if (body.state === 'active') c.active_rev = rev;
      c.exceptions = Array.isArray(body.exceptions) ? body.exceptions.slice(0, 20) : [];
      var confirmed = [];
      (Array.isArray(body.confirmed_pauses) ? body.confirmed_pauses : []).forEach(function (sid) {
        var p = S.pauses[sid + '|' + cid]; if (p) { p.state = 'confirmed'; p.confirmed_at = now(); confirmed.push(sid); }
      });
      audit(cid, 'consumer', 'ack', null, null, 'rev ' + rev + ' ' + body.state);
      var stale = [], detail = [];
      Object.keys(cur().segments).forEach(function (sid) {
        var r = syncFor(sid).filter(function (x) { return x.consumer_id === cid; })[0];
        if (r && r.state !== 'in_sync') { stale.push(sid); detail.push({ segment_id: sid, held_version: r.held_version, classification: r.classification, risk: r.risk, recommended_action: r.recommended_action }); }
      });
      return { status: 200, body: { consumer_id: cid, recorded: { received_rev: c.received_rev, accepted_rev: c.accepted_rev, active_rev: c.active_rev }, current_catalog_rev: cur().rev,
        counts_as_in_sync: body.state === 'active' && c.active_rev === cur().rev, behind_by: cur().rev - (c.active_rev == null ? 0 : c.active_rev), stale_segments: stale, stale_detail: detail, confirmed_pauses: confirmed,
        note: body.state === 'active' ? null : 'Only an active ack counts as in sync. ' + body.state + ' does not prove the copy drives serving decisions.' } };
    }

    function listSegments(t, query) {
      needRole(t, ['writer', 'approver', 'reader', 'admin']);
      var ids = Object.keys(S.segments).sort().filter(function (id) { return tenantOk(t, S.segments[id].advertiser_id); });
      if (query.advertiser_id) ids = ids.filter(function (id) { return S.segments[id].advertiser_id === query.advertiser_id; });
      if (query.status) ids = ids.filter(function (id) { return S.segments[id].versions.some(function (v) { return v.status === query.status; }); });
      var limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100), start = parseInt(query.cursor || '0', 10) || 0;
      var page = ids.slice(start, start + limit);
      return { status: 200, body: { items: page.map(function (id) { var s = S.segments[id]; return { segment_id: id, name: s.name, advertiser_id: s.advertiser_id, active_version: s.active_version, paused: !!s.paused, versions: s.versions.length, latest_status: s.versions[s.versions.length - 1].status }; }),
        next_cursor: start + limit < ids.length ? String(start + limit) : null, total: ids.length } };
    }

    // ---- demo-only endpoints (not part of the six families)
    function consumerSync(cid) {
      var c = S.consumers[cid]; if (!c) fail(404, 'consumer_not_found', 'No consumer ' + cid);
      var tok = Object.keys(tokens).filter(function (k) { return tokens[k].consumer_id === cid; })[0];
      var steps = [];
      if (c.unreachable) fail(503, 'consumer_unreachable', cid + ' is not reachable, so it cannot pull or ack');
      var q = c.active_rev == null ? {} : { since_rev: String(c.active_rev) };
      var r1 = handle({ method: 'GET', path: '/v1/catalog/snapshot', query: q, headers: { authorization: 'Bearer ' + tok } });
      steps.push({ call: 'GET /v1/catalog/snapshot' + (q.since_rev ? '?since_rev=' + q.since_rev : ''), status: r1.status });
      if (r1.status === 200 && r1.body && r1.body.mode === 'object_url') {
        var loc = r1.body.url, parts = loc.split('?'), qq = {};
        parts[1].split('&').forEach(function (kv) { var p = kv.split('='); qq[p[0]] = p[1]; });
        r1 = handle({ method: 'GET', path: parts[0], query: qq, headers: {} });
        steps.push({ call: 'GET ' + parts[0] + ' (signed object-store copy)', status: r1.status });
      }
      if (r1.status === 304) return { status: 200, body: { consumer_id: cid, result: 'already current', steps: steps } };
      var v = verifySnapshot(r1.body);
      steps.push({ call: 'verify signature and digest', status: v.ok ? 'ok' : v.reason });
      if (!v.ok) fail(422, 'snapshot_rejected', 'Consumer rejected the snapshot: ' + v.reason, { steps: steps });
      var pend = Object.keys(S.pauses).filter(function (k) { return k.slice(-(cid.length + 1)) === '|' + cid && S.pauses[k].state === 'requested'; }).map(function (k) { return k.split('|')[0]; });
      var r2 = handle({ method: 'POST', path: '/v1/consumers/' + cid + '/acks', headers: { authorization: 'Bearer ' + tok }, body: { catalog_rev: r1.body.catalog_rev, hash: r1.body.hash, state: 'active', exceptions: [], confirmed_pauses: pend } });
      steps.push({ call: 'POST /v1/consumers/' + cid + '/acks (state active)', status: r2.status });
      return { status: 200, body: { consumer_id: cid, result: 'pulled and acked rev ' + r1.body.catalog_rev, steps: steps, ack: r2.body } };
    }
    function demoRoute(method, path, query, body) {
      if (method === 'GET' && path === '/v1/demo/state') {
        return { status: 200, body: { now: iso(now()), catalog_rev: cur().rev, catalog: S.catalog.map(function (e) { return { rev: e.rev, created_at: iso(e.created_at), reason: e.reason, hash: e.hash }; }),
          lists: Object.keys(S.lists).map(function (n) { var v = S.lists[n].versions; return { name: n, version: v[v.length - 1].version, domains: v[v.length - 1].domains }; }),
          segments: Object.keys(S.segments).sort().map(function (id) { var s = S.segments[id]; return { segment_id: id, name: s.name, advertiser_id: s.advertiser_id, active_version: s.active_version, versions: s.versions.length }; }),
          consumers: Object.keys(S.consumers).map(function (k) { var c = S.consumers[k]; return { id: c.id, name: c.name, traffic_share: c.traffic_share, active_rev: c.active_rev, unreachable: c.unreachable }; }),
          tokens: Object.keys(tokens).map(function (k) { return { token: k, actor: tokens[k].actor, role: tokens[k].role, label: tokens[k].label }; }),
          audit: S.audit.slice(-60), match_log: S.matchLog.slice(-20) } };
      }
      if (method === 'POST' && path === '/v1/demo/reset') { hub.reset(); return { status: 200, body: { status: 'reset', catalog_rev: cur().rev } }; }
      if (method === 'POST' && path === '/v1/demo/advance') {
        var sec = Number(body && body.seconds);
        if (!Number.isFinite(sec) || sec <= 0 || sec > 86400) fail(400, 'invalid_body', 'seconds must be between 1 and 86400');
        offset += sec * 1000; return { status: 200, body: { now: iso(now()), advanced_seconds: sec } };
      }
      var m = /^\/v1\/demo\/consumers\/([a-z0-9_]+)\/(sync|unreachable)$/.exec(path);
      if (method === 'POST' && m) {
        if (!S.consumers[m[1]]) fail(404, 'consumer_not_found', 'No consumer ' + m[1]);
        if (m[2] === 'sync') return consumerSync(m[1]);
        S.consumers[m[1]].unreachable = !(body && body.value === false);
        return { status: 200, body: { consumer_id: m[1], unreachable: S.consumers[m[1]].unreachable } };
      }
      m = /^\/v1\/demo\/lists\/([a-z0-9_]+)\/domains$/.exec(path);
      if (method === 'POST' && m) {
        var l = S.lists[m[1]]; if (!l) fail(404, 'unknown_list', 'No list ' + m[1]);
        var d = body && typeof body.domain === 'string' ? body.domain.toLowerCase() : '';
        if (!FIELDS['site.domain'].pattern.test(d)) fail(400, 'invalid_body', 'domain looks invalid');
        var last = l.versions[l.versions.length - 1];
        if (last.domains.indexOf(d) > -1) fail(409, 'already_listed', d + ' is already on ' + m[1]);
        l.versions.push({ version: last.version + 1, domains: last.domains.concat([d]).sort(), created_at: now() });
        var e = bumpCatalog('list ' + m[1] + ' v' + (last.version + 1) + ' adds ' + d, 'list_owner');
        audit('list_owner', 'system', 'list_update', null, null, m[1] + ' v' + (last.version + 1) + ' adds ' + d);
        var prevCat = S.catalog[e.rev - 1];
        var affected = Object.keys(e.segments).filter(function (id) { return prevCat.segments[id] && prevCat.segments[id].fingerprint !== e.segments[id].fingerprint; })
          .map(function (id) { return { segment_id: id, new_effective_fingerprint: e.segments[id].fingerprint, previous: prevCat.segments[id].fingerprint }; });
        return { status: 200, body: { list: m[1], version: last.version + 1, catalog_rev: e.rev, affected_segments: affected, note: 'One approval for the list. No new segment versions were minted. Effective fingerprints changed, so servers on the old revision now show as stale.' } };
      }
      fail(404, 'not_found', 'No such demo route');
    }

    // ---- router
    function handle(req) {
      var method = String(req.method || 'GET').toUpperCase();
      var path = String(req.path || '/').replace(/\/+$/, '') || '/';
      var query = req.query || {}, headers = lower(req.headers), body = req.body;
      try {
        if (method === 'GET' && path === '/v1/health') return { status: 200, body: { ok: true, service: 'segment-hub', catalog_rev: cur().rev } };
        if (path.indexOf('/v1/demo/') === 0) return demoRoute(method, path, query, body);
        if (method === 'GET' && /^\/v1\/catalog\/objects\/rev-\d+\.json$/.test(path)) return getObject(path, query);
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
      function go(id, rule, name, adv) {
        var cr = name ? call('tok_priya_adops', 'POST', '/v1/segments', { segment_id: id, name: name, advertiser_id: adv || 'adv_glowroot', rule: rule }) : call('tok_priya_adops', 'POST', '/v1/segments/' + id + '/versions', { rule: rule });
        call('tok_priya_adops', 'POST', '/v1/segments/' + id + '/transitions', { action: 'submit', version: cr.version });
        call('tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'approve', version: cr.version });
        return call('tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'publish', version: cr.version, reason: 'Seed data for the demo' });
      }
      function sync(cid) { var r = consumerSync(cid); return r.body; }
      var tier = function (cats) { return [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] }, { tier: 2, all: [{ field: 'site.cat', in: cats }] }]; };
      var festive = function (regions, cats) {
        return { must: [{ field: 'device.geo.region', in: regions }, { field: 'device.type', in: ['mobile', 'tablet'] }, { field: 'site.domain', not_in_list: 'excl_buyer_blocklist' }], should: tier(cats), if_audience_missing: 'fall_back_to_context' };
      };
      T(-360);
      S.lists.excl_buyer_blocklist = { name: 'excl_buyer_blocklist', versions: [{ version: 1, domains: ['cheap-clicks.example', 'viral-feed.example'], created_at: now() }] };
      go('seg_glowroot_festive_east', festive(['IN-WB'], ['IAB18-1']), 'GlowRoot Festive East India');
      T(-359);
      go('seg_glowroot_premium_north', { must: [{ field: 'device.geo.region', in: ['IN-DL', 'IN-HR'] }, { field: 'device.type', in: ['mobile', 'tablet', 'desktop'] }, { field: 'site.domain', not_in_list: 'excl_buyer_blocklist' }],
        should: [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] }, { tier: 2, all: [{ field: 'site.cat', in: ['IAB18-1'] }] }], if_audience_missing: 'fall_back_to_context', strict_compliance: true }, 'GlowRoot Premium North');
      T(-300);
      go('seg_glowroot_festive_east', festive(['IN-WB'], ['IAB18-1', 'IAB18-3']));
      T(-290); sync('edge_mum_1'); sync('edge_us_1'); sync('edge_sg_1');
      T(-5);
      handle({ method: 'POST', path: '/v1/demo/lists/excl_buyer_blocklist/domains', body: { domain: 'glow-deals-feed.example' } });
      T(-4); sync('edge_mum_1');
      T(-3);
      go('seg_glowroot_festive_east', festive(['IN-WB', 'IN-OD'], ['IAB18-1', 'IAB18-3']));
      T(-2); sync('edge_us_1');
      T(0);
    }

    var hub = {
      handle: handle,
      verifySnapshot: verifySnapshot,
      tokens: tokens,
      now: now,
      advance: function (sec) { offset += sec * 1000; },
      reset: function () { offset = 0; init(); if (opts.seed) seed(); },
      state: function () { return S; }
    };
    init();
    if (opts.seed) seed();
    return hub;
  }

  return {
    createHub: createHub, validateRule: validateRule, normalizeRule: normalizeRule, compareRules: compareRules, blastRadius: blastRadius,
    normaliseRequest: normaliseRequest, evalRule: evalRule, effectiveFingerprint: effectiveFingerprint, classifyStale: classifyStale,
    hash: hash, canon: canon, DEFAULT_TOKENS: DEFAULT_TOKENS, EXPIRY: EXPIRY
  };
});
