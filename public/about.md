[[GREETING]]
Hi, I'm Sid. Thanks for taking the time to look at this. This page walks you through how I thought about the problem and what I built over the last two days. The prototype is made to be tried, so please click around. I'd love to talk it through with you.
[[/GREETING]]

[[VISUAL: brief-map]]

# About This Project

**Prototype for the Media.net APM case, Topic 3**

## Segment Hub
*An internal API to define, approve and ship targeting segments, and prove that every ad server runs them.*

Segment Hub is an internal API for targeting segments. AdOps defines who a curated deal may reach, tests the rule against sample bid requests, and publishes it with a second person's approval. Ad servers pull the approved rules, match locally at bid speed, and report which version they run, so the hub can show, server by server, whether the rule that was approved is the rule that is live.

**The problem I chose inside the brief.** A buyer blocks a site, and one ad server silently misses the update, so the deal stays eligible where the buyer said no. The hub finds that one server, and the server stops the segment itself, at a deadline the hub shipped ahead of time. The hub never sends stop commands.

All data in this prototype is simulated for demonstration. The brand (GlowRoot, a skincare advertiser), the people and the ad servers are fictional.

### In 60 seconds

| | |
|---|---|
| **The brief** | Create an internal API for targeting segments. Define key endpoints, request and response formats, and security |
| **The problem** | When a targeting rule changes, nobody can confirm that every ad system is using the new version. My hypothesis is that the buyer can find out before Media.net does |
| **Who uses it** | AdOps builds and publishes segments. An approver reviews new rules. Ad servers pull the rules and report which version they hold |
| **What the hub does** | Keeps one source of truth, numbers every version, gets every change that can widen reach approved by a second person, collects reports from every server instance, and classifies a stale copy as wider (high risk) or narrower (low risk) |
| **What it does not do** | Match requests at bid time, score users, or hold user data. There is no AI model in the decision path |
| **North star** | In the pilot: high-risk stale exposure, the traffic share times minutes a wider copy stayed live past a 2 minute propagation window, measured from server reports alone. Later, once ad servers log the version: the share of segment-tagged impressions served under an old version |
| **Try it** | 1 minute. Open the Story tab and click "Replay the incident". Then try "Take the hub down for 20 minutes" and open the Sync board |

---

## 1. The problem I chose to solve

The brief asks for endpoints, request and response formats, and security. It does not state which problem the API should address, so I began by identifying where targeting rules go wrong in practice.

### Pain points, and how I prioritised them

| Pain point | Example | Decision | Reason |
|---|---|---|---|
| The rule is defined wrongly | A client asks for West Bengal and the rule is saved as all of India | **Pain A, addressed** | The cost lands on the client's spend, and it can be prevented before publish |
| The rule cannot be tested before it is live | No way to try the rule on sample traffic | **Folded into Pain A** | The same controls address both: dry run, impact warning, approval, rollback |
| A server runs an old version after a change | One server still runs the version before an exclusion list update | **Pain B, addressed. This is the focus** | It is silent, nothing errors, and it can leak outside what the client approved |
| Nobody can prove which version served an impression | A client disputes delivery and the version in force cannot be shown | **Treated as a benefit and a metric input** | It depends on ad servers logging the version on each impression, which the hub does not control |

[[PAIN-LEGEND]]
**Pain A: a wrong rule goes live.** **Pain B: ad servers run an out-of-date rule.**
[[/PAIN-LEGEND]]

**Problem statement.** When a targeting rule changes, nobody can confirm that every ad server is using the new version. My hypothesis is that the buyer can find out before Media.net does, and the pilot tests it.

**What one API can and cannot do.** An API cannot force an ad server to update. It can hold one source of truth, number the versions, collect reports, identify which servers are behind, classify the risk, and publish the rule each server must follow if it cannot catch up. It cannot repair a server that is down or correct poor location data.

### Approaches considered

| Approach | Pain it addresses | Bid-path risk | Governance | Decision |
|---|---|---|---|---|
| **Segment CRUD service** | Part of A: storage and history. Does not address B | None | Limited: nothing says whether a change widens or narrows a rule | Included as the foundation (endpoints 1 to 3) |
| **Live matching service** | Part of A: testing a rule. Does not address B | High if placed on the bid path, because every bid depends on it and must fit a single digit millisecond slice | Central, but a second matching engine can drift from the ad server's | Kept as a reference tester (`POST /v1/match`). Production matching stays in the ad servers |
| **Control plane with drift detection** | A and B | None. The hub is off the bid path | Versions, approvals, acknowledgements and a stale-copy policy | **Chosen** |

