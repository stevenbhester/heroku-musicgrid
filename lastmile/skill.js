// Last Mile: what a tester's play records say about them. An estimated skill out of 100, an estimated "grit"
// (how likely they are to push on without asking for help), how they do against par, and where each stands.
// The admin stats page (stevenhester.com/last-mile/stats/) shows them for everyone; the game shows a player
// their own (Options, Testers, "Show my data").
//
// PAR is each job's usual time, hints and tries, from 25 simulated players of random skill, the best of them
// pretty good but not amazing (job_par.json, written by drop-order/tools/engine/par_sim.py). TRIES is retries
// and undos as one number: a retry is 1, and an undo is the share of a retry it stands for (a route with S
// stops takes S undos to get back to the start, which is what a retry does, so an undo is 1/S). Par is kept
// here: nothing sends it to the game, and the stats page only sees how far from it each tester is.
//
// A job's COST is its time plus what the rest was worth in seconds: 60 a hint, 20 a try, 10 a call.
//
// SKILL starts at 35 (nobody in particular) and moves three ways:
//   - up to 15 either way for how the tester did against the OTHERS ON THE SAME JOB (so a hard job's measure
//     is its own average, not an easy job's). Harder jobs count for more, jobs few others have played count
//     for less, and with little to go on it stays near the middle.
//   - up to 15 either way for how far under or over PAR their jobs cost, harder jobs counting for more. This
//     is the only comparison there is on jobs nobody else has reached.
//   - up to 35 for how much of the game's difficulty they've beaten. Getting to the hard jobs and through them
//     is skill in itself, and it means someone who has only played the easy jobs, however well, doesn't
//     outrank someone who's beaten hard ones.
//
// GRIT is how likely they are NOT to cave and ask for help when a job gets hard, as a percentage. The jobs that
// count are the ones that got hard for them (a retry's worth of tries, a minute on it, or help taken: you
// don't ask unless you're stuck) and the ones par says are hard (half a hint or more at par). Caving is a
// hint's worth of help: a hint, or three calls (the game's own rate: a can of gas buys one hint or three
// calls). It's measured against par: on a job where par itself takes a hint, taking one is half caving, and
// taking none counts for more. Harder jobs count for more. With few such jobs to go on, the estimate leans
// toward the field's average; with none, it is the average. Only records that carry the job's play numbers
// count (every build since 24: the game leaves a count out when it's zero, so such a record without "hints"
// means none were taken).
//
// THE FIELD is the testers plus the same simulated players, as they did on jobs 1 to BOT_JOBS: there's always
// someone to stand against, and every early job has others to compare with. They never appear in a list, and
// a phone is never told how many testers or bots there are.

const WEIGHTS = require('./job_weights.json').jobs;
const PARFILE = require('./job_par.json');
const PAR = PARFILE.par;
const JOBS = Object.keys(WEIGHTS).map(Number);
const weight = (n) => 1 + (Number(WEIGHTS[n]) || (WEIGHTS[n] === undefined ? n / 8 : 0));
const TOTAL = JOBS.reduce((a, n) => a + weight(n), 0) || 1;
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const BOT_JOBS = 30;

// One entry per phone, from its records in the order they came: each job's latest record stands for it (the
// game's counts add up over a job's tries until it's won), as the stats page reads them.
function testers(rows) {
  const sorted = [...rows].sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  const devs = new Map();
  for (const r of sorted) {
    const id = String(r.device || '');
    if (!id) continue;
    const st = r.stats || {};
    if (!devs.has(id)) devs.set(id, { id, cells: {}, runs: {}, furthest: 0, sessions: new Set(), rated: {} });
    const d = devs.get(id);
    if (r.session) d.sessions.add(String(r.session));
    d.furthest = Math.max(d.furthest, Number(st.levels_done) || 0);
    const m = /^Level (\d+)$/.exec(String(r.where || ''));
    if (!m) continue;
    const n = Number(m[1]);
    const won = st.record !== 'play' || st.outcome === 'won';
    // (`counted`: the record carries the job's play numbers, so its counts are real, zeros included. `stops`:
    // how many drags the winning route took, which is how many undos go back to the start.)
    const run = {
      secs: (Number(st.seconds_active) || 0) + (won ? 0 : Number(st.seconds_this_try) || 0),
      counted: st.record === 'play' || 'seconds_active' in st, stops: Number(st.segments_winning_try) || 0,
    };
    for (const [k, f] of [['hints', 'hints'], ['calls', 'radio'], ['undos', 'undos'], ['restarts', 'restarts']]) if (run.counted || f in st) run[k] = Number(st[f]) || 0;
    if (!(d.runs[n] && d.runs[n].won && !won)) d.runs[n] = { ...run, won };
    const c = d.cells[n] || (d.cells[n] = { won: false });
    if (won) { c.won = true; d.furthest = Math.max(d.furthest, n); }
    const stars = (v) => (v >= 1 && v <= 5 ? Number(v) : null);
    if (stars(r.difficulty) || stars(r.fun) || stars(r.frustration)) d.rated[n] = { d: stars(r.difficulty), f: stars(r.fun), x: stars(r.frustration) };
  }
  // (A phone with only a couple of records is a test run, not a tester.)
  return [...devs.values()].filter((d) => Object.keys(d.cells).length >= 3);
}

