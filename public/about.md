[[GREETING]]
Hi, I'm Sid. Thanks for taking the time to look at this. This page walks you through how I thought about the problem and what I built over the last two days. The prototype is made to be tried, so please click around. I'd love to talk it through with you.
[[/GREETING]]

# About This Project

**Prototype for the Media.net APM case, Topic 3**

## Segment Hub
*Confirm that every ad server is running the targeting rule that was published.*

Segment Hub is an internal API for targeting segments. A team defines who an ad may reach, tests the rule, publishes it with a second person's approval, and then sees whether every ad server is running that version. It is a control plane: matching at bid speed stays inside the ad servers. When a server is behind, the hub classifies how risky that is and recommends the response, either alert and refresh, or pause.

All data in this prototype is simulated for demonstration. The brand (GlowRoot, a skincare advertiser), the people and the ad server clusters are fictional.

### In 60 seconds

| | |
|---|---|
| **The brief** | Create an internal API for targeting segments. Define key endpoints, request and response formats, and security |
| **The problem** | When a targeting rule changes, nobody can confirm that every ad system is using the new version. My hypothesis is that the buyer can find out before Media.net does |
| **Who uses it** | AdOps builds and publishes segments. An approver reviews new rules. Ad servers pull the rules and report which version they hold |
| **What the hub does** | Keeps one source of truth, numbers every version, collects acknowledgements from ad servers, and classifies a stale copy as low risk or high risk |
| **What it does not do** | Match requests at bid time, score users, or hold user data. There is no AI model in the decision path |
| **Headline metric** | Share of segment-tagged impressions served under a version other than the active one, after the propagation window. The pilot starts with a version I can measure from acknowledgements alone: high-risk stale exposure |
| **Try it** | 1 minute. Open the Story tab and click "Replay the incident". Then run Request 4 and open the Sync board |

---

## 1. The problem I chose to solve

The brief asks for endpoints, request and response formats, and security. It does not state which problem the API should address, so I began by identifying where targeting rules go wrong in practice.

### Pain points, and how I prioritised them

| Pain point | Example | Decision | Reason |
|---|---|---|---|
| The rule is defined wrongly | A client asks for West Bengal and the rule is saved as all of India | **Pain A, addressed** | The cost lands on the client's spend, and it can be prevented before publish |
| The rule cannot be tested before it is live | No way to try the rule on sample traffic | **Folded into Pain A** | The same controls address both: dry run, impact warning, approval, rollback |
| A server runs an old version after a change | One cluster still serves the version before an exclusion list update | **Pain B, addressed. This is the focus** | It is silent, nothing errors, and it can leak outside what the client approved |
| Nobody can prove which version served an impression | A client disputes delivery and the version in force cannot be shown | **Treated as a benefit and a metric input** | It depends on ad servers logging the version on each impression, which the hub does not control |

[[PAIN-LEGEND]]
**Pain A: a wrong rule goes live.** **Pain B: ad servers run an out-of-date rule.**
[[/PAIN-LEGEND]]

**Problem statement.** When a targeting rule changes, nobody can confirm that every ad server is using the new version. My hypothesis is that the buyer can find out before Media.net does, and the pilot tests it.

**What one API can and cannot do.** An API cannot force an ad server to update. It can hold one source of truth, number the versions, collect acknowledgements, identify which servers are behind, classify the risk and request a pause. It cannot repair a server that is down or correct poor location data.

### Approaches considered

| Approach | Pain it addresses | Bid-path risk | Governance | Decision |
|---|---|---|---|---|
| **Segment CRUD service** | Part of A: storage and history. Does not address B | None | Limited: nothing says whether a change widens or narrows a rule | Included as the foundation (endpoints 1 to 3) |
| **Live matching service** | Part of A: testing a rule. Does not address B | High if placed on the bid path, because every bid depends on it and must fit a single digit millisecond slice | Central, but a second matching engine can drift from the ad server's | Kept as a reference tester (`POST /v1/match`). Production matching stays in the ad servers |
| **Control plane with drift detection** | A and B | None. The hub is off the bid path | Versions, approvals, acknowledgements and a stale-copy policy | **Chosen** |

**Why not existing config-distribution or feature-flag tooling.** Those tools move configuration. They do not know whether a change to a targeting rule widens or narrows reach, or that an audience rule needs consent. The hub could sit on top of one as the transport. I have not seen Media.net's tooling, so this is my judgment.

**Why pull with acknowledgements, not push.** A pull is cacheable and scales through deltas and ETags. A push cannot prove that the receiver applied the change. The acknowledgement is the evidence the sync board depends on.

