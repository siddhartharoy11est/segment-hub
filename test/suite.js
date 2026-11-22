/* Test suite shared by Node (npm test) and the browser demo page ("Run live tests").
 * Each case builds its own fresh hub, so running it never touches the demo data.
 * These tests prove the logic is internally consistent. They do not prove it matches Media.net's real systems. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubSuite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function build(E, assert) {
    var tests = [];
    var BASE = 1800000000000;
    function t(group, name, fn) { tests.push({ group: group, name: name, fn: fn }); }

    function mk(extra) {
      var h = E.createHub(Object.assign({ now: function () { return BASE; }, seed: false }, extra || {}));
      h.state().lists.excl_mfa = { name: 'excl_mfa', versions: [{ version: 1, domains: ['cheap-clicks.example', 'viral-feed.example'], created_at: BASE }] };
      return h;
    }
    function call(h, tok, method, path, body, query, headers) {
      return h.handle({ method: method, path: path, query: query || {}, headers: Object.assign({ authorization: 'Bearer ' + tok }, headers || {}), body: body });
    }
    var T1 = { tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] };
    var T2 = { tier: 2, all: [{ field: 'site.cat', in: ['IAB18-1'] }] };
    function rule(o) {
      return Object.assign({
        must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD'] }, { field: 'device.type', in: ['mobile', 'tablet'] }, { field: 'site.domain', not_in_list: 'excl_mfa' }],
        should: [T1, T2], if_audience_missing: 'fall_back_to_context'
      }, o || {});
    }
    function req(mut) {
      var r = { id: 'req-1', device: { devicetype: 4, os: 'android', geo: { country: 'IND', region: 'IN-WB' } },
        site: { domain: 'beauty-blog.example', cat: ['IAB18-1'], cattax: 1 },
        user: { data: [{ id: 'partner_a', segment: [{ id: 'purchase_skincare_30d' }] }] }, regs: { gpp: 'demo-gpp-granted' } };
      if (mut) mut(r);
      return r;
    }
    function create(h, id, r, adv) {
      var res = call(h, 'tok_priya_adops', 'POST', '/v1/segments', { segment_id: id, name: id, advertiser_id: adv || 'adv_glowroot', rule: r });
      assert.equal(res.status, 201, 'create ' + JSON.stringify(res.body));
      return res.body;
    }
    function live(h, id, r, newVersion) {
      var v = newVersion ? call(h, 'tok_priya_adops', 'POST', '/v1/segments/' + id + '/versions', { rule: r }).body : create(h, id, r);
      assert.equal(call(h, 'tok_priya_adops', 'POST', '/v1/segments/' + id + '/transitions', { action: 'submit', version: v.version }).status, 200);
      assert.equal(call(h, 'tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'approve', version: v.version }).status, 200);
      var p = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/' + id + '/transitions', { action: 'publish', version: v.version, reason: 'test publish' });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      return p.body;
    }
    function match(h, body, query, tok) { return call(h, tok || 'tok_priya_adops', 'POST', '/v1/match', body, query).body; }
    function setup(r) { var h = mk(); live(h, 'seg_a', r || rule()); return h; }
    function syncAll(h, ids) { (ids || ['edge_mum_1', 'edge_us_1', 'edge_sg_1', 'deal_tagger_1']).forEach(function (c) { var r = call(h, 'tok_admin', 'POST', '/v1/demo/consumers/' + c + '/sync'); assert.ok(r.status === 200, 'sync ' + c + ' ' + JSON.stringify(r.body)); }); }
    function row(h, seg, cid) { return call(h, 'tok_priya_adops', 'GET', '/v1/segments/' + seg, null, { include: 'sync' }).body.sync.consumers.filter(function (x) { return x.consumer_id === cid; })[0]; }

    var G1 = 'Hard-rule boundaries';
    t(G1, 'region in the list matches', function () { var m = match(setup(), req()); assert.equal(m.matches.length, 1); });
    t(G1, 'region outside the list is excluded with the reason', function () {
      var m = match(setup(), req(function (r) { r.device.geo.region = 'IN-DL'; }));
      assert.equal(m.matches.length, 0); assert.ok(m.excluded[0].reason.indexOf('IN-DL') > -1);
    });
    t(G1, 'missing region is excluded, not matched by accident', function () {
      var m = match(setup(), req(function (r) { delete r.device.geo.region; }));
      assert.equal(m.matches.length, 0); assert.ok(m.excluded[0].reason.indexOf('missing') > -1);
    });
    t(G1, 'device outside the list is excluded', function () { assert.equal(match(setup(), req(function (r) { r.device.type = 'desktop'; })).matches.length, 0); });
    t(G1, 'tablet is allowed', function () { assert.equal(match(setup(), req(function (r) { r.device.type = 'tablet'; })).matches.length, 1); });
    t(G1, 'site on an exclusion list is excluded and names list and version', function () {
      var m = match(setup(), req(function (r) { r.site.domain = 'cheap-clicks.example'; }));
      assert.equal(m.matches.length, 0); assert.ok(m.excluded[0].reason.indexOf('excl_mfa') > -1 && m.excluded[0].reason.indexOf('v1') > -1);
    });
    t(G1, 'a subdomain of a listed site is excluded too', function () { assert.equal(match(setup(), req(function (r) { r.site.domain = 'm.cheap-clicks.example'; })).matches.length, 0); });
    t(G1, 'a look-alike domain is not excluded (suffix boundary)', function () { assert.equal(match(setup(), req(function (r) { r.site.domain = 'notcheap-clicks.example'; })).matches.length, 1); });
    t(G1, 'a hard category rule in must excludes other categories', function () {
      var h = setup(rule({ must: rule().must.concat([{ field: 'site.cat', in: ['IAB18-1'] }]) }));
      assert.equal(match(h, req(function (r) { r.site.cat = ['IAB1-2']; })).matches.length, 0);
      assert.equal(match(h, req()).matches.length, 1);
    });

    var G2 = 'Consent and missing data';
    t(G2, 'consent plus audience signal gives tier 1', function () { assert.equal(match(setup(), req()).matches[0].tier, 1); });
    t(G2, 'no consent string falls back to tier 2 (context only)', function () {
      var m = match(setup(), req(function (r) { delete r.regs; })); assert.equal(m.matches[0].tier, 2); assert.ok(m.matches[0].reason.indexOf('context only') > -1);
    });
    t(G2, 'denied consent also falls back to tier 2', function () { assert.equal(match(setup(), req(function (r) { r.regs.gpp = 'demo-gpp-denied'; })).matches[0].tier, 2); });
    t(G2, 'consent without an audience signal is tier 2', function () { assert.equal(match(setup(), req(function (r) { r.user = {}; })).matches[0].tier, 2); });
    t(G2, 'audience_required with no consent is ineligible', function () {
      var h = setup(rule({ audience_required: true })); var m = match(h, req(function (r) { delete r.regs; }));
      assert.equal(m.matches.length, 0); assert.ok(m.excluded[0].reason.indexOf('audience required') > -1);
    });
    t(G2, 'audience_required with consent and signal matches tier 1', function () { assert.equal(match(setup(rule({ audience_required: true })), req()).matches[0].tier, 1); });
    t(G2, 'if_audience_missing ineligible blocks the context fallback', function () {
      assert.equal(match(setup(rule({ if_audience_missing: 'ineligible' })), req(function (r) { delete r.regs; })).matches.length, 0);
    });
    t(G2, 'audience rules are tagged consent_required automatically, with a warning', function () {
      var h = mk(); var r = rule(); var res = call(h, 'tok_priya_adops', 'POST', '/v1/segments', { name: 'tagged', advertiser_id: 'adv_glowroot', rule: r });
      assert.equal(res.status, 201); assert.ok(res.body.validation.warnings[0].indexOf('needs consent') > -1);
      var seg = call(h, 'tok_priya_adops', 'GET', '/v1/segments/' + res.body.segment_id).body;
      assert.equal(seg.versions.length, 1);
      var bad = rule({ should: [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true, consent_required: false }] }] });
      assert.equal(call(h, 'tok_priya_adops', 'POST', '/v1/segments', { name: 'bad', advertiser_id: 'adv_glowroot', rule: bad }).status, 400);
    });
    t(G2, 'consent is read from user.consent and user.ext.consent as well as regs.gpp', function () {
      var h = setup();
      assert.equal(match(h, req(function (r) { delete r.regs; r.user.consent = 'demo-tcf-granted'; })).matches[0].tier, 1);
      assert.equal(match(h, req(function (r) { delete r.regs; r.user.ext = { consent: 'demo-tcf-granted' }; })).matches[0].tier, 1);
    });

    var G3 = 'Tiers and priority';
    t(G3, 'the best (lowest) passing tier wins', function () { assert.equal(match(setup(), req()).matches[0].tier, 1); });
    t(G3, 'tier order in the array does not matter', function () { assert.equal(match(setup(rule({ should: [T2, T1] })), req()).matches[0].tier, 1); });
    t(G3, 'should never makes a request ineligible: no tier matched gives base priority', function () {
      var m = match(setup(), req(function (r) { r.site.cat = ['IAB1-2']; })); assert.equal(m.matches.length, 1); assert.equal(m.matches[0].tier, null);
    });
    t(G3, 'a tier-only edit is reported as no change in eligibility', function () {
      var h = setup(); var v2 = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/versions', { rule: rule({ should: [T1] }) }).body;
      var s = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: v2.version }).body;
      assert.equal(s.blast_radius.new_version_change, 'no_change'); assert.equal(s.blast_radius.tier_change, true);
    });
    t(G3, 'the match reason names the tier that fired', function () { assert.ok(match(setup(), req()).matches[0].reason.indexOf('tier 1') > -1); });

    var G4 = 'Versions, fingerprint, replay, blast-radius class';
    t(G4, 'versions are immutable: adding v2 leaves v1 untouched', function () {
      var h = setup(); call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/versions', { rule: rule({ must: [{ field: 'device.geo.region', in: ['IN-KA'] }] }) });
      var s = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a').body; assert.equal(s.versions.length, 2); assert.equal(s.active_version, 1);
      assert.equal(s.active.rule.must.filter(function (c) { return c.field === 'device.geo.region'; })[0].in.join(), 'IN-OD,IN-WB');
    });
    t(G4, 'same rule written in a different order has the same fingerprint', function () {
      var a = E.normalizeRule(rule()), b = E.normalizeRule(rule({ must: rule().must.slice().reverse().map(function (c) { return c.in ? Object.assign({}, c, { in: c.in.slice().reverse() }) : c; }) }));
      assert.equal(E.hash(E.canon(a)), E.hash(E.canon(b)));
    });
    t(G4, 'an exclusion-list update changes the effective fingerprint without a new segment version', function () {
      var h = setup(); var before = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a').body;
      var up = call(h, 'tok_admin', 'POST', '/v1/demo/lists/excl_mfa/domains', { domain: 'new-spam.example' });
      assert.equal(up.status, 200); var after = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a').body;
      assert.equal(after.versions.length, before.versions.length); assert.equal(after.active.fingerprint, before.active.fingerprint);
      assert.notEqual(after.active.effective_fingerprint, before.active.effective_fingerprint); assert.equal(up.body.affected_segments.length, 1);
    });
    t(G4, 'adding a region is expands_reach: high publish risk, low stale-copy risk', function () {
      var h = setup(); var v = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/versions', { rule: rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-BR'] }, rule().must[1], rule().must[2]] }) }).body;
      var b = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: v.version }).body.blast_radius;
      assert.equal(b.new_version_change, 'expands_reach'); assert.equal(b.publish_risk, 'high'); assert.equal(b.stale_copy_behavior, 'narrower_subset'); assert.equal(b.stale_copy_risk, 'low');
    });
    t(G4, 'removing a region is narrows_reach: lower publish risk, high stale-copy risk', function () {
      var h = setup(); var v = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/versions', { rule: rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }) }).body;
      var b = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: v.version }).body.blast_radius;
      assert.equal(b.new_version_change, 'narrows_reach'); assert.equal(b.publish_risk, 'lower'); assert.equal(b.stale_copy_behavior, 'wider_superset'); assert.equal(b.stale_copy_risk, 'high');
    });
    t(G4, 'a mixed change is treated as wider (conservative)', function () {
      var h = setup(); var v = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/versions', { rule: rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-BR'] }, { field: 'device.type', in: ['mobile'] }, rule().must[2]] }) }).body;
      var b = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: v.version }).body.blast_radius;
      assert.equal(b.new_version_change, 'mixed_change'); assert.equal(b.publish_risk, 'high'); assert.equal(b.stale_copy_risk, 'high');
    });
    t(G4, 'replay against one segment version shows where two versions differ', function () {
      var h = setup(rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }));
      live(h, 'seg_a', rule(), true);
      var odisha = req(function (r) { r.device.geo.region = 'IN-OD'; });
      assert.equal(match(h, odisha, { segment_id: 'seg_a', version: 1 }).matches.length, 0);
      assert.equal(match(h, odisha, { segment_id: 'seg_a', version: 2 }).matches.length, 1);
    });
    t(G4, 'a bare region code from the exchange is expanded from the country, and OpenRTB devicetype integers are understood', function () {
      var h = setup(); var m = match(h, req(function (r) { r.device.geo.region = 'WB'; r.device.devicetype = 5; }));
      assert.equal(m.normalised.region, 'IN-WB'); assert.equal(m.normalised.device, 'tablet'); assert.equal(m.matches.length, 1);
    });
    t(G4, 'replay by catalog revision, with compare=active, flags divergence', function () {
      var h = setup(rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }));
      live(h, 'seg_a', rule(), true);
      var m = match(h, req(function (r) { r.device.geo.region = 'IN-OD'; }), { catalog_rev: 1, compare: 'active' });
      assert.equal(m.matches.length, 0); assert.equal(m.compare.diverges, true); assert.equal(m.compare.active.matches.length, 1);
    });
    t(G4, 'rollback restores the older version and bumps the catalog revision', function () {
      var h = setup(); var fp1 = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a').body.active.effective_fingerprint;
      live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-KA'] }, rule().must[1], rule().must[2]] }), true);
      var rb = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'bad publish' });
      assert.equal(rb.status, 200); assert.equal(rb.body.catalog_rev, 3);
      assert.equal(call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a').body.active.effective_fingerprint, fp1);
    });

    var G5 = 'Roles, four-eyes, tenant isolation';
    t(G5, 'a writer cannot approve', function () {
      var h = mk(); create(h, 'seg_a', rule()); call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: 1 });
      assert.equal(call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'approve', version: 1 }).status, 403);
    });
    t(G5, 'emergency path: a writer can roll back alone to a version that is not wider, with a reason', function () {
      var h = setup(); live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-KA'] }, rule().must[1], rule().must[2]] }), true);
      var no = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1 }); assert.equal(no.status, 400);
      var rb = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'client escalation' });
      assert.equal(rb.status, 200); assert.equal(rb.body.version, 1);
    });
    t(G5, 'a rollback that widens reach is refused for a writer and allowed for an approver', function () {
      var h = setup(); live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }), true);
      var w = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'client escalation' });
      assert.equal(w.status, 403); assert.equal(w.body.error, 'rollback_widens');
      assert.equal(call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'approved widening' }).status, 200);
    });
    t(G5, 'a rollback that loosens the audience gate is refused for everyone, including an approver', function () {
      var h = setup(); live(h, 'seg_a', rule({ if_audience_missing: 'ineligible' }), true);
      var a = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'undo the tightening' });
      assert.equal(a.status, 403); assert.equal(a.body.error, 'rollback_loosens_consent');
      assert.equal(call(h, 'tok_admin', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'undo the tightening' }).status, 403);
    });
    t(G5, 'a writer can pause for everyone, but still cannot approve or publish', function () {
      var h = setup();
      var p = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'pause', scope: 'all', reason: 'brand safety incident' }); assert.equal(p.status, 202);
      var ap = call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'approve', version: 1 }); assert.equal(ap.status, 403);
    });
    t(G5, 'four-eyes: the creator cannot approve their own version, even as admin', function () {
      var h = mk(); call(h, 'tok_admin', 'POST', '/v1/segments', { segment_id: 'seg_a', name: 'a', advertiser_id: 'adv_glowroot', rule: rule() });
      call(h, 'tok_admin', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: 1 });
      var r = call(h, 'tok_admin', 'POST', '/v1/segments/seg_a/transitions', { action: 'approve', version: 1 });
      assert.equal(r.status, 403); assert.equal(r.body.error, 'four_eyes_violation');
    });
    t(G5, 'publish before approval is refused with the state it needs', function () {
      var h = mk(); create(h, 'seg_a', rule()); call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: 1 });
      var r = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'publish', version: 1, reason: 'too early' });
      assert.equal(r.status, 409); assert.equal(r.body.error, 'invalid_state');
    });
    t(G5, 'another advertiser gets 404 on a segment, not 403', function () {
      var h = setup(); assert.equal(call(h, 'tok_other_writer', 'GET', '/v1/segments/seg_a').status, 404);
    });
    t(G5, 'writing for another advertiser is forbidden', function () {
      var h = mk(); assert.equal(call(h, 'tok_other_writer', 'POST', '/v1/segments', { name: 'x', advertiser_id: 'adv_glowroot', rule: rule() }).status, 403);
    });
    t(G5, '/match only evaluates the caller\'s own segments', function () {
      var h = setup(); var m = match(h, req(), {}, 'tok_other_writer'); assert.equal(m.matches.length, 0); assert.equal(m.excluded.length, 0);
    });
    t(G5, 'no token or a bad token is 401', function () {
      var h = setup(); assert.equal(h.handle({ method: 'GET', path: '/v1/segments/seg_a', headers: {} }).status, 401);
      assert.equal(call(h, 'tok_nope', 'GET', '/v1/segments/seg_a').status, 401);
    });
    t(G5, 'a publish or pause needs a reason', function () {
      var h = mk(); create(h, 'seg_a', rule()); call(h, 'tok_priya_adops', 'POST', '/v1/segments/seg_a/transitions', { action: 'submit', version: 1 }); call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'approve', version: 1 });
      var r = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'publish', version: 1 }); assert.equal(r.status, 400); assert.equal(r.body.error, 'reason_required');
    });

    var G6 = 'Malformed and abusive rules';
    function bad(r) { return call(mk(), 'tok_priya_adops', 'POST', '/v1/segments', { name: 'bad', advertiser_id: 'adv_glowroot', rule: r }); }
    t(G6, 'unknown field is rejected with a did-you-mean', function () {
      var r = bad(rule({ must: [{ field: 'device.geo.state', in: ['IN-WB'] }] })); assert.equal(r.status, 400); assert.equal(r.body.details[0].suggestion, 'device.geo.region');
      assert.ok(r.body.message.indexOf("Did you mean 'device.geo.region'") > -1);
    });
    t(G6, 'two operators in one condition are rejected', function () { assert.equal(bad(rule({ must: [{ field: 'device.type', in: ['mobile'], not_in: ['ctv'] }] })).status, 400); });
    t(G6, 'a segment with no hard condition is rejected', function () { var r = bad(rule({ must: [] })); assert.equal(r.status, 400); assert.equal(r.body.error, 'empty_must'); });
    t(G6, 'nested conditions are rejected', function () { var r = bad(rule({ must: [{ all: [{ field: 'device.type', in: ['mobile'] }] }] })); assert.equal(r.status, 400); assert.ok(r.body.details.some(function (d) { return d.error === 'nesting_not_supported'; })); });
    t(G6, 'an oversized rule is rejected with 413', function () {
      var many = []; for (var i = 0; i < 400; i++) many.push('site' + i + '.example');
      var r = bad(rule({ must: [{ field: 'site.domain', in: many }, { field: 'device.geo.region', in: ['IN-WB'] }] })); assert.ok(r.status === 413 || r.status === 400); assert.ok(r.body.error);
    });
    t(G6, 'bad values are rejected: region code, device enum, unknown list', function () {
      assert.equal(bad(rule({ must: [{ field: 'device.geo.region', in: ['WB'] }] })).status, 400);
      assert.equal(bad(rule({ must: [{ field: 'device.type', in: ['toaster'] }] })).status, 400);
      assert.equal(bad(rule({ must: [{ field: 'site.domain', not_in_list: 'excl_nothing' }] })).body.error, 'unknown_list');
    });
    t(G6, 'a non-object body is rejected', function () { assert.equal(call(mk(), 'tok_priya_adops', 'POST', '/v1/segments', [1, 2]).status, 400); });
    t(G6, 'audience_required without any audience condition is rejected', function () { assert.equal(bad(rule({ should: [T2], audience_required: true })).status, 400); });

    var G7 = 'Snapshot, acks, stale-copy policy';
    t(G7, 'cold start returns a manifest pointing to a signed object copy that verifies', function () {
      var h = setup(); var r = call(h, 'tok_edge_us_1', 'GET', '/v1/catalog/snapshot');
      assert.equal(r.status, 200); assert.equal(r.body.mode, 'object_url'); var loc = r.body.url.split('?'); var q = {}; loc[1].split('&').forEach(function (kv) { var p = kv.split('='); q[p[0]] = p[1]; });
      var o = h.handle({ method: 'GET', path: loc[0], query: q, headers: {} }); assert.equal(o.status, 200); assert.ok(h.verifySnapshot(o.body).ok); assert.equal(o.body.segments.length, 1);
    });
    t(G7, 'a signed URL with a bad signature is refused', function () {
      var h = setup(); assert.equal(h.handle({ method: 'GET', path: '/v1/catalog/objects/rev-1.json', query: { exp: '1', sig: 'sig_bad' }, headers: {} }).status, 403);
    });
    t(G7, 'a too-old since_rev also returns the object manifest', function () {
      var h = mk({ maxDeltaRevs: 1 }); live(h, 'seg_a', rule()); live(h, 'seg_a', rule({ should: [T1] }), true); live(h, 'seg_a', rule({ should: [T2] }), true);
      var m = call(h, 'tok_edge_us_1', 'GET', '/v1/catalog/snapshot', null, { since_rev: 1 }); assert.equal(m.status, 200); assert.equal(m.body.mode, 'object_url');
    });
    t(G7, 'since_rev returns only changed segments, and the current rev is 304', function () {
      var h = setup(); live(h, 'seg_b', rule()); var r = call(h, 'tok_edge_us_1', 'GET', '/v1/catalog/snapshot', null, { since_rev: 1 });
      assert.equal(r.status, 200); assert.equal(r.body.segments.length, 1); assert.equal(r.body.segments[0].segment_id, 'seg_b');
      assert.equal(call(h, 'tok_edge_us_1', 'GET', '/v1/catalog/snapshot', null, { since_rev: 2 }).status, 304);
    });
    t(G7, 'a tampered snapshot fails verification', function () {
      var h = setup(); var r = call(h, 'tok_edge_us_1', 'GET', '/v1/catalog/snapshot', null, { since_rev: 0 }); assert.ok(h.verifySnapshot(r.body).ok);
      r.body.segments[0].rule.must = []; assert.equal(h.verifySnapshot(r.body).ok, false);
    });
    t(G7, 'only an active ack counts as in sync', function () {
      var h = setup(); var hash = h.state().catalog[1].hash;
      var a = call(h, 'tok_edge_us_1', 'POST', '/v1/consumers/edge_us_1/acks', { catalog_rev: 1, hash: hash, state: 'accepted' });
      assert.equal(a.status, 200); assert.equal(a.body.counts_as_in_sync, false); assert.notEqual(row(h, 'seg_a', 'edge_us_1').state, 'in_sync');
      call(h, 'tok_edge_us_1', 'POST', '/v1/consumers/edge_us_1/acks', { catalog_rev: 1, hash: hash, state: 'active' }); assert.equal(row(h, 'seg_a', 'edge_us_1').state, 'in_sync');
    });
    t(G7, 'ack identity comes from the token, never the body', function () {
      var h = setup(); var hash = h.state().catalog[1].hash;
      assert.equal(call(h, 'tok_edge_us_1', 'POST', '/v1/consumers/edge_sg_1/acks', { catalog_rev: 1, hash: hash, state: 'active' }).status, 403);
      call(h, 'tok_edge_us_1', 'POST', '/v1/consumers/edge_us_1/acks', { consumer_id: 'edge_sg_1', catalog_rev: 1, hash: hash, state: 'active' });
      assert.equal(row(h, 'seg_a', 'edge_us_1').state, 'in_sync'); assert.equal(row(h, 'seg_a', 'edge_sg_1').state, 'unknown');
    });
    t(G7, 'an ack with the wrong hash is refused', function () {
      var h = setup(); var r = call(h, 'tok_edge_us_1', 'POST', '/v1/consumers/edge_us_1/acks', { catalog_rev: 1, hash: 'deadbeef', state: 'active' }); assert.equal(r.status, 409); assert.equal(r.body.error, 'hash_mismatch');
    });
    t(G7, 'a consumer that never acked is unknown and not counted as stale', function () {
      var h = setup(); syncAll(h, ['edge_us_1']); var s = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a', null, { include: 'sync' }).body.sync;
      assert.equal(row(h, 'seg_a', 'deal_tagger_1').state, 'unknown'); assert.equal(s.summary.ack_coverage_pct, 25); assert.equal(s.summary.stale_version_impression_share_pct, 0);
    });
    function widerStaleSetup() { // consumers hold v1, v2 tightens the rule, so their copy is wider
      var h = setup(); syncAll(h, ['edge_us_1', 'edge_sg_1']);
      live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }), true); return h;
    }
    t(G7, 'a wider stale copy is high risk and gets a pause request', function () {
      var h = widerStaleSetup(); var r = row(h, 'seg_a', 'edge_sg_1'); assert.equal(r.classification, 'wider_superset'); assert.equal(r.risk, 'high'); assert.equal(r.recommended_action, 'request_pause');
      var p = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'pause', reason: 'stale wider copy' }); assert.equal(p.status, 202); assert.ok(p.body.pending.indexOf('edge_sg_1') > -1);
    });
    t(G7, 'a stale copy that is wider on the audience gate is consent critical and recommends the kill switch', function () {
      var h = setup(); syncAll(h, ['edge_us_1', 'edge_sg_1']);
      live(h, 'seg_a', rule({ if_audience_missing: 'ineligible' }), true);
      var r = row(h, 'seg_a', 'edge_sg_1'); assert.equal(r.risk, 'high'); assert.equal(r.consent_critical, true); assert.equal(r.recommended_action, 'kill_switch_now');
    });
    t(G7, 'a narrower stale copy is never paused: alert and refresh', function () {
      var h = setup(rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] })); syncAll(h, ['edge_us_1']);
      live(h, 'seg_a', rule(), true); var r = row(h, 'seg_a', 'edge_us_1'); assert.equal(r.classification, 'narrower_subset'); assert.equal(r.risk, 'low'); assert.equal(r.recommended_action, 'alert_p2_and_refresh');
      var p = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'pause', reason: 'try to pause' }); assert.equal(p.status, 200); assert.equal(p.body.status, 'no_pause_needed'); assert.equal(p.body.skipped.length, 1);
    });
    t(G7, 'a pause is confirmed only when the consumer acks it', function () {
      var h = widerStaleSetup(); call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'pause', reason: 'stale wider copy' });
      assert.equal(row(h, 'seg_a', 'edge_sg_1').pause, 'requested'); syncAll(h, ['edge_sg_1']); assert.equal(row(h, 'seg_a', 'edge_sg_1').pause, 'confirmed');
    });
    t(G7, 'an unreachable consumer with a wider copy needs the kill switch, not just a pause request', function () {
      var h = widerStaleSetup(); call(h, 'tok_admin', 'POST', '/v1/demo/consumers/edge_sg_1/unreachable', { value: true });
      var r = row(h, 'seg_a', 'edge_sg_1'); assert.equal(r.state, 'unknown'); assert.equal(r.recommended_action, 'kill_switch_then_expiry');
      var p = call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'pause', reason: 'consumer wedged' }); assert.ok(p.body.unreachable.indexOf('edge_sg_1') > -1); assert.ok(p.body.backstop.indexOf('kill switch') > -1);
    });
    t(G7, 'local expiry counts down, then follows the segment policy', function () {
      var h = widerStaleSetup(); var r0 = row(h, 'seg_a', 'edge_sg_1'); assert.equal(r0.seconds_until_local_expiry, 14400); assert.equal(r0.local_expiry_outcome, null);
      call(h, 'tok_admin', 'POST', '/v1/demo/advance', { seconds: 14401 }); var r1 = row(h, 'seg_a', 'edge_sg_1'); assert.ok(r1.seconds_until_local_expiry <= 0); assert.equal(r1.local_expiry_outcome, 'degrade_to_context_only');
    });
    t(G7, 'strict_compliance segments expire in minutes and fail closed', function () {
      var h = mk(); live(h, 'seg_s', rule({ strict_compliance: true })); syncAll(h, ['edge_sg_1']);
      live(h, 'seg_s', rule({ strict_compliance: true, must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule().must[1], rule().must[2]] }), true);
      var r = row(h, 'seg_s', 'edge_sg_1'); assert.equal(r.expiry_class, 'strict'); assert.equal(r.seconds_until_local_expiry, 900);
      call(h, 'tok_admin', 'POST', '/v1/demo/advance', { seconds: 901 }); assert.equal(row(h, 'seg_s', 'edge_sg_1').local_expiry_outcome, 'fail_closed');
    });
    t(G7, 'an exclusion-list update marks an old-revision consumer as a wider stale copy', function () {
      var h = setup(); syncAll(h, ['edge_sg_1', 'edge_us_1']); call(h, 'tok_admin', 'POST', '/v1/demo/lists/excl_mfa/domains', { domain: 'glow-deals-feed.example' }); syncAll(h, ['edge_us_1']);
      var r = row(h, 'seg_a', 'edge_sg_1'); assert.equal(r.classification, 'wider_superset'); assert.equal(r.risk, 'high'); assert.equal(row(h, 'seg_a', 'edge_us_1').state, 'in_sync');
      var site = req(function (x) { x.site.domain = 'glow-deals-feed.example'; });
      var m = match(h, site, { catalog_rev: 1, compare: 'active' }); assert.equal(m.matches.length, 1); assert.equal(m.compare.diverges, true); assert.equal(m.compare.active.matches.length, 0);
    });
    t(G7, 'a rolled-back bad publish does not make correct consumers look stale', function () {
      var h = setup(); syncAll(h, ['edge_us_1']); live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-KA'] }, rule().must[1], rule().must[2]] }), true);
      assert.equal(row(h, 'seg_a', 'edge_us_1').state, 'confirmed_stale');
      call(h, 'tok_rahul_approver', 'POST', '/v1/segments/seg_a/transitions', { action: 'rollback', version: 1, reason: 'bad publish' }); assert.equal(row(h, 'seg_a', 'edge_us_1').state, 'in_sync');
    });
    t(G7, '/match persists no user data: the log holds ids, outcomes and versions only', function () {
      var h = setup(); match(h, req()); var log = JSON.stringify(h.state().matchLog);
      assert.ok(log.indexOf('partner_a') < 0 && log.indexOf('demo-gpp-granted') < 0 && log.indexOf('beauty-blog') < 0); assert.ok(log.indexOf('seg_a@v1') > -1);
    });
    t(G7, 'idempotency: a repeated key replays the first result, a changed body is refused', function () {
      var h = mk(); var body = { name: 'idem', advertiser_id: 'adv_glowroot', rule: rule() }, hd = { 'idempotency-key': 'k1' };
      var a = call(h, 'tok_priya_adops', 'POST', '/v1/segments', body, {}, hd), b = call(h, 'tok_priya_adops', 'POST', '/v1/segments', body, {}, hd);
      assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(b.headers['idempotent-replay'], 'true'); assert.equal(Object.keys(h.state().segments).length, 1);
      assert.equal(call(h, 'tok_priya_adops', 'POST', '/v1/segments', { name: 'other', advertiser_id: 'adv_glowroot', rule: rule() }, {}, hd).status, 422);
    });
    t(G7, 'the seeded demo tells the GlowRoot story', function () {
      var h = E.createHub({ now: function () { return BASE; }, seed: true });
      var f = function (s, c) { return call(h, 'tok_priya_adops', 'GET', '/v1/segments/' + s, null, { include: 'sync' }).body.sync.consumers.filter(function (x) { return x.consumer_id === c; })[0]; };
      assert.equal(f('seg_glowroot_festive_east', 'edge_mum_1').risk, 'low'); assert.equal(f('seg_glowroot_festive_east', 'edge_mum_1').classification, 'narrower_subset');
      assert.equal(f('seg_glowroot_premium_north', 'edge_sg_1').classification, 'wider_superset'); assert.equal(f('seg_glowroot_festive_east', 'edge_us_1').state, 'in_sync'); assert.equal(f('seg_glowroot_festive_east', 'deal_tagger_1').state, 'unknown');
    });

    var G8 = 'Reach estimate and stale exposure';
    function submitRadius(h, id, r) {
      var v = call(h, 'tok_priya_adops', 'POST', '/v1/segments/' + id + '/versions', { rule: r }).body;
      return call(h, 'tok_priya_adops', 'POST', '/v1/segments/' + id + '/transitions', { action: 'submit', version: v.version }).body.blast_radius;
    }
    t(G8, 'submit estimates reach on a simulated sample: wider adds impressions, narrower removes them, tier-only changes nothing', function () {
      var h = setup(), base = rule();
      var wide = submitRadius(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-KA'] }, base.must[1], base.must[2]] }));
      assert.ok(wide.estimated_reach.delta_per_day > 0); assert.ok(wide.estimated_reach.delta_pct > 0); assert.ok(wide.plain_language.indexOf('Estimated reach') > -1);
      assert.ok(wide.estimated_reach.basis.indexOf('Simulated sample') === 0);
      var narrow = submitRadius(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB'] }, base.must[1], base.must[2]] }));
      assert.ok(narrow.estimated_reach.delta_per_day < 0);
      var tiers = submitRadius(h, 'seg_a', rule({ should: [T2] }));
      assert.equal(tiers.estimated_reach.delta_per_day, 0);
    });
    t(G8, 'the reach estimate is repeatable and consistent with the matcher', function () {
      var h1 = setup(), h2 = setup(), r = rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-DL'] }, rule().must[1], rule().must[2]] });
      var a = submitRadius(h1, 'seg_a', r).estimated_reach, b = submitRadius(h2, 'seg_a', r).estimated_reach;
      assert.equal(JSON.stringify(a), JSON.stringify(b), 'two runs of the estimate differ'); assert.ok(a.before_per_day > 0 && a.after_per_day <= 20000000);
    });
    t(G8, 'the simulated sample spreads over many sites, so one excluded site cannot wipe out the reach', function () {
      var h = setup(), base = rule();
      var r = submitRadius(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-DL'] }, base.must[1], base.must[2]] })).estimated_reach;
      assert.ok(r.before_per_day > 100000, 'before ' + r.before_per_day);
      assert.ok(r.after_per_day > r.before_per_day);
    });
    t(G8, 'a stale copy that excludes what the active version adds is described from the active version side', function () {
      var h = setup(); syncAll(h, ['edge_us_1']);
      live(h, 'seg_a', rule({ must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD', 'IN-KA'] }, rule().must[1], rule().must[2]] }), true);
      var r = row(h, 'seg_a', 'edge_us_1');
      assert.equal(r.classification, 'narrower_subset'); assert.ok(r.summary.indexOf('what the active version has that this copy lacks') > -1 || r.summary.indexOf('What the active version has that this copy lacks') > -1);
    });
    t(G8, 'stale exposure accrues as traffic share times minutes behind, from acknowledgements alone', function () {
      var h = widerStaleSetup();
      var s0 = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a', null, { include: 'sync' }).body.sync.summary;
      assert.equal(s0.high_risk_stale_exposure_traffic_minutes, 0);
      call(h, 'tok_admin', 'POST', '/v1/demo/advance', { seconds: 3600 });
      var s1 = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a', null, { include: 'sync' }).body.sync.summary;
      assert.ok(Math.abs(s1.high_risk_stale_exposure_traffic_minutes - (0.38 + 0.30) * 60) < 0.5, String(s1.high_risk_stale_exposure_traffic_minutes));
      syncAll(h, ['edge_us_1', 'edge_sg_1']);
      var s2 = call(h, 'tok_priya_adops', 'GET', '/v1/segments/seg_a', null, { include: 'sync' }).body.sync.summary;
      assert.equal(s2.high_risk_stale_exposure_traffic_minutes, 0);
    });

    return tests;
  }

  function run(E, assert) {
    var tests = build(E, assert), out = [];
    tests.forEach(function (x) {
      try { x.fn(); out.push({ group: x.group, name: x.name, ok: true }); }
      catch (e) { out.push({ group: x.group, name: x.name, ok: false, error: String(e && e.message || e).slice(0, 400) }); }
    });
    return out;
  }

  var mini = {
    ok: function (v, m) { if (!v) throw new Error(m || 'expected truthy'); },
    equal: function (a, b, m) { if (a !== b) throw new Error((m ? m + ': ' : '') + 'expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a)); },
    deepEqual: function (a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ? m + ': ' : '') + 'expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a)); },
    notEqual: function (a, b, m) { if (a === b) throw new Error((m ? m + ': ' : '') + 'expected values to differ, both ' + JSON.stringify(a)); }
  };
  return { build: build, run: run, mini: mini };
});