// The simulated players, as members of the field: their runs of jobs 1 to BOT_JOBS.
function bots() {
  return (PARFILE.bots || []).map((b, k) => {
    const runs = {};
    const cells = {};
    for (const [n, r] of Object.entries(b.runs)) {
      if (+n > BOT_JOBS) continue;
      runs[n] = { ...r, won: true, counted: true };
      cells[n] = { won: true };
    }
    return { id: `bot${String(k).padStart(2, '0')}`, bot: true, cells, runs, furthest: Math.min(BOT_JOBS, Object.keys(runs).length), sessions: new Set(), rated: {} };
  });
}
const field = (rows) => { const humans = testers(rows); return { humans, all: [...humans, ...bots()] }; };

// Retries and undos as one number, for job `n`.
const tries = (r, n) => (r.restarts || 0) + (r.undos || 0) / Math.max(1, r.stops || (PAR[n] || {}).stops || 4);
const helpTaken = (r) => (r.hints || 0) + (r.calls || 0) / 3;
// What a job cost someone, in seconds.
const cost = (r, n) => (r.secs || 0) + 60 * (r.hints || 0) + 20 * tries(r, n) + 10 * (r.calls || 0);
const parCost = (n) => (PAR[n] ? PAR[n].secs + 60 * PAR[n].hints + 20 * PAR[n].tries : 0);
// The job got hard enough for help to be a temptation: for them, or by par.
const gotHard = (r, n) => tries(r, n) >= 1 || (r.secs || 0) >= 60 || helpTaken(r) > 0 || ((PAR[n] || {}).hints || 0) >= 0.5;
// How much the field's average counts for in one tester's grit: about three middling jobs' worth.
const GRIT_PRIOR = 15;

function estimate(P) {
  // Against the others on the same job.
  const byJob = new Map();
  for (const p of P) {
    for (const [n, r] of Object.entries(p.runs)) {
      if (!byJob.has(+n)) byJob.set(+n, []);
      byJob.get(+n).push({ p, r });
    }
  }
  const acc = new Map(P.map((p) => [p.id, { num: 0, den: 0, jobs: 0 }]));
  for (const [n, list] of byJob) {
    if (list.length < 3) continue; // nobody to compare with
    const lc = (x) => Math.log(1 + cost(x.r, n));
    const wins = list.filter((x) => x.r.won).map(lc);
    const worst = wins.length ? Math.max(...wins) : 0;
    // (Not beaten yet: at least as costly as the hardest-won win, and then some.)
    const c = list.map((x) => (x.r.won ? lc(x) : Math.max(lc(x), worst) + 0.5));
    const m = mean(c);
    const sd = Math.max(0.35, Math.sqrt(mean(c.map((v) => (v - m) ** 2))));
    const trust = (list.length - 1) / (list.length + 1);
    list.forEach((x, i) => {
      const others = (m * c.length - c[i]) / (c.length - 1);
      const z = clamp((others - c[i]) / sd, -2.5, 2.5) / 2.5; // -1 .. 1: worse .. better than the rest
      const a = acc.get(x.p.id);
      a.num += weight(n) * trust * z;
      a.den += weight(n) * trust;
      a.jobs += 1;
    });
  }
  // Against par, and grit: each tester's own jobs.
  const own = new Map();
  let heldAll = 0;
  let hardAll = 0;
  for (const p of P) {
    const m = { par: 0, parDen: 0, time: [], hints: [], tries: [], held: 0, hard: 0, hardJobs: 0 };
    for (const [key, r] of Object.entries(p.runs)) {
      const n = +key;
      const par = PAR[n];
      if (!r.counted || !par) continue;
      const pc = parCost(n);
      if (pc > 0) {
        // (Not beaten yet: at least half as much again as par.)
        const c = r.won ? cost(r, n) : Math.max(cost(r, n), pc * 1.5);
        m.par += weight(n) * clamp((pc - c) / pc, -1.5, 1);
        m.parDen += weight(n);
        if (r.won) {
          m.time.push(clamp((par.secs - r.secs) / Math.max(1, par.secs), -3, 1));
          m.hints.push((r.hints || 0) - par.hints);
          m.tries.push(tries(r, n) - par.tries);
        }
      }
      if (gotHard(r, n)) {
        const w = weight(n) * (1 + par.hints);
        m.held += w * (1 - Math.min(1, helpTaken(r) / (1 + par.hints)));
        m.hard += w;
        m.hardJobs += 1;
      }
    }
    heldAll += m.held;
    hardAll += m.hard;
    own.set(p.id, m);
  }
  const usual = hardAll ? heldAll / hardAll : 0.5;
  const out = new Map();
  for (const p of P) {
    const a = acc.get(p.id);
    const m = own.get(p.id);
    const perf = a.den ? a.num / a.den : 0;
    const sure = a.den / (a.den + 40); // little to go on: stay near the middle
    const vsPar = m.parDen ? m.par / m.parDen : 0;
    const reach = JOBS.filter((n) => n <= p.furthest).reduce((s, n) => s + weight(n), 0) / TOTAL;
    const fromOthers = 30 * clamp(perf * 2 * sure, -0.5, 0.5);
    const fromPar = 15 * clamp(vsPar * 1.5 * (m.parDen / (m.parDen + 25)), -1, 1);
    const fromReach = 35 * Math.sqrt(reach);
    out.set(p.id, {
      skill: Math.round(clamp(35 + fromOthers + fromPar + fromReach, 0, 100)),
      fromOthers, fromPar, fromReach, compared: a.jobs,
      grit: Math.round((100 * (m.held + GRIT_PRIOR * usual)) / (m.hard + GRIT_PRIOR)), hardJobs: m.hardJobs,
      // Against par, a job: overall (the cost, as a share of par's: + is better), and its three parts.
      vsPar: m.parDen ? Math.round(100 * vsPar) : null,
      // (Time is the middle job's, not the average: one job that took ten minutes would swamp the rest.)
      parTime: m.time.length ? Math.round(100 * median(m.time)) : null,
      parHints: m.hints.length ? +mean(m.hints).toFixed(2) : null,
      parTries: m.tries.length ? +mean(m.tries).toFixed(2) : null,
    });
  }
  return out;
}

