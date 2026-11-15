# Snack Counter Automation (Framsikt take-home)

Automates refilling the Oslo and Bengaluru snack counters:
- who is asked to buy;
- making sure only one person buys;
- handing the job on if they don't;
- the budget check;
- reimbursement through the external HR system;
- one monthly spend report across NOK and INR.

- **Live interactive demo:** https://framsikt.arpitabhyankar.com (fallback: https://framsikt-snack-demo.vercel.app). A Vite + React page that drives the real core in `src/` (see `demo/`).
- **Design:** [DESIGN.md](DESIGN.md) (2 pages)
- **Why each choice was made:** [DECISIONS.md](DECISIONS.md)
- **Requirements analysis:** [docs/00-analysis.md](docs/00-analysis.md)

## Run

Requires Node 20+.

```bash
npm install
npm test          # 31 tests
npm run typecheck
```

## Code map

| File | What it is |
|---|---|
| `src/snackService.ts` | The refill lifecycle: report empty, offer, accept/decline, purchase, HR claim, timers (`tick`), claim sync |
| `src/roster.ts` | Volunteers, daily check-ins per office, fair candidate ranking |
| `src/budget.ts` | Budget check per office and per office-local month (reserve → settle → release, derived from refills) |
| `src/refillStore.ts` | Storage with the two concurrency guarantees: one active refill per office, compare-and-set on version |
| `src/report.ts` | Monthly management report, per office in local currency, plus a total in NOK (or INR) |
| `src/money.ts` | Integer minor-unit money that refuses to mix currencies |
| `src/ports.ts` | Interfaces for the chat tool, HR system and FX rates |
| `src/fakes.ts` | Simulated chat tool, HR system (with failure injection) and FX table |
| `src/time.ts` | Injected clock + office-local dates |
| `src/setup.ts` | Office config from the brief, plus wiring |

## Tests → rules

| Test file | Rules proven |
|---|---|
| `test/lifecycle.test.ts` | Full empty → reimbursed flow. Duplicate empty reports. Two people cannot both commit (broadcast race, direct offer, stale compare-and-set write). A refill nobody completes is handed to someone else (no reply, decline, committed but never bought). Broadcast → escalation. |
| `test/selection.test.ts` | Fair choice (money owed, then refill count). Absent/inactive people skipped. Visitors can refill and are charged to the visited office. Debts compared across currencies. |
| `test/budget-and-report.test.ts` | Exact money arithmetic. Reserve/settle/release. Approval when the budget is low. Overspend flagged. Wrong-currency receipt rejected. Office-time-zone month boundary. Report totals across both currencies. |
| `test/claims.test.ts` | Exactly one HR claim per refill (retry on outage, no blind retry on timeout). Rejection handling. 10-day nudge. |

## Demo (optional)

```bash
cd demo && npm install && npm run dev
```

The demo has no logic of its own: it imports `src/` directly and wires it to an in-browser simulated chat and HR system, plus buttons to move time forward.
