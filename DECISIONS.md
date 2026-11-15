# Decision log

Every non-obvious choice, with the reason for it and the alternatives we rejected. This doubles as the walkthrough script.

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | Directed assignment (system picks one person) with an accept deadline, then a broadcast fallback | Root cause of "box empty for days" is the bystander effect. One named owner + a timer fixes it. | Pure broadcast "who can go?", which recreates the bystander effect |
| D2 | At most one active refill per office; commit via compare-and-set on a version number | Makes "two people buy same day" impossible by construction, not by convention | Locks / mutexes (don't survive multiple instances); "check then write" (race) |
| D3 | Money in integer minor units (øre/paise), always paired with its currency | Floats lose cents; currencies must never be mixed implicitly | `double` |
| D4 | Budget: reserve an estimate at commit, settle the actual at receipt, release on abandon | A check at receipt time is too late; the money is already spent | Check only after purchase |
| D5 | Charge the budget of the office where the snacks are, in receipt currency; HR converts to payroll currency | Budgets are per counter, and HR already owns payroll conversion | Converting ourselves before sending to HR (double conversion, wrong owner) |
| D6 | Store original amounts. Convert only in the report, recording the rate + date used | Auditability; rates change | Storing converted amounts |
| D7 | Idempotency key per refill for HR claims; store HR claim ID | A retry after timeout must not create a second real-money claim | Fire-and-forget |
| D8 | Selection order: lowest outstanding money → fewest recent refills → oldest last refill → ID | Directly targets "few people do most refills and wait weeks" | Random / round-robin only |
| D9 | No heap or fancy structures for selection: sort ≤20 people per decision | n is tiny; recomputing avoids stale state; simpler to explain and test | Priority queue (premature optimization) |
| D10 | Modular monolith with ports and adapters (Chat, HR, Clock, FX) | Same boundaries as future services, with zero distributed-systems cost; fakes make tests deterministic | Real microservices for a 35-person snack box |
| D11 | Injected Clock; timeouts evaluated by a `tick(now)` call | Deterministic tests, no sleeps | Real timers in the core |
| D12 | Month = purchase date in the office's local time zone | Oslo and Bengaluru months start at different instants | UTC month (wrong for both) |

| D13 | TypeScript (Node 24) + Vitest, no runtime deps | Matches Framsikt's Angular/TS side; my strongest language, so I can explain every line; fast feedback loop | C#/.NET (matches backend, but higher risk to defend live in limited time) |

| D14 | Budget spend is derived from refills (COMMITTED counts the estimate, purchased counts the actual), not a separate running total | One source of truth: an abandoned commitment releases its reservation automatically; nothing can drift | A separate ledger that must be kept in sync on every transition |
| D15 | Low budget: block *before* (coordinator approval needed when remaining < typical refill); overspend *after* purchase is only flagged | Before purchase we can still stop the spend; after, the money is gone and the volunteer must still be paid | Hard block at receipt (punishes the volunteer) |
| D16 | HR `unavailable` → retry on tick; HR `timeout` → stop, coordinator reconciles by our reference | A timeout may have created the claim; blind retry could pay twice. Real money beats automation | Always retry (duplicate claims) / never retry (stuck claims) |
| D17 | Availability = daily chat check-in per office; no check-in = not asked | No calendar/leave source assumed; covers home days, holidays, visitors with one concept | Assume everyone available (asks people on holiday) |
| D18 | Accept window 2h, purchase window 24h, 3 direct offers, broadcast escalates after 4h, HR nudge at 10 days | Same-day refill is realistic; 10 days = HR's stated max. All configurable | — |
| D19 | Receipt must be in the office currency | Snacks for a counter are bought locally; catches typos/wrong office | Accept any currency and convert (hides mistakes) |

_Framsikt did not reply to the questions before the deadline, so all 10 assumptions in DESIGN.md §6 stand._
