# Framsikt — Snack Counter Automation: Requirements Analysis

Source: `docs/assignment.pdf` + Anisha's email (Sat 14 Nov 2026).
**Deadline: 9 PM IST, Sun 15 Nov 2026.**

---

## 1. What they are actually testing

Read the role page (app.flexiple.com/jobs/13220) next to the assignment:

| Role page says | What it means for this assignment |
|---|---|
| C#/.NET, Angular, TS, SQL Server, Azure | Language choice is a signal. C# or TS lands best. |
| "Decomposing the monolith into microservices with clear service boundaries" | Design doc must show **clean boundaries + data ownership per part**. ("main parts and the data each part keeps" is literally this.) |
| "Unit, integration and module-level tests… no separate QA" | Tests are a first-class deliverable, not an afterthought. |
| "Protecting reliability for statutory customer deadlines" | Idempotency, concurrency, money correctness, failure handling. |
| "Use AI tools thoughtfully" + "you must explain everything" | Small, sharp, explainable code > big clever code. |
| "Asking questions is part of the exercise" | Questions are graded. Ask few, sharp, with our default assumption attached. |
| "Clear reasoning matters more than how much you complete" | Trade-offs + "what we deliberately won't build" carry real weight. |

**Their real question:** *Can this person take a fuzzy human-process problem, find the real failure modes, model them as a small correct system, and defend each choice?*

**About "optimize with DSA":** our honest take is that this is mostly the wrong lever here.
Scale is 35 volunteers and about 10 refills a month per office. A heap or a trie adds nothing at that size, and adding one anyway reads as poor judgment. The hard parts are **correctness under concurrency, money, time and failure**. That is where we spend our effort. We will still use the right structures (state machine, append-only ledger, compare-and-set, idempotency keys), and we will say why.

---

## 2. Problem → root cause → mechanism

| Stated problem | Root cause | Mechanism we build |
|---|---|---|
| Box empty for days | Bystander effect: no single owner, no timer | **Directed assignment**: the system picks ONE person, with an accept deadline, then falls back. Escalation if nobody accepts. |
| Two people buy same day | No shared "someone's on it" lock | **One active refill per office** + atomic commit (compare-and-set / version check). The second person gets "already taken by X". |
| Few people do most refills, wait weeks for money | Self-selection + no visibility + manual claim submission | **Fairness-aware selection** (fewest recent refills, lowest money currently outstanding). **Auto-submit claim** the moment a receipt is uploaded. Track claim status and nudge. |
| Nobody knows monthly spend / what's eaten | No records | **Append-only ledger** per office in original currency. **Monthly report** converted to one currency. Refill interval works as a consumption signal, plus optional item tags. |

---

## 3. Hidden traps (where most candidates will be sloppy)

1. **Money as float.** Use integer minor units (øre, paise) or `decimal`. Never `double`.
2. **Two currencies, three meanings.**
   - Budget currency = the office's currency (NOK / INR).
   - Receipt currency = the currency of the shop where the snacks were bought.
   - Payroll currency = the currency of the employee's home office (HR's problem).
   - An Oslo employee visiting Bengaluru buys in INR, which is **charged to Bengaluru's INR budget** and reimbursed by HR in NOK. We send HR the receipt amount in INR and HR converts.
   - The management report needs **one** currency, so we need an FX rate source and an FX date. We store the original amount and convert only when reporting, recording the rate we used.
3. **Month boundary + time zones.** Oslo (CET/CEST) and Bengaluru (IST) months start at different instants. Which month does a purchase count in: the purchase date, the claim date or the approval date? We pick the purchase date in the office's local time.
4. **Budget check timing.** If we check only at receipt time, the money is already spent. We **reserve an estimate at commit time** and settle the actual amount at receipt. Reservations are released if the refill is abandoned.
5. **Duplicate claims to HR.** A retry after a network timeout could create two reimbursement claims, which is real money. We use an idempotency key per refill and store HR's claim ID. An outbox-style "submit once" guard prevents the second claim.
6. **Double-click / duplicate chat events.** Every command is idempotent.
7. **Abandoned refill.** Two separate timeouts:
   - an accept timeout (offer not answered), which moves to the next candidate;
   - a purchase timeout (accepted but never bought), which reassigns and releases the reservation.
