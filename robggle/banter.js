// Speech bubbles for good/bad winners and losers. {me}, {winner}, {loser}, {pts}, {word}, {margin}, {other} get filled in.
const LINES = {
  goodWinner: [
    'GG everyone. {loser}, that last stretch was scary.',
    'Honestly lucky board. Rematch?',
    "{other}, I saw that {word}. You're getting dangerous.",
    "I'll take it, but I'm buying the next round of snacks.",
    'Great game! The tiles were kind to me today.',
    'That was close. Well played, all of you.',
    'Couldn\'t have done it without everyone else being so polite about it.',
  ],
  badWinner: [
    '{pts} points. Write it down. Frame it.',
    'Was that a game or a tutorial? Because I was teaching.',
    "{loser}, don't worry, words are hard.",
    'I would say good game, but I only saw one.',
    'Another one for the trophy shelf. It is getting crowded.',
    '{word}. Look it up. Actually, you can\'t, I found it.',
    'I could do this with my eyes closed. Maybe next round I will.',
    'Please clap.',
  ],
  goodLoser: [
    'GG {winner}, you earned that one.',
    'I\'ll get you next round. Probably. Maybe.',
    'Fun board! {winner} was just faster.',
    'Respect, {winner}. That was a clinic.',
    'I had fun, and that is what matters. Right? Right.',
    'Close one! Run it back.',
  ],
  badLoser: [
    'The board was rigged and I have questions.',
    '{rejected} was absolutely a word. I demand a recount.',
    'My phone was lagging. That is the official statement.',
    '{winner} clearly practiced. Who practices?',
    'I was letting everyone win. As a gift.',
    'I lost by {margin}. That is basically a tie. I\'m calling it a tie.',
    'I\'m not mad. I\'m just going to sit over here. Quietly.',
    'The sun was in my eyes. Indoors. Yes.',
  ],
};

function line(kind, ctx) {
  const pool = LINES[kind] || LINES.goodLoser;
  const usable = pool.filter(t => (!t.includes('{word}') || ctx.word) && (!t.includes('{rejected}') || ctx.rejected) && (!t.includes('{other}') || ctx.other) && (!t.includes('{loser}') || ctx.loser));
  const t = usable[Math.floor(Math.random() * usable.length)] || pool[0];
  return t.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

module.exports = { line };