**Why not existing config-distribution or feature-flag tooling.** Those tools move configuration. They do not know whether a change to a targeting rule widens or narrows reach, or that an audience rule needs consent. The hub could sit on top of one as the transport. I have not seen Media.net's tooling, so this is my judgment.

**Why pull with acknowledgements, not push.** A pull is cacheable and scales through deltas and ETags. A push cannot prove that the receiver applied the change. The acknowledgement is the evidence the sync board depends on.

**Why the server enforces the stop, not the hub.** A stop command from the hub has the same weakness as the update it replaces: a server that cannot apply the update may not act on a command either, and a server that cannot reach the hub never hears it. So the hub decides the rule once, at publish time, and puts it in the head, a signed document of a few kilobytes that every server reads every 30 seconds. For each older copy of a segment, the head says whether that copy is wider and how long a server may keep serving it. The server applies that to its own copy. In production the head is mirrored to object storage, so a hub outage does not stop anyone reading it.

**Where segments sit in the deal stack.** A curated deal packages inventory and data under a Deal ID, and the ad server matches each request against it. IAB Tech Lab's Seller Defined Audiences spec, since renamed Curated Audiences, passes taxonomy coded segments in the bid request. The hub does neither job. It governs the rule that sits behind a Deal ID, so the same rule is the one every system uses. I have not seen how Media.net evaluates a deal today, so this is listed as an assumption in section 6.

**A segment is a rule, not a list of users.** A segment here is region, device, content category, site lists and a consent-gated audience flag. Audience membership arrives from upstream as IDs on the bid request, so the hub governs targeting logic and holds no user profiles.

### What I looked at, and what I took from it

| Source | What it says | What I took |
|---|---|---|
| Google Ad Manager help, how long changes take | Line item changes can take up to 10 minutes, network configuration up to 180 minutes, and blocking a previously approved ad up to 24 hours | Propagation delay is normal. That window is where mixed versions exist |
| AppNexus 2013 outage postmortem | A routine data update exposed a latent bug in the impression bus and reached roughly 900 servers at once. Recovery used a tested snapshot, and the fixes include validation before distribution and reliable return to a known good state | Stage releases, validate before distributing, and keep a tested last known good copy |
| Xandr incident, January 2021 | Impression buses were rolled back to an older configuration, with the first 10% resuming first | A rollback path and a staged restart |
| OpenRTB 2.6 | Defines `device.devicetype`, `device.geo.region`, `site.cat` with `cattax`, `regs.gpp` and `user.consent` | The request format the hub reads |
| IAB Content Taxonomy 1.0 | Beauty is IAB18-1. IAB Tech Lab has deprecated 1.0; the current version is 3.1 | The code is used in the demo only because it is short and readable. A production build would use 3.1 and set `cattax` to 9 |
| Consent frameworks: India's DPDP Act, EU GDPR with the IAB TCF, US state laws signalled through GPP | DPDP consent obligations phase in by May 2027. The EU is opt-in and granular. Most US state laws are opt-out | Consent is a per-jurisdiction check, not one global flag. The prototype simplifies it to one flag and says so |

These sources establish that propagation delay and bad configuration changes are real. They do not establish how often drift causes wrong delivery at Media.net, so I treat that as an assumption and measure it first (sections 5 and 6).

---

## 2. Stakeholders

Two groups use the product, one reviews, and the rest are affected by what it does.

| Who | Role | What they need | How the product responds |
|---|---|---|---|
| **AdOps (Priya)**, with account managers requesting changes | Primary user. Builds, tests and publishes. Can roll back or stop a segment alone in an emergency | A correct rule quickly, and confidence that it is what runs | Dry run, a plain-language impact warning, one-step rollback |
| **Approver (Rahul, Meera) and security** | Reviews new rules. Owns roles and the audit trail | A clear view of what a change does to reach, without becoming a bottleneck | One rule decides who may act alone: anything that can only stop or narrow delivery needs one person and a reason. Anything that can widen reach, or bring in content nobody reviewed, needs a second person. Every action is logged |
| **Ad server and deal tagger teams** | Machine users. Read the head, pull rules, report what they hold, enforce deadlines | A small, signed, cacheable bundle, with the hub off the bid path | Signed deltas by revision, ETag, a last known good copy kept locally, and stop rules they can apply without calling anyone |
| **The advertiser (GlowRoot) and reporting** | Affected, not users | Delivery that respects the targeting and exclusions they asked for, and the exact rule version behind a number | Immutable versions, a fingerprint to join on, and detection of a stale copy before the client has to |

