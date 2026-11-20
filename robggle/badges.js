// End-of-round badges. Every candidate has a "score" for how notable it is; each player gets their
// top 2-3, so everyone walks away with something, good, bad or ridiculous.
const sec = ms => `${Math.round(ms / 1000)}s`;

// ctx: { players: [...results players], perPlayer: Map(id -> stats), roundMs, words: results words }
function award(ctx) {
  const { players, perPlayer, roundMs, coop } = ctx;
  const out = {};
  const cands = new Map(players.map(p => [p.id, []]));
  const add = (id, score, b) => { if (cands.has(id)) cands.get(id).push({ score, ...b }); };
  const st = id => perPlayer.get(id) || {};
  const ranked = players.slice().sort((a, b) => b.round - a.round);
  const multi = players.length > 1;
  // Best player(s) for a numeric stat; returns [] if nobody has any.
  const leaders = (fn, min = 1) => {
    const vals = players.map(p => ({ id: p.id, v: fn(st(p.id), p) }));
    const best = Math.max(...vals.map(x => x.v));
    return best >= min ? vals.filter(x => x.v === best) : [];
  };

  // ----- results -----
  if (multi && ranked[0] && ranked[0].round > 0) {
    const tied = ranked.filter(p => p.round === ranked[0].round);
    for (const p of tied) add(p.id, 100, coop ? { key: 'champ', icon: 'crown', tone: 'good', title: 'Team MVP', desc: `Wrote down ${p.round} points for the team` } : { key: 'champ', icon: 'crown', tone: 'good', title: tied.length > 1 ? 'Co-Champion' : 'Top of the Pile', desc: `Won the round with ${p.round} points` });
  }
  if (multi && ranked.length > 2) {
    const last = ranked[ranked.length - 1];
    if (last.round < ranked[0].round) add(last.id, 55, coop ? { key: 'participation', icon: 'ribbon', tone: 'funny', title: 'Moral Support', desc: `Held the pen for ${last.round} point${last.round === 1 ? '' : 's'}. The cheering counted too.` } : { key: 'participation', icon: 'ribbon', tone: 'bad', title: 'Participation Trophy', desc: `Came last with ${last.round} point${last.round === 1 ? '' : 's'}. You showed up!` });
  }
  if (!coop && multi && ranked.length > 1 && ranked[0].round - ranked[1].round <= 2 && ranked[1].round > 0) {
    add(ranked[1].id, 70, { key: 'sosoclose', icon: 'ruler', tone: 'funny', title: 'So Close It Hurts', desc: `Lost by ${ranked[0].round - ranked[1].round}` });
  }

  for (const p of players) {
    const s = st(p.id);
    const times = (s.times || []).slice().sort((a, b) => a - b);
    // ----- pace -----
    if (times.length >= 2) {
      let gap = 0;
      for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
      if (gap >= 25000) add(p.id, 40 + gap / 1000, { key: 'lostforwords', icon: 'clock', tone: 'bad', title: 'Lost For Words', desc: `Went ${sec(gap)} between words` });
    }
    if (times.length && times[0] >= 20000) add(p.id, 35 + times[0] / 2000, { key: 'late', icon: 'snail', tone: 'bad', title: 'Fashionably Late', desc: `First word at ${sec(times[0])}` });
    if (s.wordTimes && s.wordTimes.some(t => t >= roundMs - 2500)) add(p.id, 45, { key: 'buzzer', icon: 'bolt', tone: 'good', title: 'Buzzer Beater', desc: 'Scored in the final 2 seconds' });
    const burst = maxInWindow(s.wordTimes || [], 10000);
    if (burst >= 5) add(p.id, 50 + burst * 3, { key: 'speed', icon: 'bolt', tone: 'good', title: 'Speed Demon', desc: `${burst} words in 10 seconds` });
    if ((s.words || []).length === 0 && times.length === 0) add(p.id, 90, { key: 'ghost', icon: 'ghost', tone: 'bad', title: 'Were You Even Here?', desc: 'Not a single word, not even a wrong one' });
    // ----- words -----
    const ws = s.words || [];
    if (ws.length >= 5 && ws.every(w => w.length <= 4)) add(p.id, 52, { key: 'tiny', icon: 'ant', tone: 'funny', title: 'Tiny Words, Big Dreams', desc: `All ${ws.length} words were 4 letters or fewer` });
    const plurals = ws.filter(w => w.endsWith('s')).length;
    if (plurals >= 4 && plurals / ws.length >= 0.4) add(p.id, 38 + plurals, { key: 'plural', icon: 'stack', tone: 'funny', title: 'Plural Police', desc: `${plurals} of your words just added an S` });
    let run = 0, best = 0;
    for (const w of s.orderWords || []) { run = w.length >= 5 ? run + 1 : 0; best = Math.max(best, run); }
    if (best >= 3) add(p.id, 60, { key: 'hattrick', icon: 'hat', tone: 'good', title: 'Hat Trick', desc: `${best} long words in a row` });
    if (ws.some(w => w.includes('qu'))) add(p.id, 33, { key: 'qtip', icon: 'q', tone: 'funny', title: 'Q-Tip', desc: 'Actually used the Qu tile' });
    if (s.rejected >= 6) add(p.id, 40 + s.rejected, { key: 'dict', icon: 'book', tone: 'bad', title: 'Dictionary Optional', desc: `${s.rejected} words the dictionary had never heard of` });
  }

  // ----- comparisons -----
  for (const x of leaders(s => Math.max(0, ...(s.words || []).map(w => w.length)), 6)) {
    const w = (st(x.id).words || []).reduce((a, b) => (b.length > a.length ? b : a), '');
    add(x.id, 50 + x.v * 4, { key: 'long', icon: 'scroll', tone: 'good', title: 'Long Hauler', desc: `Longest word: ${w.toUpperCase()} (${w.length})` });
  }
  if (multi) for (const x of leaders((s, p) => p.solos, 3)) add(x.id, 55 + x.v * 2, { key: 'lonewolf', icon: 'wolf', tone: 'good', title: 'Lone Wolf', desc: `${x.v} words nobody else found` });
  for (const x of leaders(s => s.copied || 0, 3)) add(x.id, 48 + x.v * 2, { key: 'copycat', icon: 'cat', tone: 'funny', title: 'Copycat', desc: `Copied ${x.v} words from allies` });
  for (const x of leaders(s => s.copiedFrom || 0, 3)) add(x.id, 44 + x.v * 2, { key: 'carry', icon: 'backpack', tone: 'good', title: 'Carried the Team', desc: `Allies copied ${x.v} of your words` });
  for (const x of leaders(s => s.bridges || 0, 1)) add(x.id, 50 + x.v * 6, { key: 'bridge', icon: 'bridge', tone: 'good', title: 'Bridge Builder', desc: `Spanned the board ${x.v} time${x.v === 1 ? '' : 's'}` });
  for (const x of leaders(s => s.challenges || 0, 2)) add(x.id, 46 + x.v * 4, { key: 'lawyer', icon: 'gavel', tone: 'funny', title: 'Professional Arguer', desc: `Challenged ${x.v} rulings` });
  for (const p of players) {
    const s = st(p.id);
    if (s.challengesWon) add(p.id, 62, { key: 'silver', icon: 'gavel', tone: 'good', title: 'Silver Tongue', desc: `Talked the table into ${s.challengesWon} word${s.challengesWon === 1 ? '' : 's'}` });
    if (s.challengesLost) add(p.id, 42, { key: 'overruled', icon: 'gavel', tone: 'bad', title: 'Overruled', desc: `The family said no ${s.challengesLost} time${s.challengesLost === 1 ? '' : 's'}` });
    // ----- chaos -----
    if (s.bananaSplit) add(p.id, 85, { key: 'banana', icon: 'banana', tone: 'good', title: 'Banana Split', desc: `First to fill Nana's banana (${s.banana} letters)` });
    if (s.zWords) add(p.id, 52 + s.zWords * 5, { key: 'sleepwalk', icon: 'z', tone: 'funny', title: 'Sleepwalker', desc: `Made ${s.zWords} word${s.zWords === 1 ? '' : 's'} out of Z's` });
    if (s.samWords >= 2) add(p.id, 40 + s.samWords * 2, { key: 'pitcrew', icon: 'car', tone: 'good', title: 'Pit Crew', desc: `${s.samWords} words through the tire smoke` });
    if (s.setCleared) add(p.id, 48, { key: 'setmaster', icon: 'cards', tone: 'good', title: 'Set Master', desc: `Cleared every card in ${sec(s.setCleared)}` });
    if (s.robbertBad >= 2) add(p.id, 43 + s.robbertBad, { key: 'robbert', icon: 'three', tone: 'bad', title: 'Robbert Disapproves', desc: `Tried ${s.robbertBad} long words during Robbert Mode` });
  }
  for (const x of leaders(s => s.robbertWords || 0, 3)) add(x.id, 45 + x.v * 2, { key: 'robbertok', icon: 'three', tone: 'good', title: 'Robbert Approved', desc: `${x.v} three-letter words on command` });
  for (const x of leaders(s => s.leaked || 0, 1)) add(x.id, 47 + x.v * 3, { key: 'leaky', icon: 'drop', tone: 'funny', title: 'Leaky Faucet', desc: `Steven & Erin told everyone about ${x.v} of your words` });
  for (const x of leaders(s => s.tookTips || 0, 2)) add(x.id, 44 + x.v * 2, { key: 'eavesdrop', icon: 'gift', tone: 'funny', title: 'Eavesdropper', desc: `Found ${x.v} words Steven & Erin let slip` });

  for (const p of players) {
    const list = cands.get(p.id).sort((a, b) => b.score - a.score);
    const seen = new Set();
    const pick = [];
    for (const b of list) {
      if (seen.has(b.key)) continue;
      seen.add(b.key);
      pick.push({ key: b.key, icon: b.icon, tone: b.tone, title: b.title, desc: b.desc });
      if (pick.length === 3) break;
    }
    if (!pick.length) pick.push({ key: 'present', icon: 'ribbon', tone: 'funny', title: 'Present and Accounted For', desc: `${p.words} word${p.words === 1 ? '' : 's'}, no notes` });
    out[p.id] = pick;
  }
  return out;
}

function maxInWindow(times, win) {
  const t = times.slice().sort((a, b) => a - b);
  let best = 0, j = 0;
  for (let i = 0; i < t.length; i++) {
    while (t[i] - t[j] > win) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

module.exports = { award };
