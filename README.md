# Segment Hub

An internal API for targeting segments: one place where ad ops define who an ad may reach, test and publish that
definition with a second approver, and see whether every ad server is actually running the active version.
Prototype for the Media.net APM case, Topic 3. It is a control plane. Real bid-time matching stays in the ad servers.

## Run it

    node server.js        # http://localhost:3000, no dependencies, Node 18 or newer
    npm test              # engine and About page tests
    node build-openapi.js # regenerates public/openapi.json from real responses

The page at `/` calls the live API. The same engine also runs inside the browser (`dist/demo.html`, built with
`node build-demo.js`) for a no-server demo.

## The About page

The first tab, "About this project", explains the problem, the choices, the metrics and the assumptions behind the build.
Its words live in `public/about.md` and are drawn by `public/about.js`, so the text can be edited without touching any code.

## The endpoints

Full reference with real request and response examples: `/docs` (machine-readable at `/openapi.json`).

| Endpoint | Purpose |
|---|---|
| `POST /v1/segments`, `POST /v1/segments/{id}/versions` | Create a segment bound to its Deal IDs, add an immutable version |
| `GET /v1/lists/{name}`, `POST /v1/lists/{name}/versions`, `POST /v1/lists/{name}/transitions` | Exclusion lists. Adding a site publishes with one person; removing one needs an approver |
| `POST /v1/segments/{id}/transitions` | submit, approve, publish, rollback, pause (stop everywhere), resume |
| `GET /v1/catalog/head` | Small signed head read every 30 s: revision, stopped segments, what to do with each older copy. Mirrored at `/v1/catalog/objects/head.json` |
| `GET /v1/catalog/snapshot?since_rev=` | Signed delta for machines, ETag, cold-start manifest with a signed object URL |
| `POST /v1/consumers/{id}/acks` | A server instance reports the revision it runs, the head it has read, and anything it stopped on its own |
| `GET /v1/segments/{id}?include=sync` | Active version, history, per-instance sync state and a per-cluster summary |
| `POST /v1/match` | Reference evaluator with replay by catalog revision or segment version |

## How a stale copy gets stopped

The hub never sends stop commands. At publish time it classifies every recent older copy of each segment as wider or narrower
and writes, into the head, what a server holding that copy must do: keep serving (narrower), stop after 15 minutes (wider, strict),
drop audience tiers after 4 hours (wider, standard), or stop at once (consent critical). Each server enforces that on its own copy
and reports what it stopped. A server that cannot read any head for 15 minutes stops its strict segments. Because the head lives
in object storage, a hub API outage stops nothing that was correct.

Routes under `/v1/demo/` only drive the demo (reset, move the clock, simulate a server syncing, failing to reload or being cut off,
a hub outage, adding a site to the exclusion list). They are not part of the product API.

## What is real and what is simulated

Real: rule validation, matching, versions, fingerprints, blast-radius diff, four-eyes, exclusion lists, deal bindings, snapshots
with deltas and ETag, the signed head and its stop rules, per-instance reports in three states, stale-copy policy, exposure ledger,
idempotency, tenant isolation.

Simulated: the ad servers (a small simulator plays each instance using only what a real server would have), tokens are fixed
demo tokens, signatures are a demo hash, consent strings are not decoded (a string containing "denied" counts as no consent),
traffic shares are invented, state is in memory.

## Chroma

The mascot is an independent character made for this prototype, not a Media.net asset. Images live in `public/assets/chroma/`
and one registry in `public/index.html` maps application states to them. It only reacts to states the page has observed.

Auth for the demo: `Authorization: Bearer tok_priya_adops` (writer), `tok_rahul_approver` (approver), `tok_admin`.
The page lists all tokens under API explorer.