---

## 3. The problem in practice

**Who it affects.** AdOps, the ad server teams and the advertisers whose rules they run, wherever targeting rules are changed centrally and served from many places.

**Why it matters.** A rule can be correct where it was written and wrong where it is served. The server holding an old copy keeps making the deal eligible, nothing errors, and if the buyer bids and wins, the first to notice could be the buyer, finding their ad on a site they blocked.

### How a stale rule keeps serving

[[VISUAL: problem-flow]]

### A worked example (illustrative numbers, not the seed data)

| | |
|---|---|
| Client request | Exclude the buyer's own list of blocked sites |
| Change | A site is added to the exclusion list at revision 4 |
| One server | Still holds revision 3, so the deal stays eligible on that site |
| Impressions per hour on that server | 5,00,000 |
| Share on the newly excluded site | 4% |
| Hours until someone notices | 6 |
| Impressions won and served there, if the buyer bids | 1,20,000 |
| Average price (eCPM) | ₹90 |
| **Direct value served against the exclusion** | **₹10,800** |
| Campaign value the client could pause or withdraw | ₹25,00,000 |

The direct figure is small. The exposure is the campaign the client can pause or demand credit on, which is more than 200 times larger in this example. That is why a wider stale copy is treated as high risk even when the revenue figure looks minor. I make no claim about how often a client would act on a breach like this.

[[VISUAL: example-calc]]

---

## 4. The working prototype

Try it in about three minutes. The page opens as Priya, who works in AdOps. Use the "Acting as" menu at the top to switch role. The logins are simulated, to show how roles connect. They are not real security.

| Journey | Who | What you do | What you will see |
|---|---|---|---|
| **Start here. Replay the incident** | Priya | Story tab, click "Replay the incident" and press Next through five steps | A blocklist update is published, one of three Singapore servers fails to reload it, the board finds that one server, and the server stops the segment itself at its deadline. The whole case in one minute |
| **A. A normal request** | Anyone | Run Requests 1, 2 and 3 on the Story tab | A match at tier 1, a fallback to context only when consent is missing, and an exclusion on a site the buyer blocked |
| **B. A narrower stale copy** | Anyone | Run Request 4 | Both Mumbai servers hold an older rule. It under-delivers but cannot reach excluded traffic, so it keeps serving: alert and refresh, never stop |
| **C. A wider stale copy** | Anyone | Run Request 5, then open the Sync board | edge_sg_1 missed a blocklist update because its reload failed. Its copy is wider, so it is high risk. Premium North is strict, so the server counts down 15 minutes from when it learned it was behind, then stops it. Festive East is standard, for comparison: it drops audience tiers after 4 hours |
| **D. Publish with a second person** | Priya, then Rahul | Segments tab, change the rule in the editor, save it as a new version, then click "Run full flow" on that draft | The creator cannot approve or publish. A plain-language impact warning and an estimated change in daily reach appear at submit |
| **E. An emergency** | Priya | On the Sync board, "Stop this segment everywhere", with a reason | It works without a second person, because stopping can only reduce delivery. It reaches every server through the head within 30 seconds, even the one whose reload is failing. Resuming needs an approver |
| **F. Cause drift yourself** | Priya | "Break reload" on a server, add a site to the exclusion list, then move the clock | Healthy servers apply it at once. The broken one turns stale, the board classifies it, and its countdown runs. "Cut off" shows the lease instead |

Every result shows the version, the reason and the rule it relied on. Versions are never overwritten, so a later change never erases an earlier one.

### 4.1 The nine endpoints, and the pain each one addresses

[[PAIN-LEGEND]]
**Pain A: a wrong rule goes live.** **Pain B: ad servers run an out-of-date rule.**
[[/PAIN-LEGEND]]

