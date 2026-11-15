import { useState } from 'react';
import type { OfficeId, Refill, RefillState } from '../../src/domain';
import { format, money } from '../../src/money';
import { monthlyReport } from '../../src/report';
import { DAY, HOUR, localMonth } from '../../src/time';
import { PEOPLE, createDemo, type Demo, type Location } from './engine';

const nameOf = (id?: string) =>
  PEOPLE.find((p) => p.id === id)?.name ?? (id?.endsWith('coordinator') ? `${id.startsWith('oslo') ? 'Oslo' : 'Bengaluru'} coordinator` : id ?? '');

/** Show people's names instead of ids in text coming from the core. */
const withNames = (text: string) => PEOPLE.reduce((acc, p) => acc.replace(new RegExp(`\\b${p.id}\\b`, 'g'), p.name), text);

const STEPS = ['Empty', 'Offered', 'Committed', 'Purchased', 'Claim at HR', 'Reimbursed'];
const stepOf: Record<RefillState, number> = {
  AWAITING_BUDGET_APPROVAL: 0,
  OFFERED: 1,
  BROADCAST: 1,
  COMMITTED: 2,
  PURCHASED: 3,
  CLAIM_NEEDS_RECONCILIATION: 3,
  CLAIM_SUBMITTED: 4,
  CLAIM_REJECTED: 4,
  REIMBURSED: 5,
};

const fmtTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);

type Toast = { ok: boolean; text: string } | null;

type ScenarioKey = 'empty' | 'double' | 'fair' | 'spend';
const PROBLEMS: { key: ScenarioKey; problem: string; fix: string }[] = [
  { key: 'empty', problem: 'Box sits empty for days', fix: 'One named person is asked, with a 2h deadline. No answer → next person → everyone → coordinator.' },
  { key: 'double', problem: 'Two people buy on the same day', fix: 'Only one active refill per office, and an atomic commit: the second person is told it is already taken.' },
  { key: 'fair', problem: 'Same few people pay and wait weeks', fix: 'Whoever is owed the least goes first. Claims go to HR automatically when the receipt is uploaded.' },
  { key: 'spend', problem: 'Nobody knows the monthly spend', fix: 'Every purchase is recorded in its own currency; one monthly report converts both offices to NOK.' },
];

/** Accept + upload receipt for the person currently offered the refill. */
function completeOffered(d: Demo, o: OfficeId, amountMajor: number) {
  const r = d.service.reportEmpty(o, 'any-employee');
  const who = r.offeredTo!;
  d.service.accept(r.id, who);
  d.service.recordPurchase(r.id, who, { amount: money(amountMajor, d.offices[o].currency), receiptImage: `receipt-${r.id}.jpg` });
  return { id: r.id, who };
}