**Where segments sit in the deal stack.** A curated deal packages inventory and data under a Deal ID, and the ad server matches each request against it. IAB Tech Lab's Seller Defined Audiences spec, since renamed Curated Audiences, passes taxonomy coded segments in the bid request. The hub does neither job. It governs the rule that sits behind a Deal ID, so the same rule is the one every system uses. I have not seen how Media.net evaluates a deal today, so this is listed as an assumption in section 6.

**A segment is a rule, not a list of users.** A segment here is region, device, content category, site lists and a consent-gated audience flag. Audience membership arrives from upstream as IDs on the bid request, so the hub governs targeting logic and holds no user profiles.

### What I looked at, and what I took from it

| Source | What it says | What I took |
|---|---|---|
| Google Ad Manager help, how long changes take | Line item changes can take up to 10 minutes, network configuration up to 180 minutes, and blocking a previously approved ad up to 24 hours | Propagation delay is normal. That window is where mixed versions exist |
| AppNexus 2013 outage postmortem | A routine data update exposed a latent bug in the impression bus and reached roughly 900 servers at once. Recovery used a tested snapshot, and the fixes include validation before distribution and reliable return to a known good state | Stage releases, validate before distributing, and keep a tested last known good copy |
| Xandr incident, January 2021 | Impression buses were rolled back to an older configuration, with the first 10% resuming first | A rollback path and a staged restart |
| OpenRTB 2.6 | Defines `device.devicetype`, `device.geo.region`, `site.cat` with `cattax`, `regs.gpp` and `user.consent` | The request format the hub reads |
| IAB Content Taxonomy 1.0 | Beauty is IAB18-1. IAB Tech Lab has deprecated 1.0 and publishes 3.0 | The code is used in the demo only because it is short and readable. A production build would use 3.0 and set `cattax` to match |
| Consent frameworks: India's DPDP Act, EU GDPR with the IAB TCF, US state laws signalled through GPP | DPDP consent obligations phase in by May 2027. The EU is opt-in and granular. Most US state laws are opt-out | Consent is a per-jurisdiction check, not one global flag. The prototype simplifies it to one flag and says so |

These sources establish that propagation delay and bad pushes are real. They do not establish how often drift causes wrong delivery at Media.net, so I treat that as an assumption and measure it first (sections 5 and 6).

---

## 2. Stakeholders

Two groups use the product, one reviews, and the rest are affected by what it does.

| Who | Role | What they need | How the product responds |
|---|---|---|---|
| **AdOps (Priya)**, with account managers requesting changes | Primary user. Builds, tests and publishes. Can roll back or pause alone in an emergency | A correct rule quickly, and confidence that it is what runs | Dry run, a plain-language impact warning, one-step rollback |
| **Approver (Rahul, Meera) and security** | Reviews new rules. Owns roles and the audit trail | A clear view of what a change does to reach, without becoming a bottleneck | Approval is required only for new content. Rollback and pause need no second person, within limits (section 4.2). Every action is logged with a reason |
| **Ad server and deal tagger teams** | Machine users. Pull rules and report what they hold | A small, signed, cacheable bundle, with the hub off the bid path | Signed deltas by revision, ETag, and a last known good copy kept locally |
| **The advertiser (GlowRoot) and reporting** | Affected, not users | Delivery that respects the targeting and exclusions they asked for, and the exact rule version behind a number | Immutable versions, a fingerprint to join on, and detection of a stale copy before the client has to |

---

## 3. The problem in practice

**Who it affects.** AdOps, the ad server teams and the advertisers whose rules they run, wherever targeting rules are changed centrally and served from many places.

**Why it matters.** A rule can be correct where it was written and wrong where it is served. The server holding an old copy keeps serving, nothing errors, and the first to notice could be the buyer, finding their ad on a site they blocked.

### How a stale rule keeps serving

[[VISUAL: problem-flow]]

### A worked example (illustrative numbers, not the seed data)

