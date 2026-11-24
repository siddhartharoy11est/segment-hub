// Builds public/openapi.json. Every example is a real response from a freshly seeded hub, so the contract cannot drift from the code.
// Run with: node build-openapi.js
const fs = require('fs');
const E = require('./src/engine.js');
const hub = E.createHub({ seed: true });
function call(tok, method, path, body, query, headers) {
  return hub.handle({ method, path, query: query || {}, headers: Object.assign(tok ? { authorization: 'Bearer ' + tok } : {}, headers || {}), body });
}
function trim(v, depth) {
  depth = depth || 0;
  if (Array.isArray(v)) return v.slice(0, depth > 1 ? 2 : 3).map(x => trim(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[k] = trim(v[k], depth + 1); }); return o; }
  return v;
}
const rule = { must: [{ field: 'device.geo.region', in: ['IN-WB', 'IN-OD'] }, { field: 'device.type', in: ['mobile'] }, { field: 'site.domain', not_in_list: 'excl_buyer_blocklist' }],
  should: [{ tier: 1, all: [{ field: 'audience.purchase_skincare_30d', eq: true }, { field: 'site.cat', in: ['IAB18-1'] }] }, { tier: 2, all: [{ field: 'site.cat', in: ['IAB18-1'] }] }], if_audience_missing: 'fall_back_to_context' };
const bid = { id: 'req-1', device: { devicetype: 4, geo: { country: 'IND', region: 'IN-DL' } }, site: { domain: 'glow-deals-feed.example', cat: ['IAB18-1'], cattax: 1 }, user: { data: [{ id: 'partner_a', segment: [{ id: 'purchase_skincare_30d' }] }] }, regs: { gpp: 'demo-gpp-granted' } };
const st = hub.state();
const ex = {};
function rec(name, req, res) { ex[name] = { request: req, status: res.status, response: trim(res.body) }; return res; }

const createBody = { name: 'GlowRoot Monsoon Care', advertiser_id: 'adv_glowroot', deal_ids: ['MN-GLOW-MONSOON'], rule };
rec('createSegment', createBody, call('tok_priya_adops', 'POST', '/v1/segments', createBody, {}, { 'idempotency-key': 'k-create-1' }));
rec('createSegment_typo', null, call('tok_priya_adops', 'POST', '/v1/segments', Object.assign({}, createBody, { name: 'Typo', rule: Object.assign({}, rule, { must: [{ field: 'device.geo.regoin', in: ['IN-WB'] }] }) })));
const verBody = { rule: Object.assign({}, rule, { must: [{ field: 'device.geo.region', in: ['IN-WB'] }, rule.must[1], rule.must[2]] }) };
rec('createVersion', verBody, call('tok_priya_adops', 'POST', '/v1/segments/seg_glowroot_monsoon_care/versions', verBody));
rec('submit', { action: 'submit', version: 2 }, call('tok_priya_adops', 'POST', '/v1/segments/seg_glowroot_monsoon_care/transitions', { action: 'submit', version: 2 }));
rec('approve_four_eyes', { action: 'approve', version: 2 }, call('tok_priya_adops', 'POST', '/v1/segments/seg_glowroot_monsoon_care/transitions', { action: 'approve', version: 2 }));
const listAdd = { add: ['new-spam.example'], reason: 'Buyer flagged the site as off-brand' };
rec('listAdd', listAdd, call('tok_priya_adops', 'POST', '/v1/lists/excl_buyer_blocklist/versions', listAdd));
const listRemove = { remove: ['viral-feed.example'], reason: 'Buyer unblocked the site' };
rec('listRemove', listRemove, call('tok_priya_adops', 'POST', '/v1/lists/excl_buyer_blocklist/versions', listRemove));
rec('listApprove', { action: 'approve' }, call('tok_rahul_approver', 'POST', '/v1/lists/excl_buyer_blocklist/transitions', { action: 'approve' }));
rec('getList', null, call('tok_priya_adops', 'GET', '/v1/lists/excl_buyer_blocklist'));
// read the head as the failing Singapore server sees it
rec('head', null, call('tok_edge_sg_1', 'GET', '/v1/catalog/head'));
rec('snapshot', null, call('tok_edge_us_1', 'GET', '/v1/catalog/snapshot', null, { since_rev: String(st.catalog.length - 3) }));
rec('snapshot_cold', null, call('tok_edge_us_1', 'GET', '/v1/catalog/snapshot'));
const ackBody = { catalog_rev: 3, hash: st.catalog[3].hash, state: 'active', head_rev: st.catalog.length - 1, exceptions: [{ error: 'apply_failed' }], locally_stopped: [] };
rec('ack_stale', ackBody, call('tok_edge_sg_1', 'POST', '/v1/consumers/edge_sg_1/acks', ackBody));
rec('sync', null, call('tok_priya_adops', 'GET', '/v1/segments/seg_glowroot_premium_north', null, { include: 'sync' }));
rec('match', bid, call('tok_priya_adops', 'POST', '/v1/match', bid, { catalog_rev: '3', compare: 'active' }));
rec('pause', { action: 'pause', reason: 'Client escalation' }, call('tok_priya_adops', 'POST', '/v1/segments/seg_glowroot_festive_east/transitions', { action: 'pause', reason: 'Client escalation' }));
rec('resume_writer', { action: 'resume', reason: 'All clear' }, call('tok_priya_adops', 'POST', '/v1/segments/seg_glowroot_festive_east/transitions', { action: 'resume', reason: 'All clear' }));