// "Top X%" of the field, by rank (ties share the better place): the best of ten is in the top 10%.
function standing(P, est, key) {
  const vals = P.map((p) => est.get(p.id)[key]).sort((a, b) => b - a);
  const out = new Map();
  for (const p of P) out.set(p.id, Math.ceil((100 * (vals.indexOf(est.get(p.id)[key]) + 1)) / P.length));
  return out;
}

function summary(p) {
  const runs = Object.values(p.runs);
  const per = (k) => mean(runs.filter((r) => k in r).map((r) => r[k])); // (records with play numbers: zeros count)
  const rated = Object.values(p.rated);
  const avg = (k) => mean(rated.map((c) => c[k]).filter(Boolean));
  return {
    furthest: p.furthest, sessions: p.sessions.size, jobsPlayed: runs.length, jobsWon: runs.filter((r) => r.won).length, jobsRated: rated.length,
    perJob: { secs: per('secs'), hints: per('hints'), calls: per('calls'), undos: per('undos'), restarts: per('restarts') },
    ratings: { difficulty: avg('d'), fun: avg('f'), frustration: avg('x') },
  };
}

const shown = (e) => ({ skill: e.skill, grit: e.grit, hardJobs: e.hardJobs, vsPar: e.vsPar, parTime: e.parTime, parHints: e.parHints, parTries: e.parTries });

// Every tester, for the admin page (phones by the first 8 characters of their id, as it shows them). Their
// standings are in the whole field, bots included; the bots themselves aren't listed.
function everyone(rows) {
  const { humans, all } = field(rows);
  const est = estimate(all);
  const st = standing(all, est, 'skill');
  const gt = standing(all, est, 'grit');
  return humans.map((p) => {
    const e = est.get(p.id);
    return {
      device: p.id.slice(0, 8), ...shown(e), skillTop: st.get(p.id), gritTop: gt.get(p.id),
      fromOthers: +e.fromOthers.toFixed(1), fromPar: +e.fromPar.toFixed(1), fromReach: +e.fromReach.toFixed(1), compared: e.compared,
    };
  });
}

// One phone's own numbers, for the game. (Nothing about how many others there are, and nothing of par itself.)
function mine(rows, device) {
  const { humans, all } = field(rows);
  const p = humans.find((x) => x.id === device);
  if (!p) return { ok: true, enough: false };
  const est = estimate(all);
  return {
    ok: true, enough: true, ...shown(est.get(p.id)),
    skillTop: standing(all, est, 'skill').get(p.id), gritTop: standing(all, est, 'grit').get(p.id),
    ...summary(p),
  };
}

module.exports = { testers, bots, estimate, standing, everyone, mine, BOTS: (PARFILE.bots || []).length, BOT_JOBS };