| | |
|---|---|
| Client request | Exclude the buyer's own list of blocked sites |
| Change | A site is added to the exclusion list at revision 4 |
| One cluster | Still holds revision 3, so it still serves on that site |
| Impressions per hour on that cluster | 5,00,000 |
| Share on the newly excluded site | 4% |
| Hours until someone notices | 6 |
| Impressions served on the excluded site | 1,20,000 |
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
| **Start here. Replay the incident** | Priya | Story tab, click "Replay the incident" and press Next through five steps | A narrowing change is published, one cluster keeps the old rule, and the board classifies it. The whole case in one minute |
| **A. A normal request** | Anyone | Run Requests 1, 2 and 3 on the Story tab | A match at tier 1, a fallback to context only when consent is missing, and an exclusion on a site the buyer blocked |
| **B. A narrower stale copy** | Anyone | Run Request 4 | The Singapore cluster holds an older rule. It under-delivers but does not leak, so the policy is alert and refresh, never pause |
| **C. A wider stale copy** | Anyone | Run Request 5, then open the Sync board | The Mumbai cluster missed an exclusion update. It is high risk, with a pause request and a strict 15 minute expiry countdown |
| **D. Publish with a second person** | Priya, then Rahul | Segments tab, change the rule in the editor, save it as a new version, then click "Run full flow" on that draft | The creator cannot approve or publish. A plain-language impact warning and an estimated change in daily reach appear at submit |
| **E. An emergency** | Priya | Roll back or pause alone, with a reason | It works without a second person, within the limits in 4.2, and the audit log records who and why |
| **F. Cause drift yourself** | Priya | Add a site to the exclusion list, then move the clock forward | A cluster turns stale, the board classifies it, and the countdown to local expiry runs |

Every result shows the version, the reason and the rule it relied on. Versions are never overwritten, so a later change never erases an earlier one.

### 4.1 The seven endpoints, and the pain each one addresses

[[PAIN-LEGEND]]
**Pain A: a wrong rule goes live.** **Pain B: ad servers run an out-of-date rule.**
[[/PAIN-LEGEND]]

| # | Endpoint | Who calls it | What it does | Pain |
|---|---|---|---|---|
| 1 | `POST /v1/segments` | AdOps | Creates a segment as version 1. Validates the rule and adds a consent tag to any audience rule | [[PAIN:A]] |
| 2 | `POST /v1/segments/{id}/versions` | AdOps | Adds a new immutable version. History is never overwritten | [[PAIN:A]] |
| 3 | `GET /v1/segments/{id}` | AdOps, admin, reporting | Shows the active version, drafts and history. With `?include=sync`, shows which servers are in sync, stale or unknown | [[PAIN:B]] |
| 4 | `GET /v1/catalog/snapshot` | Ad servers, deal tagger | One signed bundle of every live segment and list. Delta by revision, ETag, and a manifest to a signed copy on a cold start | [[PAIN:B]] |
| 5 | `POST /v1/segments/{id}/transitions` | AdOps, approver | Submit, approve, publish, rollback, pause, resume. Submit returns the impact in plain words. Pause targets only risky stale copies | [[PAIN:A,B]] |
| 6 | `POST /v1/match` | AdOps, anyone replaying | Which segments a request belongs to, and why. Replays against an older revision or an unpublished version | [[PAIN:A,B]] |
| 7 | `POST /v1/consumers/{id}/acks` | Ad servers, deal tagger | A server reports the revision and hash it holds, and whether it is `received`, `accepted` or `active`. Only `active` counts as in sync | [[PAIN:B]] |

### 4.2 What the hub does when a stale copy turns up

When a new version is published, the hub compares it with the old one on every condition, list and consent rule. That tells it how risky an old copy is.

| What the new version changed | The old copy is | Risk | Hub action | Status |
|---|---|---|---|---|
| Adds a region, or removes a condition or an exclusion | Narrower. Under-delivers | Low | Alert and refresh. Never pause | Built |
| Removes a region, adds a condition, or adds a site to an exclusion list | Wider. Can serve outside the target | High | Request a pause on that server | Built |
| Changes in both directions at once | Mixed, treated as wider | High | Request a pause on that server | Built |
| Requires audience data and consent more strictly | Wider on consent | Critical | Request a pause and escalate to the kill switch immediately. No grace window | Built |
| Changes only priority tiers | Same eligibility, different priority, so yield and pacing can drift | Low | Alert and refresh. Never pause | Built |
| Changes only the name or metadata | Same fingerprint | None | No alert | Built |
| Cannot be compared | Treated as wider | High | Request a pause on that server | Built |
| A server has not reported since a high-risk publish | Unknown | Escalating | After a set time, escalate to the highest alert level and use the kill switch | Design only |

**Pause ownership.** In the prototype a person requests every pause and the server confirms it. In production I would automate a pause only for narrow, well-understood classes, such as a confirmed wider copy on a strict segment, and only after shadow mode has shown the false-pause rate.

**Local expiry and the kill switch.** A segment carries an expiry: 4 hours for standard segments and 15 minutes for strict ones. On expiry, a strict or audience-required segment stops serving, an audience segment falls back to context only, and any other keeps serving with an alert. The kill switch is a small revocation list published to the same object store as the snapshots. Edge servers poll it on a short interval, separately from the snapshot, so it does not depend on the hub API being up. In the prototype the kill switch appears only as the recommended action.