export default function App() {
  const [demo, setDemo] = useState<Demo>(() => createDemo());
  const [, setTick] = useState(0);
  const [toast, setToast] = useState<Toast>(null);
  const [amounts, setAmounts] = useState<Record<OfficeId, string>>({ OSLO: '850', BLR: '2200' });
  const [hrFail, setHrFail] = useState<'none' | 'unavailable' | 'timeout'>('none');

  const refresh = () => setTick((t) => t + 1);
  const say = (ok: boolean, text: string) => {
    setToast({ ok, text: withNames(text) });
    refresh();
  };
  const result = (r: { ok: boolean; reason?: string }, okText: string) => say(r.ok, r.ok ? okText : `Rejected: ${r.reason}`);

  const { service, store, clock, offices, roster, hr, chat, location } = demo;
  const now = clock.now();

  const advance = (ms: number, label: string) => {
    clock.advance(ms);
    demo.applyCheckIns();
    service.tick();
    service.syncClaims();
    say(true, `⏩ ${label}: timers checked (offers, purchases, broadcasts, HR retries, HR status).`);
  };

  const setLoc = (id: string, loc: Location) => {
    location.set(id, loc);
    demo.applyCheckIns();
    refresh();
  };

  /** Each scenario starts from a fresh, clean state so the result is always the same. */
  const runScenario = (key: ScenarioKey) => {
    const d = createDemo();
    const s = d.service;
    let msg = '';
    if (key === 'empty') {
      const r = s.reportEmpty('OSLO', 'any-employee');
      const first = r.offeredTo!;
      d.clock.advance(2 * HOUR);
      d.applyCheckIns();
      s.tick();
      msg = `▶ Oslo box reported empty → ${first} was asked. ${first} did not answer within 2h, so the system automatically asked ${d.store.get(r.id)!.offeredTo}. Nobody can assume "someone else will do it".`;
    } else if (key === 'double') {
      const r = s.reportEmpty('OSLO', 'any-employee');
      const a = r.offeredTo!;
      const b = PEOPLE.find((p) => p.home === 'OSLO' && p.id !== a)!.id;
      const ra = s.accept(r.id, a);
      const rb = s.accept(r.id, b);
      msg = `▶ ${a} and ${b} both tap "accept" at the same moment. ${a}: ${ra.ok ? 'committed ✅' : ra.reason}. ${b}: ${rb.ok ? 'committed' : `❌ ${rb.reason}`}. The office channel is also told who is buying.`;
    } else if (key === 'fair') {
      const first = completeOffered(d, 'OSLO', 900);
      const next = s.reportEmpty('OSLO', 'any-employee');
      msg = `▶ ${first.who} bought snacks for 900 NOK and is waiting for HR (claim sent automatically). Next time the box is empty, ${next.offeredTo} is asked instead, because ${first.who} is still owed money. See "Next pick" in the Oslo card.`;
    } else {
      const o = completeOffered(d, 'OSLO', 900);
      const b = completeOffered(d, 'BLR', 2400);
      for (const id of [o.id, b.id]) d.hr.decide(d.store.get(id)!.claim!.hrClaimId!, 'APPROVED');
      s.syncClaims();
      msg = '▶ One refill in each office: 900 NOK in Oslo, 2 400 INR in Bengaluru. Both claims approved by HR. The monthly report below shows each office in its own currency and a total of 1 200 NOK (2 400 INR × 0.125).';
    }
    setDemo(d);
    setHrFail('none');
    say(true, msg);
  };

  const currentRefill = (o: OfficeId): Refill | undefined =>
    store.activeFor(o) ?? store.all().filter((r) => r.officeId === o).at(-1);

  const report = monthlyReport(localMonth(now, 'Europe/Oslo'), offices, store.all(), demo.fx, 'NOK');
  const claims = store.all().filter((r) => r.purchase).reverse();

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>🍪 Snack Counter Automation</h1>
          <p className="sub">
            Interactive demo running the <b>same TypeScript core</b> that the 31 automated tests prove. Chat and HR are simulated, exactly as in
            the tests.{' '}
            <a href="https://github.com/appie1702/framsikt-snack-counter" target="_blank" rel="noreferrer">
              Code &amp; design →
            </a>
          </p>
        </div>
        <div className="clock">
          <div>🇳🇴 {fmtTime(now, 'Europe/Oslo')}</div>
          <div>🇮🇳 {fmtTime(now, 'Asia/Kolkata')}</div>
          <div className="row">
            <button onClick={() => advance(2 * HOUR, '+2 hours')}>+2h</button>
            <button onClick={() => advance(DAY, '+1 day')}>+1 day</button>
            <button onClick={() => advance(11 * DAY, '+11 days')}>+11 days</button>
            <button
              className="ghost"
              onClick={() => {
                setDemo(createDemo());
                setToast(null);
                setHrFail('none');
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </header>

      <section className="problems">
        {PROBLEMS.map((p, i) => (
          <div className="prob" key={p.key}>
            <div className="pNum">Problem {i + 1}</div>
            <div className="pTitle">❌ {p.problem}</div>
            <div className="pFix">✅ {p.fix}</div>
            <button className="primary" onClick={() => runScenario(p.key)}>
              ▶ Show me
            </button>
          </div>
        ))}
      </section>

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'bad'}`}>{toast.text}</div>}

      <details className="try">
        <summary>More things to try yourself</summary>
        <ol>
          <li><b>Happy path:</b> Report empty → Accept → Upload receipt → approve in the HR panel.</li>
          <li><b>No double buying:</b> Report empty, then hit <i>⚡ Two people accept at once</i>. Only one wins.</li>
          <li><b>Nobody completes it:</b> Accept, then <i>+1 day</i> without a receipt. The refill is handed to the next person.</li>
          <li><b>Fairness:</b> after a refill, whoever is still owed money drops down the "next pick" list.</li>
          <li><b>Visitors:</b> move Ola to the Bengaluru office. He can refill there, charged in INR to Bengaluru's budget.</li>
          <li><b>HR failures:</b> set "next HR call" to <i>timeout</i> before uploading a receipt. No blind retry; the coordinator is asked to reconcile.</li>
        </ol>
      </details>

      <section className="offices">
        {(['OSLO', 'BLR'] as OfficeId[]).map((o) => {
          const office = offices[o];
          const r = currentRefill(o);
          const active = r && store.activeFor(o)?.id === r.id;
          const used = service.budget.used(o, localMonth(now, office.timeZone));
          const pct = Math.min(100, (used.minor / office.monthlyBudget.minor) * 100);
          const ranked = roster.rankCandidates(o, now, new Set(active ? r!.passedOver : []), (id) => service.statsFor(id));
          const step = r ? stepOf[r.state] : -1;
          const eligible = PEOPLE.filter((p) => roster.isEligible(p.id, o, now));

          return (
            <div className="card" key={o}>
              <div className="cardHead">
                <h2>{o === 'OSLO' ? '🇳🇴 Oslo' : '🇮🇳 Bengaluru'}</h2>
                <span className="muted">{office.currency} · budget {format(office.monthlyBudget)}/month</span>
              </div>

              <div className="budget">
                <div className="bar">
                  <div className={`fill ${pct >= 100 ? 'over' : pct > 85 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="muted small">
                  Used or reserved this month: <b>{format(used)}</b> · remaining {format(service.budget.remaining(o, now))}
                </div>
              </div>

              <div className="steps">
                {STEPS.map((s, i) => (
                  <div key={s} className={`step ${r && i < step ? 'done' : ''} ${r && i === step ? 'now' : ''}`}>
                    {s}
                  </div>
                ))}
              </div>

              <div className="refill">
                {!active && (
                  <>
                    <p className="muted">
                      {r ? `Last refill ${r.id}: ${r.state.replaceAll('_', ' ').toLowerCase()}. Box is full.` : 'Box is full.'}
                    </p>
                    <button className="primary" onClick={() => {
                      const created = service.reportEmpty(o, 'any-employee');
                      say(true, created.state === 'AWAITING_BUDGET_APPROVAL'
                        ? `📦 ${created.id}: budget too low, coordinator asked to approve.`
                        : `📦 ${created.id} opened → ${created.offeredTo ? `offered to ${nameOf(created.offeredTo)}` : 'broadcast to everyone'}.`);
                    }}>
                      📦 Report box empty
                    </button>
                  </>
                )}

                {active && r && (
                  <>
                    <div className="state">
                      <span className={`pill s-${r.state}`}>{r.state.replaceAll('_', ' ')}</span> <span className="muted">{r.id}</span>
                      {r.escalated && <span className="pill alert">coordinator alerted</span>}
                    </div>

                    {r.state === 'AWAITING_BUDGET_APPROVAL' && (
                      <button className="primary" onClick={() => result(service.approveOverBudget(r.id, office.coordinatorId), 'Coordinator approved the refill.')}>
                        ✅ Coordinator approves
                      </button>
                    )}

                    {r.state === 'OFFERED' && (
                      <>
                        <p>
                          Asked <b>{nameOf(r.offeredTo)}</b> · answer by {fmtTime(r.offerExpiresAt!, office.timeZone)} (offer {r.directOffers} of 3)
                        </p>
                        <div className="row">
                          <button className="primary" onClick={() => result(service.accept(r.id, r.offeredTo!), `${nameOf(r.offeredTo)} committed.`)}>
                            Accept as {nameOf(r.offeredTo)}
                          </button>
                          <button onClick={() => result(service.decline(r.id, r.offeredTo!), `${nameOf(r.offeredTo)} declined → next person asked.`)}>
                            Decline
                          </button>
                        </div>
                      </>
                    )}

                    {r.state === 'BROADCAST' && (
                      <>
                        <p>Everyone available was asked in the channel. First to accept wins.</p>
                        <div className="row wrap">
                          {eligible.map((p) => (
                            <button key={p.id} onClick={() => result(service.accept(r.id, p.id), `${p.name} committed.`)}>
                              Accept as {p.name}
                            </button>
                          ))}
                          {eligible.length === 0 && <span className="muted">Nobody is checked in at this office.</span>}
                        </div>
                      </>
                    )}

                    {(r.state === 'OFFERED' || r.state === 'BROADCAST') && eligible.length >= 2 && (
                      <button
                        className="race"
                        onClick={() => {
                          const [a, b] = r.state === 'OFFERED' ? [r.offeredTo!, eligible.find((p) => p.id !== r.offeredTo)!.id] : [eligible[0]!.id, eligible[1]!.id];
                          const ra = service.accept(r.id, a);
                          const rb = service.accept(r.id, b);
                          say(true, `⚡ ${nameOf(a)}: ${ra.ok ? 'committed ✅' : ra.reason} · ${nameOf(b)}: ${rb.ok ? 'committed ✅' : rb.reason}`);
                        }}
                      >
                        ⚡ Two people accept at once
                      </button>
                    )}

                    {r.state === 'COMMITTED' && (
                      <>
                        <p>
                          <b>{nameOf(r.committedBy)}</b> is buying · receipt due {fmtTime(r.purchaseDeadline!, office.timeZone)}
                        </p>
                        <div className="row">
                          <input
                            type="number"
                            value={amounts[o]}
                            onChange={(e) => setAmounts({ ...amounts, [o]: e.target.value })}
                          />
                          <span>{office.currency}</span>
                          <button
                            className="primary"
                            onClick={() => {
                              hr.failNext = hrFail === 'none' ? [] : [hrFail];
                              const res = service.recordPurchase(r.id, r.committedBy!, {
                                amount: money(Number(amounts[o]), office.currency),
                                receiptImage: `receipt-${r.id}.jpg`,
                              });
                              setHrFail('none');
                              result(res, res.ok ? `🧾 Receipt uploaded → ${res.value.state.replaceAll('_', ' ').toLowerCase()}.` : '');
                            }}
                          >
                            🧾 Upload receipt
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="pick">
                <div className="muted small">Next pick, best first (least money owed → fewest refills → longest ago):</div>
                <ol>
                  {ranked.map((v) => {
                    const s = service.statsFor(v.employeeId);
                    return (
                      <li key={v.employeeId}>
                        <b>{v.name}</b>
                        {v.homeOffice !== o && <span className="pill visitor">visitor</span>}
                        <span className="muted small">
                          {' '}· owed {format({ minor: s.outstandingMinor, currency: 'NOK' })} · {s.refillsLast30Days} refills
                        </span>
                      </li>
                    );
                  })}
                  {ranked.length === 0 && <li className="muted">Nobody available. A refill would go straight to the coordinator.</li>}
                </ol>
              </div>
            </div>
          );
        })}
      </section>

      <section className="grid2">
        <div className="card">
          <h3>👥 Where people are today</h3>
          <p className="muted small">No calendar integration: volunteers check in via chat. "Away" = home, holiday or sick.</p>
          <table>
            <tbody>
              {PEOPLE.map((p) => (
                <tr key={p.id}>
                  <td>{p.home === 'OSLO' ? '🇳🇴' : '🇮🇳'} {p.name}</td>
                  <td>
                    <div className="seg">
                      {(['OSLO', 'BLR', 'AWAY'] as Location[]).map((l) => (
                        <button key={l} className={location.get(p.id) === l ? 'on' : ''} onClick={() => setLoc(p.id, l)}>
                          {l === 'OSLO' ? 'Oslo' : l === 'BLR' ? 'Bengaluru' : 'Away'}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>🏢 HR system (simulated)</h3>
          <div className="row small">
            Next HR call:
            <div className="seg">
              {(['none', 'unavailable', 'timeout'] as const).map((f) => (
                <button key={f} className={hrFail === f ? 'on' : ''} onClick={() => setHrFail(f)}>
                  {f === 'none' ? 'works' : f === 'unavailable' ? 'HR down' : 'timeout'}
                </button>
              ))}
            </div>
          </div>
          {claims.length === 0 && <p className="muted">No claims yet.</p>}
          <table>
            <tbody>
              {claims.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{nameOf(r.committedBy)}</td>
                  <td>{format(r.purchase!.amount)}</td>
                  <td>
                    <span className={`pill s-${r.state}`}>{r.state.replaceAll('_', ' ').toLowerCase()}</span>
                  </td>
                  <td>
                    {r.state === 'CLAIM_SUBMITTED' && (
                      <div className="row">
                        <button onClick={() => { hr.decide(r.claim!.hrClaimId!, 'APPROVED'); service.syncClaims(); say(true, `HR approved ${r.id}.`); }}>Approve</button>
                        <button onClick={() => { hr.decide(r.claim!.hrClaimId!, 'REJECTED'); service.syncClaims(); say(true, `HR rejected ${r.id}.`); }}>Reject</button>
                      </div>
                    )}
                    {r.state === 'PURCHASED' && <span className="muted small">retries on next tick</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Claims actually created in HR: <b>{hr.claims.size}</b> (never more than one per refill)</p>
        </div>
      </section>

      <section className="grid2">
        <div className="card">
          <h3>💬 Company chat (simulated)</h3>
          <div className="feed">
            {chat.msgs.length === 0 && <p className="muted">Messages the system sends will appear here.</p>}
            {[...chat.msgs].reverse().map((m, i) => (
              <div key={i} className={`msg ${m.channel ? 'chan' : ''}`}>
                <div className="meta">
                  {m.channel ? m.to : `DM → ${nameOf(m.to)}`} · {fmtTime(m.at, 'Europe/Oslo')}
                </div>
                <div>{withNames(m.text)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>📊 Monthly report for management ({report.month})</h3>
          <table className="report">
            <thead>
              <tr><th>Office</th><th>Spent</th><th>Remaining</th><th>Refills</th><th>Avg h empty</th><th>In NOK</th></tr>
            </thead>
            <tbody>
              {report.offices.map((o) => (
                <tr key={o.officeId}>
                  <td>{o.officeId === 'OSLO' ? 'Oslo' : 'Bengaluru'}</td>
                  <td>{format(o.spent)}</td>
                  <td className={o.overBudget ? 'neg' : ''}>{format(o.remaining)}</td>
                  <td>{o.refills}</td>
                  <td>{o.avgHoursEmpty ?? '–'}</td>
                  <td>{format(o.spentInReportCurrency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="total">Total both offices: <b>{format(report.total)}</b></p>
          <p className="muted small">
            Amounts stored in original currency (integer øre/paise); converted only here, per purchase date. Demo rate 1 INR = 0.125 NOK.
          </p>
        </div>
      </section>

      <footer className="muted small">
        Built for the Framsikt Product Engineer assignment · state lives only in your browser · <a href="https://github.com/appie1702/framsikt-snack-counter/blob/main/DESIGN.md">Design doc</a>
      </footer>
    </div>
  );
}