8. **Availability is unknown.** Hybrid work and holidays mean people are not always in the office. If no system tells us presence, volunteers self-declare via chat, and silence counts as "not available".
9. **Visitors.** A person from the other office who is on site for a week is a valid candidate for that office's counter.
10. **Claim rejected by HR.** The volunteer is out of pocket, so this needs a path back: notify, allow resubmission, escalate to the coordinator.
11. **Over budget at month end.** Possible policies: leave the box empty, allow it with approval, or allow it and flag it. This is a policy question, so we ask.
12. **Testability of time.** All logic takes an injected `Clock`, so the tests stay deterministic (no `sleep`).

---

## 4. Refill lifecycle (draft state machine)

```
            report empty (anyone, idempotent)
                     │
                     ▼
               ┌──────────┐  offer to best candidate (accept window)
               │  OPEN    │──────────────────────────┐
               └──────────┘                          │
                     ▲  decline / accept-timeout     ▼
                     │  → next candidate       ┌──────────┐
                     └─────────────────────────│ OFFERED  │
                                               └──────────┘
                                                     │ accept (CAS: only one wins)
                                                     ▼            reserve est. budget
                                               ┌──────────┐
       purchase-timeout → release, re-offer ◄──│COMMITTED │
                                               └──────────┘
                                                     │ upload receipt (amount, currency, image)
                                                     ▼            settle actual vs reservation
                                               ┌──────────┐
                                               │PURCHASED │  (box restocked)
                                               └──────────┘
                                                     │ auto-submit to HR (idempotent)
                                                     ▼
                                               ┌──────────┐   rejected → notify, resubmit / escalate
                                               │ CLAIMED  │──────────────┐
                                               └──────────┘              ▼
                                                     │ approved     ┌──────────┐
                                                     ▼              │ REJECTED │
                                               ┌──────────┐         └──────────┘
                                               │REIMBURSED│
                                               └──────────┘
```

Invariant: **at most one refill per office in {OPEN, OFFERED, COMMITTED}.**
After PURCHASED the box is full again, so a new empty report can open a new refill even while the claim is still pending at HR.

---

## 5. Main parts (modules = future service boundaries)

| Module | Owns (data) | Talks to |
|---|---|---|
| **Refills** | Refill (id, office, state, assignee, offer history, deadlines, version) | Roster, Budget, Claims, Chat port |
| **Roster / Volunteers** | Volunteer (employeeId, chatId, homeOffice, payrollCurrency, availability per office/date, stats) | — |
| **Budget / Ledger** | Office budget per month; append-only entries (reserve, settle, release) in minor units | — |
| **Claims** | Claim (refillId, idempotencyKey, hrClaimId, status, amount, currency) | HR port |
| **Reporting** | Read-only. FX rates used. | Ledger, Claims |
| **Ports (adapters)** | `ChatPort`, `HrPort`, `Clock`, `FxRates`, each with a fake for tests | — |

This is a **modular monolith** with ports and adapters. We say explicitly that each module could become a service and how. That speaks directly to their monolith → microservices work, without the cost of building distributed infrastructure for a 35-person snack box.

---

## 6. Choosing who buys (selection)

Filter to eligible people:
- volunteers at this office today, including visitors;
- marked available;
- not already declined/timed out on this refill.

Rank them by:
1. **outstanding money** (unreimbursed amount, normalised): lowest first. This directly fixes "few people wait weeks".
2. **refills in the last 30 days**: fewest first (fairness).
3. **last refill time**: oldest first (round-robin tiebreak).
4. stable tiebreak on ID, so tests are deterministic.

A sort over at most 20 people is O(n log n), which is trivial. We say why there is no heap: n is tiny and recomputing every time avoids stale state.

Fallback: after K directed offers fail, we **broadcast** to everyone available, and the first accept wins (same compare-and-set). If still nobody accepts, we escalate to the office coordinator.

---

## 7. What we deliberately will NOT build (and why)

- OCR on receipts: unreliable and costly. The volunteer types the amount, and the image goes to HR.
- Inventory sensors / IoT scales: hardware cost far exceeds the problem.
- A real chat bot, real HR integration, UI or auth: simulated ports, as the brief asks.
- Distributed microservices, message broker, DB: the modules are in-process and in-memory, with boundaries designed so they could be split.
- Live FX feeds: one injected rate table.
- Item-level consumption analytics: refill interval is a good-enough proxy, with optional tags.

---

## 8. Open questions → send to Anisha (see `questions-email.md`)

Each question carries our default assumption, so we are never blocked waiting for an answer.