function op(summary, description, who, tag, reqName, extra) {
  const e = ex[reqName];
  const o = { summary, description, tags: [tag], 'x-who-calls': who, responses: {} };
  if (e.request) o.requestBody = { content: { 'application/json': { example: e.request } } };
  o.responses[String(e.status)] = { description: 'Example from the seeded demo', content: { 'application/json': { example: e.response } } };
  (extra || []).forEach(n => { const x = ex[n]; o.responses[String(x.status)] = { description: n.replace(/_/g, ' '), content: { 'application/json': { example: x.response } } }; });
  return o;
}
const idemHeader = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Replays the first response for the same key and body. A different body with the same key is refused with 422.' };
const spec = {
  openapi: '3.0.3',
  info: { title: 'Segment Hub API', version: '1.0.0-prototype',
    description: 'Internal control-plane API for targeting segments behind curated deals. Prototype for the Media.net APM case, Topic 3. Not an official Media.net API. ' +
      'The hub is never called during the auction: servers read a small signed head, pull signed snapshots, match locally, and report what they serve. ' +
      'One rule decides who may act alone: anything that can only stop or narrow delivery needs one person and a reason; anything that can widen reach needs a second person.' },
  servers: [{ url: '/' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Demo tokens identify people (writer, approver, reader, admin) and machines (one per server instance). Production: OAuth2 client credentials or mutual TLS for machines, the company identity provider for people.' } } },
  security: [{ bearer: [] }],
  'x-errors': { format: { error: 'machine_code', message: 'human sentence', path: 'where in the body, when relevant' },
    codes: { 400: 'invalid body or rule, with a did-you-mean where possible', 401: 'no or unknown token', 403: 'role or four-eyes refusal', 404: 'not found, or not visible to your advertiser', 409: 'wrong state, duplicate, or corrupt copy (hash mismatch)', 413: 'rule too large', 422: 'idempotency key reused with a different body', 429: 'rate or prototype limit', 503: 'hub API down; the head stays readable from object storage' } },
  paths: {
    '/v1/segments': { post: Object.assign(op('Create a segment', 'Creates version 1 in draft, bound to its Deal IDs. The rule is validated before it is saved; audience conditions get a consent tag.', 'AdOps (writer)', 'Author', 'createSegment', ['createSegment_typo']), { parameters: [idemHeader] }) },
    '/v1/segments/{id}/versions': { post: Object.assign(op('Add a version', 'Versions are immutable. Deal IDs carry over unless deal_ids is sent.', 'AdOps (writer)', 'Author', 'createVersion'), { parameters: [idemHeader] }) },
    '/v1/lists/{name}': { get: op('Read an exclusion list', 'Current domains, history, and any change waiting for approval.', 'AdOps, approvers, readers', 'Author', 'getList') },
    '/v1/lists/{name}/versions': { post: Object.assign(op('Change an exclusion list', 'Adding sites narrows reach, so it publishes at once with one person and a reason (201). Removing a site widens reach, so it waits for an approver (202).', 'AdOps (writer)', 'Author', 'listAdd', ['listRemove']), { parameters: [idemHeader] }) },
    '/v1/lists/{name}/transitions': { post: op('Approve or reject a list change', 'By an approver who did not propose it.', 'Approver', 'Approve', 'listApprove') },
    '/v1/segments/{id}/transitions': { post: Object.assign(op('Move a segment through its lifecycle', 'submit, approve, publish, rollback, pause (stop everywhere), resume. Submit returns the blast radius. Approve, publish and resume need an approver who did not create the version; pause and a rollback that is not wider may be done by one person with a reason.', 'AdOps and approvers', 'Approve', 'submit', ['approve_four_eyes', 'pause', 'resume_writer']), { parameters: [idemHeader] }) },
    '/v1/catalog/head': { get: op('Read the head', 'A small signed document every server reads every 30 seconds: current revision, revoked segments, and for each segment what a server must do if it holds an older copy (on_server, after_seconds). Mirrored at /v1/catalog/objects/head.json, readable without a token.', 'Ad servers and the deal tagger', 'Distribute', 'head') },
    '/v1/catalog/snapshot': { get: Object.assign(op('Pull the catalog', 'Signed delta since a revision, with ETag (If-None-Match returns 304). A cold start or a too-old revision returns a manifest to a signed object-store copy instead.', 'Ad servers and the deal tagger', 'Distribute', 'snapshot', ['snapshot_cold']), { parameters: [{ name: 'since_rev', in: 'query', schema: { type: 'integer' } }, { name: 'If-None-Match', in: 'header', schema: { type: 'string' } }] }) },
    '/v1/consumers/{id}/acks': { post: op('Report what a server runs', 'The server identity comes from its token, never the body. Only state active at the current revision counts as in sync. The reply says sync_required; it never contains a stop command.', 'Ad servers and the deal tagger', 'Observe', 'ack_stale') },
    '/v1/segments/{id}': { get: Object.assign(op('Check a segment and its sync', 'With include=sync: per server instance, the held copy (wider, narrower, same), what the server will do on its own, the hub action, exposure, and a per-cluster summary.', 'AdOps, approvers, reporting', 'Observe', 'sync'), { parameters: [{ name: 'include', in: 'query', schema: { type: 'string', enum: ['sync'] } }] }) },
    '/v1/match': { post: Object.assign(op('Test a request', 'Which segments and deals an OpenRTB-style request is eligible for, with clause-level reasons. Replays against a catalog revision or a segment version, and compares with the active catalog. Persists ids and outcomes only.', 'AdOps, support', 'Test', 'match'), { parameters: [{ name: 'catalog_rev', in: 'query', schema: { type: 'integer' } }, { name: 'compare', in: 'query', schema: { type: 'string', enum: ['active'] } }, { name: 'segment_id', in: 'query', schema: { type: 'string' } }, { name: 'version', in: 'query', schema: { type: 'integer' } }] }) }
  }
};
fs.writeFileSync('public/openapi.json', JSON.stringify(spec, null, 2));
console.log('public/openapi.json', Math.round(fs.statSync('public/openapi.json').size / 1024) + ' KB', Object.keys(spec.paths).length + ' paths');
Object.keys(ex).forEach(k => console.log(' ', k, ex[k].status));