| # | Endpoint | Who calls it | What it does | Pain |
|---|---|---|---|---|
| 1 | `POST /v1/segments` | AdOps | Creates a segment as version 1, bound to its Deal IDs. Validates the rule and adds a consent tag to any audience rule | [[PAIN:A]] |
| 2 | `POST /v1/segments/{id}/versions` | AdOps | Adds a new immutable version. History is never overwritten | [[PAIN:A]] |
| 3 | `POST /v1/lists/{name}/versions` | AdOps | Changes an exclusion list. Adding sites publishes with one person; removing one waits for an approver (`POST /v1/lists/{name}/transitions`) | [[PAIN:A,B]] |
| 4 | `POST /v1/segments/{id}/transitions` | AdOps, approver | Submit, approve, publish, rollback, stop everywhere, resume. Submit returns the impact in plain words | [[PAIN:A,B]] |
| 5 | `GET /v1/catalog/head` | Ad servers, deal tagger | A small signed document read every 30 seconds: the current revision, stopped segments, and what to do with each older copy. Mirrored to object storage | [[PAIN:B]] |
| 6 | `GET /v1/catalog/snapshot` | Ad servers, deal tagger | Every live segment, its deals and lists, signed. Delta by revision, ETag, and a manifest to a signed copy on a cold start | [[PAIN:B]] |
| 7 | `POST /v1/consumers/{id}/acks` | Ad servers, deal tagger | A server reports the revision and hash it holds, whether it is `received`, `accepted` or `active`, the newest head it has read, and anything it stopped on its own. Only `active` counts as in sync | [[PAIN:B]] |
| 8 | `GET /v1/segments/{id}` | AdOps, admin, reporting | The active version, deals, drafts and history. With `?include=sync`, every server instance: in sync, stale or unknown, what it will do on its own, and the cluster view | [[PAIN:B]] |
| 9 | `POST /v1/match` | AdOps, anyone replaying | Which segments and deals a request is eligible for, and why. Replays against an older revision or an unpublished version | [[PAIN:A,B]] |

The full contract, with request and response examples, is at `/docs`.

### 4.2 What happens when a stale copy turns up

When a new version or list change is published, the hub compares it with every recent older copy on every condition, list, deal and consent rule. That tells it how risky each older copy is, and it writes the answer into the head.

| What the new version changed | The old copy is | Risk | What happens | Status |
|---|---|---|---|---|
| Adds a region, or removes a condition or an exclusion | Narrower. Under-delivers | Low | The server keeps serving. The hub raises a P2 alert and asks it to refresh. Never stopped | Built |
| Removes a region, adds a condition, or adds a site to an exclusion list, on a strict segment | Wider. Can make the deal eligible outside the target | High | The server stops the segment 15 minutes after it learns it is behind, unless it catches up first. The hub raises a P1 alert | Built |
| The same, on a standard segment | Wider | High | The server keeps serving and drops audience tiers after 4 hours. The hub raises a P1 alert and a person decides whether to stop it everywhere | Built |
| Changes in both directions, or cannot be compared | Treated as wider | High | As the two rows above | Built |
| Requires audience data and consent more strictly | Wider on consent | Critical | The server stops the segment at once. The hub raises a P0 if the server has not reported stopping | Built. The consent string is read, not decoded |
| Changes only priority tiers | Same eligibility, different priority | Low | The server keeps serving. Alert and refresh | Built |
| Changes only the name or metadata | Same fingerprint | None | Nothing | Built |
| A server stops reporting | Unknown | Escalating | Its strict segments stop by lease, 15 minutes after its last head read. The hub probes and alerts | Built |

**Who stops what.** The hub never sends a stop command. It detects, classifies and alerts. The server enforces the deadline the head gives it, and reports what it stopped. A person can stop a segment everywhere at any time; that also travels in the head, so it reaches a server whose reload is failing.

**A hub outage stops nothing that was correct.** The lease counts from a server's last read of the head, and the head lives in object storage, not behind the hub API. If the hub API is down, nothing new can be published, so no server can fall behind on anything new, and every server keeps renewing its lease. Only a server cut off from the head itself stops its strict segments, because it is blind. The Story tab shows this: 20 minutes without the hub, and no correct copy stops.

