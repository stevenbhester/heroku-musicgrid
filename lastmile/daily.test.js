// Checks Last Mile's daily results routes on an in-memory store: node lastmile/daily.test.js
// (no database, nothing outside this process).

const assert = require('assert/strict');
const { createApp } = require('./app');
const daily = require('./daily');

const hex = (n) => n.toString(16).padStart(32, '0');
const result = (n, over = {}) => ({
  device: hex(n), day: '2026-11-15', version: 'v0.7 (24)', solved: true, score: 150, secs: 24.5, tries: 1,
  tiles: 14, undos: 0, badges: ['delivered', 'first_try'], ...over,
});

async function main() {
  const app = createApp({ isProduction: false, dailyStore: daily.createMemoryStore(), perIpHour: 10, perIpDay: 30, perDay: 300 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/daily`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stats = (day) => fetch(`${base}/daily/stats?day=${day}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}: ${err.message}`);
    }
  };

  await check('a result is taken', async () => assert.equal((await post(result(1))).status, 201));
  await check('a bad one is refused', async () => {
    assert.equal((await post(result(2, { device: 'nope' }))).status, 400);
    assert.equal((await post(result(2, { day: '15/11/2026' }))).status, 400);
    assert.equal((await post(result(2, { badges: ['Not A Name!'] }))).status, 400);
    assert.equal((await post(result(2, { score: -5 }))).status, 400);
  });
  await check('a miss, then a solve, replaces it', async () => {
    assert.equal((await post(result(3, { solved: false, score: 0, tries: 6 }))).status, 201);
    assert.equal((await post(result(3, { score: 210, tries: 2 }))).status, 201);
  });
  await check('a solve is never replaced by a miss', async () => {
    assert.equal((await post(result(1, { solved: false, score: 0 }))).status, 200);
  });
  await post(result(4, { solved: false, score: 0, tries: 6 }));
  await check('today\'s numbers', async () => {
    const { status, body } = await stats('2026-11-15');
    assert.equal(status, 200);
    assert.equal(body.players, 3);
    assert.equal(body.solved, 2);
    assert.equal(body.scoreAvg, 180);
    assert.deepEqual(body.scores, { 150: 1, 210: 1 });
    assert.deepEqual(body.secs, { 20: 2 });
    assert.deepEqual(body.tries, { 1: 1, 2: 1 });
    assert.equal(body.badges.first_try, 2);
  });
  await check('another day is its own', async () => {
    const { body } = await stats('2026-11-14');
    assert.equal(body.players, 0);
  });
  await check('a bad day is refused', async () => assert.equal((await stats('yesterday')).status, 400));

  server.close();
  console.log(failed ? `${failed} FAILED` : 'daily: all ok');
  process.exit(failed ? 1 : 0);
}

main();