**A hub outage should not expire every segment.** In production, the expiry clock would be renewed by any successful poll of an immutable copy of the latest revision pointer in object storage. An outage of the hub API alone then does not expire anything, and only a server that cannot reach either source does. The prototype counts down from the moment a newer version is published, which is enough to show the behaviour.

**Rollback limits.** One person may roll back alone to a version that was live before, as long as it is not wider than the current one. A rollback that widens reach needs an approver. A rollback that loosens audience or consent requirements is refused, and must be republished as a new version with a second person. This stops an emergency rollback from undoing a privacy tightening.

**A decision I revised.** I first intended to pause any out-of-date server. I changed this because a narrower stale copy only under-delivers, and pausing it discards valid revenue to fix a problem that was not leaking anything.

### 4.3 Who decides what

There is no AI model in this build. That is deliberate: bid-time systems need answers that are fast and consistent, and an audit needs each answer explained clause by clause. AI could help off the decision path, for example by drafting the plain-language impact text from a rule diff, or by flagging unusual acknowledgement delays for a person to review. I have designed those two places and not built them. A person would approve every drafted sentence, and the rule engine would stay the only thing that decides.

| Decision | Rule engine | A person | A machine |
|---|---|---|---|
| Whether a request matches a segment | **Decides** | | |
| Whether a rule change is risky to publish | Warns, in plain words | **Approver decides** | |
| Whether new content goes live | | **A second person approves** | |
| Whether a stale copy is risky | **Classifies** | | |
| Whether to pause a risky stale copy | Recommends | **AdOps requests** | Ad server confirms |
| Whether a server holds the current version | | | **Its own `active` acknowledgement** |
| Whether an audience rule needs consent | **Always yes** | | |

### 4.4 What an ad server team has to do

The hub depends on the ad servers. This is the minimum contract, and what they gain from it.

| Step | What the ad server does | Phase |
|---|---|---|
| Pull | Fetch the snapshot by revision, verify the signature, keep the last known good copy | Pilot |
| Acknowledge | Report the revision, the hash and the state (`received`, `accepted`, `active`) | Pilot |
| Obey | Honour pause requests and the revocation list | Enforcement |
| Log | Record the segment version on each impression | Later. Needed for the impression share. The pilot metric below needs only acknowledgements |

**What they gain.** One signed source of rules instead of ad hoc pushes, a reference tester to reproduce a complaint, and fewer escalations from AdOps. The cost of logging the version on each impression is the largest ask, which is why it comes last.

### 4.5 What is real, and what is simulated

| Part | Status |
|---|---|
| Rule model, validation, versions, fingerprints, impact warning, four-eyes, roles, tenant isolation, idempotency | Real, covered by automated tests |
| Estimated change in daily reach | Real logic on simulated traffic. A fixed sample of 2,000 requests is replayed through the old and the new rule and scaled to 20 million impressions a day. The scale is an assumption, not a Media.net figure |
| Snapshots with ETag and delta, acknowledgements in three states, stale-copy policy, local expiry | Real logic. The clock is simulated so you can move it |
| The server | Real when the live address is reachable. There is no database, so state resets on restart. The free host sleeps when idle, so the page starts in a browser simulation and offers a switch when the server wakes |
| Signatures, logins, traffic and ad server clusters | Simulated. Tokens are fixed demo tokens and signatures are a hash with a demo key |

**What production would need.** A database for segments, versions and the audit trail. Object storage or a CDN for signed snapshots and the revocation list. Asymmetric signing with key rotation, so that consumers verify with a public key and cannot forge a snapshot. A real identity provider, and rate limits by service identity rather than by address. A shared set of golden test cases, so that the hub and the real ad servers return the same answer for every rule. The automated tests here are the start of that set.

---

## 5. Success metrics

### Headline metric

**Stale-version impression share:** the share of segment-tagged impressions served under a version other than the active one, after the propagation window.

> **Stale-version impression share ≈ share of traffic carried by servers that are behind × fraction of time they are behind**

**Why this one.** It needs one thing from the ad servers: the segment version logged on each impression. It is weighted by traffic, so a heavily loaded cluster being behind counts for more than a quiet one. A version published seconds ago does not count as stale.

**What it overstates.** Most stale versions answer most requests the same way, so it overstates harm. That is why it has a diagnostic.

**The diagnostic.** Replay a sample of anonymised bid requests, 1% overall with a higher floor for low volume deals, through the active version and the stale one, and count where the answers differ. This is the only way to see under-delivery from a narrower copy.