**Who may act alone.** Anything that can only stop or narrow delivery needs one person and a reason: stopping a segment, rolling back to a version that is not wider, adding a site to an exclusion list. Anything that can widen reach, or bring in content nobody reviewed, needs a second person: approving and publishing a version, resuming a stopped segment, removing a site from a list. A rollback that loosens audience or consent requirements is refused for everyone, and must be republished as a new version.

**A decision I revised, twice.** I first intended to pause any out-of-date server. I changed this because a narrower stale copy only under-delivers, and pausing it discards valid revenue. I then had the hub send pause requests to servers holding a wider copy. I changed that too: a server that missed the update may miss the request as well. The rule now travels ahead of time, in the head, and the server enforces it.

### 4.3 Who decides what

There is no AI model in this build. That is deliberate: bid-time systems need answers that are fast and consistent, and an audit needs each answer explained clause by clause. AI could help off the decision path, for example by drafting the plain-language impact text from a rule diff, or by flagging unusual acknowledgement delays for a person to review. I have designed those two places and not built them. A person would approve every drafted sentence, and the rule engine would stay the only thing that decides.

| Decision | Rule engine | A person | A machine |
|---|---|---|---|
| Whether a request matches a segment | **Decides** | | |
| Whether a rule change is risky to publish | Warns, in plain words | **Approver decides** | |
| Whether new content goes live | | **A second person approves** | |
| Whether a stale copy is risky | **Classifies** | | |
| Whether a server stops a wider stale copy | Writes the deadline into the head | | **The server, at its deadline** |
| Whether to stop a segment everywhere | Recommends | **One person, with a reason** | Every server, from the head |
| Whether a server holds the current version | | | **Its own `active` acknowledgement** |
| Whether an audience rule needs consent | **Always yes** | | |

### 4.4 What an ad server team has to do

The hub depends on the ad servers. This is the minimum contract, and what they gain from it.

| Step | What the ad server does | Phase |
|---|---|---|
| Read the head | Every 30 seconds, from object storage. Verify the signature | Pilot |
| Pull | When the head is newer, fetch the snapshot by revision, verify the signature, keep the last known good copy | Pilot |
| Report | The revision, the hash, the state (`received`, `accepted`, `active`), the newest head read, and anything stopped locally | Pilot |
| Enforce | Stop revoked segments at once, stop a wider copy of a strict segment at its deadline, stop strict segments if no head can be read for 15 minutes | Enforcement |
| Log | Record the segment version on each impression | Later. Needed for the impression share. The pilot metric below needs only reports |

**What they gain.** One signed source of rules instead of ad hoc pushes, a reference tester to reproduce a complaint, and fewer escalations from AdOps. The cost of logging the version on each impression is the largest ask, which is why it comes last.

### 4.5 What is real, and what is simulated

| Part | Status |
|---|---|
| Rule model, validation, versions, fingerprints, impact warning, four-eyes, roles, tenant isolation, idempotency, exclusion lists, deal bindings | Real, covered by automated tests |
| Estimated change in daily reach | Real logic on simulated traffic. A fixed sample of 2,000 requests is replayed through the old and the new rule and scaled to 20 million impressions a day. The scale is an assumption, not a Media.net figure |
| Snapshots with ETag and delta, the signed head and its stop rules, reports in three states, stale-copy policy, per-instance sync view | Real logic. The clock is simulated so you can move it |
| The ad servers | Simulated. A small simulator plays each server: it reads the head, pulls, fails to reload when you break it, and applies the head's rules to its own copy. It uses only what a real server would have |
| The server | Real when the live address is reachable. There is no database, so state resets on restart. The free host sleeps when idle, so the page starts in a browser simulation and offers a switch when the server wakes |
| Signatures, logins, traffic and ad server clusters | Simulated. Tokens are fixed demo tokens and signatures are a hash with a demo key |

**What production would need.** A database for segments, versions and the audit trail. Object storage or a CDN for signed snapshots and the head. Asymmetric signing with key rotation, so that consumers verify with a public key and cannot forge a snapshot. A real identity provider, and rate limits by service identity rather than by address. A shared set of golden test cases, so that the hub and the real ad servers return the same answer for every rule. The automated tests here are the start of that set.

### 4.6 Security

Security is part of the contract, not a layer on top. Each control below is built and tested, and most can be seen working in the API explorer.

