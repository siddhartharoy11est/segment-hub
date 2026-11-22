# Segment Hub

An internal API for targeting segments: one place where ad ops define who an ad may reach, test and publish that
definition with a second approver, and see whether every ad server is actually running the active version.
Prototype for the Media.net APM case, Topic 3. It is a control plane. Real bid-time matching stays in the ad servers.

## Run it

    node server.js        # http://localhost:3000, no dependencies, Node 18 or newer
    npm test              # 79 tests

The page at `/` calls the live API. The same engine also runs inside the browser (`dist/demo.html`, built with
`node build-demo.js`) for a no-server demo.

## The About page

The first tab, "About this project", explains the problem, the choices, the metrics and the assumptions behind the build.
Its words live in `public/about.md` and are drawn by `public/about.js`, so the text can be edited without touching any code.

## The six endpoint families

| Endpoint | Purpose |
|---|---|
| `POST /v1/segments`, `POST /v1/segments/{id}/versions` | Create a segment, add an immutable version |
| `GET /v1/segments/{id}?include=sync` | Active version, history, per-consumer sync state |
| `GET /v1/catalog/snapshot?since_rev=` | Signed delta for machines, ETag, cold-start manifest with a signed object URL |
| `POST /v1/segments/{id}/transitions` | submit, approve, publish, rollback, pause, resume |
| `POST /v1/match` | Reference evaluator with replay by catalog revision or segment version |
| `POST /v1/consumers/{id}/acks` | A consumer reports the revision it runs |

Routes under `/v1/demo/` only drive the demo (reset, move the clock, simulate a consumer syncing or going quiet,
add a site to the exclusion list). They are not part of the product API.

## What is real and what is simulated

Real: rule validation, matching, versions, fingerprints, blast-radius diff, four-eyes, snapshots with deltas and ETag,
acks with three states, stale-copy policy, local expiry, idempotency, tenant isolation.

Simulated: tokens are fixed demo tokens, snapshot signatures are a demo hash, consent strings are not decoded
(a string containing "denied" counts as no consent), consumers and traffic shares are invented, state is in memory.

Auth for the demo: `Authorization: Bearer tok_priya_adops` (writer), `tok_rahul_approver` (approver), `tok_admin`.
The page lists all tokens under API explorer.