### The pilot version: high-risk stale exposure

The impression share needs the segment version logged on every impression, which is the largest ask. The pilot does not wait for it. It uses what acknowledgements already carry.

> **High-risk stale exposure = Σ over servers holding a wider or unclassified copy of (share of traffic carried × minutes behind)**

It is measured in traffic-minutes. A server carrying 38% of traffic that is 60 minutes behind adds 22.8. It is zero when every server holds the active version, and a narrower copy adds nothing because it cannot leak. The sync board shows it today on simulated data. In the pilot it becomes the north star, and the impression share replaces it once logging exists.

### What moves it

[[VISUAL: metric-tree]]

| Lever | Metric | Why it matters |
|---|---|---|
| Coverage | Share of consumers whose acknowledgements return `active` | If servers do not report, nothing else can be measured |
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
| Consent violations | **0**, with no grace window | The hard line for any audience rule | Release blocker |
| A snapshot accepted without a valid signature | **0** | The trust model depends on it | Release blocker |
| Narrower stale copies paused | **0** | Pausing under-delivery destroys valid revenue | Fix the classification |
| A rollback that loosens consent or audience requirements | **0** | An emergency path must not undo a privacy tightening | Release blocker |
| New content published without a second person | **0** | The reason four-eyes exists | Release blocker |
| False pauses | Under 0.5% (a starting value to test) | An unnecessary pause costs revenue | Tighten the rule, and lower the cap on how many servers can be paused together |
| Revenue per thousand requests on segmented traffic | No drop | The hub must not cost money | Pause the rollout and investigate |

### No targets yet, by design

I do not set a stale-share target because I do not know the baseline. The first task in shadow mode is to measure it.

| Metric | Prototype today | Shadow mode | Pilot |
|---|---|---|---|
| Acknowledgement coverage | Simulated: 3 of 4 consumers confirmed | Measure, then agree a level | At least 99% (a starting value to test) |
| High-risk stale exposure | Simulated, shown on the sync board | Measure from acknowledgement timestamps | Set a target from the baseline. The pilot north star |
| Stale-version impression share | Simulated shares only | Measure the baseline once logging exists | Set a target from the baseline |
| Divergence on the sample | Replay available in `/match` | Measure | Report beside the headline |
| Consent violations | 0 in the scripted tests | 0 | 0 |

### Rollout, with a decision at each gate

| Gate | Scope | Must be true to continue | If it is missed |
|---|---|---|---|
| **Before shadow mode** | Baseline from poll and acknowledgement timestamps alone. No change to impression logging yet | I can measure how long servers take to converge, and drift is visible at all | If every server always converges inside the propagation window, stop. The problem is too small for its own product |
| **Shadow mode** | Read only. Ingest acknowledgements, compute the metrics, change nothing | A baseline exists, and acknowledgement coverage reaches the agreed level | Fix reporting before asking for more |
| **Pilot** | One team and a handful of segments, with four-eyes on and alerts only. The hub owns one clean new slice, such as new curated deals, or exports to the existing consumer format, so AdOps authors in one place and does not enter every rule twice | AdOps confirms that creating and detecting beat the current process, with no alert storms | Rework the alerts and the board before widening |
| **Enforcement** | Pause requests for confirmed high-risk stale copies only, with a cap on how many servers can be paused together, and local expiry on | False pauses stay under the limit and revenue per thousand holds | Stay at alerts only |
| **Broaden** | All segments and consumers, and `/match` offered to new consumers | All guardrails green for 60 days | Hold at the current scope |

During the pilot I would compare hub-managed segments with segments managed the existing way, over the same weeks, on stale share, time to detect and incident hours. It is an internal comparison, not a user-facing test.

### What I would build in six weeks

| Week | Scope | Out of scope |
|---|---|---|
| 1 to 2 | Segment and version storage, the rule model with validation, the audit trail, roles | Anything on the bid path |
| 3 | Snapshots with ETag, signature and revocation list | Asymmetric key rotation beyond one key |
| 4 | Acknowledgements, the stale-copy policy, the sync board | Per pod reporting |
| 5 | Dry run, impact warning and four-eyes, shadow mode on one team | Logging the version on impressions |
| 6 | Pilot readout against the baseline, and the decision on enforcement | Pause enforcement and the AI assist |

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
| One acknowledgement per consumer is sufficient | A cluster hides a few pods that failed to reload | Report per pod and show "n of m pods" on the board |
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
- IAB Tech Lab, Global Privacy Protocol (GPP): https://iabtechlab.com/gpp/