| Control | What it does | See it |
|---|---|---|
| **Authentication** | Every call carries a bearer token. Each server instance has its own machine identity, and a report's sender comes from its token, never from the body | Report as edge_us_1 for edge_mum_1: 403 |
| **Roles** | Writers author, approvers approve, readers read, machines pull and report. People cannot pull the catalog and machines cannot write rules | AdOps pulls the snapshot: 403 |
| **Four-eyes** | Anything that can widen reach needs a second person. The creator of a version cannot approve it, even as admin | AdOps tries to approve: 403. The creator approving as admin: 403 (Tests tab) |
| **Tenant isolation** | A team sees only its own advertisers' segments and lists. Others get 404, not 403, so they cannot even learn a segment exists | Another advertiser's writer: 404 |
| **Integrity** | The head and every snapshot are signed with a body digest, and servers verify before applying. A report carries the hash of what it holds; a mismatch is 409 and the copy is treated as corrupt. A cold start fetches a short-lived signed URL without the bearer token | A wrong hash: 409. A tampered head fails verification (Tests tab) |
| **Safe writes** | Versions are immutable. Idempotency keys replay the first answer and refuse a reused key with a different body. Publish, rollback, stop and list changes need a reason, and every action is in the audit log with who and when | Tests tab, "idempotency" |
| **Privacy** | The hub holds no user profiles. `/match` logs only request ids, outcomes and versions. Audience rules are tagged as needing consent automatically, and no rollback may loosen consent | Tests tab, "persists no user data" |
| **Abuse limits** | Bodies over 200 KB and oversized rules are refused (413), unknown fields get a did-you-mean (400), and calls are rate limited | Explorer: "A typo in a field name" |
| **Off the bid path** | The hub is never called during an auction, so an outage or an attack on the hub cannot slow or change a bid | Story tab: take the hub down for 20 minutes |

**What production adds.** Mutual TLS or OAuth2 client credentials for machines and the company identity provider for people, asymmetric signing with key rotation so servers can verify a copy but never forge one, rate limits per service identity rather than per address, and the audit log in append-only storage.

---

## 5. Success metrics

### Outcome metric, once versions are logged

**Stale-version impression share:** the share of segment-tagged impressions served under a version other than the active one, after the propagation window.

> **Stale-version impression share ≈ share of traffic carried by servers that are behind × fraction of time they are behind**

**Why this one.** It needs one thing from the ad servers: the segment version logged on each impression. It is weighted by traffic, so a heavily loaded cluster being behind counts for more than a quiet one. A version published seconds ago does not count as stale.

**What it overstates.** Most stale versions answer most requests the same way, so it overstates harm. That is why it has a diagnostic.

**The diagnostic.** Replay a sample of anonymised bid requests, 1% overall with a higher floor for low volume deals, through the active version and the stale one, and count where the answers differ. This is the only way to see under-delivery from a narrower copy.

### The pilot version: high-risk stale exposure

The impression share needs the segment version logged on every impression, which is the largest ask. The pilot does not wait for it. It uses what acknowledgements already carry.

> **High-risk stale exposure = Σ over servers holding a wider or unclassified copy of (share of traffic carried × minutes the copy stayed live past a 2 minute propagation window)**

It is measured in traffic-minutes and kept as a running total per incident. A server carrying 10% of traffic that serves a wider copy for 15 minutes past the window adds 1.5. In the demo, edge_sg_1 adds 1.4 before it stops the segment itself. A narrower copy adds nothing, because it cannot reach excluded traffic, and the total stops growing the moment a server stops the segment. The sync board shows it today on simulated data. In the pilot it becomes the north star, and the impression share replaces it once logging exists.

### What moves it

[[VISUAL: metric-tree]]

| Lever | Metric | Why it matters |
|---|---|---|
| Coverage | Share of server instances, and of traffic, whose reports return `active` | If servers do not report, nothing else can be measured |
| Traffic footprint | Share of traffic carried by servers that are behind | Separates a quiet canary from a primary cluster |
| Speed | 95th percentile time from publish to `active` acknowledgement | The window in which drift can exist |
| Detection | Time from a server going stale to an alert | The cost of finding out late |
| Harm | Revenue at risk: high-risk stale impressions times eCPM. Under-delivery from narrower copies on its own line | Separates leaks from lost revenue |
| AdOps effort | Time to create and approve a segment, and AdOps hours per incident | Whether the hub beats the current process |
| API health | 99th percentile latency, error rate, ETag hit rate, adoption | The hub must not become a problem itself |

