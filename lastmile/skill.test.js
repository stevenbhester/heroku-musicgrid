// Checks Last Mile's tester estimates and their two routes on an in-memory store: node lastmile/skill.test.js
// (no database, nothing outside this process).

const assert = require('assert/strict');
const { createApp } = require('./app');
const { createMemoryStore } = require('./ratings');
const skill = require('./skill');

const hex = (n) => n.toString(16).padStart(32, '0');
// (Phones: the admin list shows the first 8 characters of an id, so these differ there.)
const phone = (n) => String(n).repeat(32);
let seq = 0;
// A play record: phone `dev` won job `level` in `secs`, with this much help.
const play = (dev, level, secs, over = {}) => ({
  id: hex(1000 + (seq += 1)), device: phone(dev), session: hex(500 + dev), level, level_fp: '1', title: `Job ${level}`, flavor: 'intro',
  where: `Level ${level}`, version: 'v0.7 (34)', made_at: '2026-11-18T00:00:00', tags: [], note: '',
  stats: { record: 'play', outcome: 'won', seconds_active: secs, hints: 0, radio: 0, undos: 0, restarts: 0, levels_done: level, ...over },
});

async function main() {
  const store = createMemoryStore();
  const app = createApp({ isProduction: false, ratingsStore: store, adminKey: 'k', ratingsPerIpHour: 100000, perIpHour: 10, perIpDay: 30, perDay: 300 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let failed = 0;
  const check = (name, fn) => { try { fn(); console.log(`ok    ${name}`); } catch (e) { failed += 1; console.log(`FAIL  ${name}: ${e.message}`); } };
  try {
    // 1: quick and clean through job 12.  2: the same jobs, slower, with hints.  3: only the first six, but the
    // quickest of anyone on them.  4: through job 60, at the pace of 1.  5: two records (a test run).
    // 6: the same twelve as 1, no hints, but ground out with restarts.
    const sends = [];
    for (let n = 1; n <= 12; n += 1) sends.push(play(1, n, 20), play(2, n, 70, { hints: 2, restarts: 3 }), play(6, n, 90, { restarts: 4, undos: 5 }));
    for (let n = 1; n <= 6; n += 1) sends.push(play(3, n, 8));
    for (let n = 1; n <= 60; n += 1) sends.push(play(4, n, 20));
    sends.push(play(5, 1, 10), play(5, 2, 10));
    for (const s of sends) assert.equal((await post('/ratings', s)).status, 201);

    const all = (await (await fetch(`${base}/testers`, { headers: { 'x-admin-key': 'k' } })).json()).testers;
    const of = (n) => all.find((t) => t.device === phone(n).slice(0, 8));
    check('a test run (two records) is not a tester', () => assert.equal(all.length, 5));
    check('against par: a clean quick player is under it, a slow one on hints is over', () => { assert.ok(of(1).vsPar > 0, `1 is ${of(1).vsPar}`); assert.ok(of(2).vsPar < of(1).vsPar); assert.ok(of(2).parHints > of(1).parHints); assert.ok(of(6).parTries > of(1).parTries); });
    check('scores are 0 to 100', () => all.forEach((t) => assert.ok(t.skill >= 0 && t.skill <= 100)));
    check('doing better than the others on the same jobs is more skill', () => assert.ok(of(1).skill > of(2).skill));
    check('beating hard jobs outranks acing only the easy ones', () => assert.ok(of(4).skill > of(3).skill));
    check('the furthest, clean player is top of the field (5 testers and the bots)', () => assert.equal(of(4).skillTop, Math.ceil(100 / (5 + skill.BOTS))));
    check('grit is a percentage', () => all.forEach((t) => assert.ok(t.grit >= 0 && t.grit <= 100)));
    check('grinding hard jobs out without help is more grit than getting through on hints', () => assert.ok(of(6).grit > of(2).grit + 30));
    check('someone no job got hard for is put at the average, between them', () => { assert.equal(of(1).hardJobs, 0); assert.ok(of(1).grit < of(6).grit && of(1).grit > of(2).grit); });
    check('getting furthest without ever asking is the most grit of all', () => assert.equal(of(4).grit, Math.max(...all.map((t) => t.grit))));
    check('the bots: 25 of them, through job 30, never listed, and par itself is never sent', () => {
      const b = skill.bots();
      assert.equal(b.length, 25); assert.ok(b.every((x) => x.furthest === 30 && Object.keys(x.runs).length === 30));
      assert.ok(all.every((t) => !t.device.startsWith('bot')));
      assert.ok(!JSON.stringify(all).includes('"par"'));
    });

    const me = await (await post('/me', { device: phone(2) })).json();
    check('a phone gets its own numbers', () => {
      assert.equal(me.enough, true); assert.equal(me.testers, undefined); assert.equal(me.skill, of(2).skill); assert.equal(me.skillTop, of(2).skillTop); assert.equal(me.grit, of(2).grit); assert.equal(me.vsPar, of(2).vsPar); assert.equal(me.fromPar, undefined);
      assert.equal(me.furthest, 12); assert.equal(me.jobsPlayed, 12); assert.equal(me.perJob.hints, 2); assert.equal(me.perJob.restarts, 3);
    });
    const none = await (await post('/me', { device: phone(5) })).json();
    check('too few records: says so, and nothing else', () => { assert.equal(none.enough, false); assert.equal(none.skill, undefined); });
    const bad = (await post('/me', { device: 'nope' })).status;
    const keyless = (await fetch(`${base}/testers`)).status;
    check('a bad id is refused', () => assert.equal(bad, 400));
    check("everyone's numbers need the key", () => assert.equal(keyless, 401));
    const rows = await store.list('', 20000);
    check('the module agrees with the route', () => assert.equal(skill.mine(rows, phone(2)).skill, me.skill));
  } finally {
    server.close();
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('skill test: all ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