### Guardrails

The headline is never allowed to improve at the cost of any of these.

| Guardrail | Limit | Why | If breached |
|---|---|---|---|
| Consent violations (demo policy; production needs a privacy component) | **0**, with no grace window | The hard line for any audience rule | Release blocker |
| A snapshot accepted without a valid signature | **0** | The trust model depends on it | Release blocker |
| Narrower stale copies stopped | **0** | Stopping under-delivery destroys valid revenue | Fix the classification |
| A rollback that loosens consent or audience requirements | **0** | An emergency path must not undo a privacy tightening | Release blocker |
| A change that can widen reach, published by one person | **0** | The reason four-eyes exists | Release blocker |
| Unnecessary stops | Under 0.5% of stops (a starting value to test) | An unnecessary stop costs revenue | Tighten the rule or lengthen the deadline for that class |
| Revenue per thousand requests on segmented traffic | No drop | The hub must not cost money | Pause the rollout and investigate |

### No targets yet, by design

I do not set a stale-share target because I do not know the baseline. The first task in shadow mode is to measure it.

| Metric | Prototype today | Shadow mode | Pilot |
|---|---|---|---|
| Acknowledgement coverage | Simulated: 7 of 8 servers report (90% of traffic) | Measure, then agree a level | At least 99% by count and by traffic (a starting value to test) |
| High-risk stale exposure | Simulated, shown on the sync board | Measure from acknowledgement timestamps | Set a target from the baseline. The pilot north star |
| Stale-version impression share | Simulated shares only | Measure the baseline once logging exists | Set a target from the baseline |
| Divergence on the sample | Replay available in `/match` | Measure | Report beside the headline |
| Consent violations | 0 in the scripted tests | 0 | 0 |

### Rollout, with a decision at each gate

| Gate | Scope | Must be true to continue | If it is missed |
|---|---|---|---|
| **Before shadow mode** | Baseline from poll and acknowledgement timestamps alone. No change to impression logging yet | I can measure how long servers take to converge, and drift is visible at all | If no server holds a wider copy past the propagation window, stop building detection and enforcement. Ship only authoring, approval and `/match` |
| **Shadow mode** | Read only. Ingest acknowledgements, compute the metrics, change nothing | A baseline exists, and acknowledgement coverage reaches the agreed level | Fix reporting before asking for more |
| **Pilot** | One team and a handful of segments, with four-eyes on and alerts only. The hub owns one clean new slice, such as new curated deals, or exports to the existing consumer format, so AdOps authors in one place and does not enter every rule twice | AdOps confirms that creating and detecting beat the current process, with no alert storms | Rework the alerts and the board before widening |
| **Enforcement** | Servers enforce the head's deadlines on strict segments, starting with one cluster | Unnecessary stops stay under the limit and revenue per thousand holds | Stay at alerts only |
| **Broaden** | All segments and consumers, and `/match` offered to new consumers | All guardrails green for 60 days | Hold at the current scope |

During the pilot I would compare hub-managed segments with segments managed the existing way, over the same weeks, on stale share, time to detect and incident hours. It is an internal comparison, not a user-facing test.

### What I would build in six weeks

| Week | Scope | Out of scope |
|---|---|---|
| 1 to 2 | Segment and version storage, the rule model with validation, the audit trail, roles | Anything on the bid path |
| 3 | Snapshots with ETag and signature, the head with its stop rules | Asymmetric key rotation beyond one key |
| 4 | Per-instance reports, the stale-copy policy, the sync board | Server-side enforcement, which comes after the pilot |
| 5 | Dry run, impact warning and four-eyes, shadow mode on one team | Logging the version on impressions |
| 6 | Pilot readout against the baseline, and the decision on enforcement | Server-side enforcement and the AI assist |

### What would make me rethink

- Every server converges inside the propagation window in the baseline, and no incident involves a wider stale copy. Then drift is not a real problem at this scale.
- The ad server teams will not log the segment version on impressions. Then the headline metric is out of reach, and I fall back to acknowledgement timing and the sampled replay.
- Acknowledgement coverage cannot reach the agreed level. Then I cannot tell stale from silent, and the sync board misleads.
- AdOps finds creating and approving a segment no faster than today. Then the approval and dry run steps cost more than they save.
- The ad servers and `/match` disagree on more cases than I assume. Then the reference tester cannot be trusted, and shared test cases come before anything else.

### The value case: what must be true

The direct leak in section 3 is small. The value of the hub rests on two other things: the contract value at risk when a client discovers a breach, and the AdOps and engineering time spent on each incident. I do not know how many incidents occur, so the calculator below shows how many the hub would need to prevent each year to cover its cost. Change the numbers.

[[VISUAL: break-even]]

- **What an incident costs in practice.** A buyer who finds their blocklist was not applied on a curated deal can pull the deal's remaining spend, dispute what ran, and question the renewal. I count those, plus the contract at risk, and not the leaked impressions alone.
- **Value per incident avoided** is the campaign value times the share the client withdraws or has credited, plus the hours spent on the incident times an hourly cost.
- **Break-even** is the annual cost to build and run the hub divided by the value per incident.
- **Illustrative defaults.** A ₹25,00,000 campaign, 20% withdrawn or credited, 30 hours at ₹2,000 an hour, and an annual cost of ₹84,00,000. That gives ₹5,60,000 per incident and a break-even of 15 incidents a year. Replace these with Media.net's own figures. The baseline in shadow mode would show whether 15 is plausible.

---

## 6. Assumptions

| Assumption | If it is wrong | How to test it |
|---|---|---|
| Rule definitions can diverge across campaign management, ad serving and reporting | There is nothing for the hub to detect | Shadow mode baseline. Stop if every server converges inside the window |
| Updates reach servers with delay (caches, deploys) | The window in which drift exists is smaller than I think | Measure the 95th percentile time from publish to `active` acknowledgement |
| Segments feed curated deals, matched in the SSP's ad server, with a Deal ID attached | The consumers, and the value of the hub, change | Ask the deal team how a deal's audience is evaluated |
| The auction runs in about 100 ms, so local matching gets a single digit millisecond slice | The hub's design budget is wrong | Public SSP documents describe 100 to 150 ms windows. The single digit slice is my design budget, not a measurement |
| Ad servers and reporting can log the segment version on every impression | The impression share cannot be built | A rollout ask. The pilot runs on high-risk stale exposure, and falls back to sampled replay |
| Roles such as AdOps, approver and ad server team match how Media.net is organised | The users and permissions change | I assumed them. I have not seen Media.net's team structure |
| Each server instance can report for itself | A load balancer or agent reports for a group and hides a stale instance | Built per instance. Confirm the ad server team can report per process |
| Servers can read a small object every 30 seconds and enforce a deadline locally | Nothing stops a wider copy except a person | Ask the ad server team. The cost is one small GET every 30 seconds per server |
| Consent can be reduced to one flag per request | The flag hides jurisdiction differences | A per-jurisdiction check sits behind it in production |

---

## Sources

- Google Ad Manager, how long changes take: https://support.google.com/admanager/answer/79203
- AppNexus 2013 outage postmortem: https://medium.com/xandr-tech/2013-09-17-outage-postmortem-586b19ae4307
- Xandr incident, January 2021: https://status.xandr.com/incidents/sqb0rhtndhkz
- IAB Tech Lab, OpenRTB 2.x specification, from 2.6 onward: https://github.com/InteractiveAdvertisingBureau/openrtb2.x
- IAB Tech Lab, Content Taxonomy 1.0 code list: https://github.com/InteractiveAdvertisingBureau/Taxonomies/blob/main/Content%20Taxonomies/Content%20Taxonomy%201.0.tsv
- IAB Tech Lab, Content Taxonomy versions and the deprecation of 1.0: https://dev.iabtechlab.com/standards/content-taxonomy/
- India, DPDP Rules 2025 and the phased timeline (Storyboard18, 14 November 2025): https://www.storyboard18.com/amp/digital/breaking-govt-notifies-final-dpdp-rules-sets-staggered-rollout-with-key-obligations-for-data-fiduciaries-84201.htm
- IAB Europe, Transparency and Consent Framework: https://iabeurope.eu/transparency-consent-framework/
- IAB Tech Lab, Global Privacy Platform (GPP): https://iabtechlab.com/gpp/
