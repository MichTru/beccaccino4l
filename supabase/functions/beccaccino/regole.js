// Regole del beccaccino romagnolo: funzioni pure, usate dal server.
// Carta = seme + valore, es. "D3" (Tre di Denari). 8 Fante, 9 Cavallo, 10 Re.
export const SUITS = ["D", "C", "S", "B"];
export const SUIT_NAME = { D: "Denari", C: "Coppe", S: "Spade", B: "Bastoni" };
export const TARGET = 41;
export const BOT_NAMES = ["CPU Lugo", "CPU Bagnacavallo", "CPU Cotignola", "CPU Fusignano"];
const STR = { 3: 10, 2: 9, 1: 8, 10: 7, 9: 6, 8: 5, 7: 4, 6: 3, 5: 2, 4: 1 };
export const cs = (c) => c[0];
export const cr = (c) => +c.slice(1);
export const TH = (c) => { const r = cr(c); return r === 1 ? 3 : ([2, 3, 8, 9, 10].includes(r) ? 1 : 0); };
export const teamOf = (s) => s % 2;

function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function deal(seed) {
  const d = []; for (const s of SUITS) for (let r = 1; r <= 10; r++) d.push(s + r);
  const rnd = mulberry(Number(seed));
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return [0, 1, 2, 3].map((i) => d.slice(i * 10, i * 10 + 10));
}
const sortHand = (a, b) => SUITS.indexOf(cs(a)) - SUITS.indexOf(cs(b)) || STR[cr(b)] - STR[cr(a)];
export function handOf(g, seed, s) {
  const played = new Set(g.hand.played.map((p) => p.c));
  return deal(seed)[s].filter((c) => !played.has(c)).sort(sortHand);
}
export const liveTrick = (h) => (h.trick.length === 4 ? [] : h.trick);
export function legal(g, seed, s) {
  const hc = handOf(g, seed, s), tr = liveTrick(g.hand);
  if (!tr.length) return hc;
  const f = hc.filter((c) => cs(c) === cs(tr[0].c));
  return f.length ? f : hc;
}
export function beats(a, b, trump) {
  if (cs(a) === cs(b)) return STR[cr(a)] > STR[cr(b)];
  return cs(a) === trump;
}
export function trickWinner(tr, trump) { let w = tr[0]; for (const t of tr.slice(1)) if (beats(t.c, w.c, trump)) w = t; return w; }
export function actor(g) {
  if (!g.hand) return -1;
  if (g.status === "trump") return g.hand.leader;
  if (g.status === "play") return g.hand.turn;
  return -1;
}
const nick = (g, s) => (g.seats[s] ? g.seats[s].nick || "Giocatore" : "—");
function pushLog(g, txt) { g.log = (g.log || []).concat([txt]).slice(-6); }

// Nuova mano: restituisce il seed del mazzo (resta segreto sul server).
export function newHand(g, n, leader) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  if (leader == null) leader = deal(seed).findIndex((h) => h.includes("D4"));
  g.hand = { n, leader, trump: null, played: [], trick: [], turn: leader, thirds: [0, 0], tricks: [0, 0], cricca: [], result: null, lastWinner: null };
  g.status = "trump";
  pushLog(g, `Mano ${n}: ${nick(g, leader)} ${n === 1 ? "ha il 4 di Denari, " : ""}sceglie la briscola`);
  return seed;
}
export function chooseTrump(g, seed, suit) {
  const h = g.hand; h.trump = suit;
  const hs = deal(seed);
  h.cricca = [0, 1, 2, 3].filter((s) => ["1", "2", "3"].every((r) => hs[s].includes(suit + r)));
  g.status = "play"; h.turn = h.leader;
  pushLog(g, `${nick(g, h.leader)} chiama briscola a ${SUIT_NAME[suit]}`);
  for (const s of h.cricca) pushLog(g, `Cricca di ${nick(g, s)}! +3`);
}
export function applyPlay(g, s, c, sig) {
  const h = g.hand;
  if (h.trick.length === 4) h.trick = [];
  const lead = h.trick.length === 0;
  h.trick.push({ s, c, sig: lead && sig ? sig : null });
  h.played.push({ s, c });
  if (h.trick.length < 4) { h.turn = (s + 1) % 4; return; }
  const w = trickWinner(h.trick, h.trump), t = teamOf(w.s);
  h.thirds[t] += h.trick.reduce((x, e) => x + TH(e.c), 0);
  h.tricks[t]++; h.turn = w.s; h.lastWinner = w.s;
  if (h.played.length < 40) return;
  const cards = [Math.floor(h.thirds[0] / 3), Math.floor(h.thirds[1] / 3)];
  const last = [t === 0 ? 1 : 0, t === 1 ? 1 : 0];
  const cri = [0, 0]; for (const x of h.cricca) cri[teamOf(x)] += 3;
  const tot = [cards[0] + last[0] + cri[0], cards[1] + last[1] + cri[1]];
  h.result = { cards, last, cricca: cri, tot };
  g.scores = [g.scores[0] + tot[0], g.scores[1] + tot[1]];
  g.history = (g.history || []).concat([tot]);
  pushLog(g, `Fine mano ${h.n}: ${tot[0]} a ${tot[1]}`);
  const [a, b] = g.scores;
  if ((a >= TARGET || b >= TARGET) && a !== b) { g.status = "end"; g.winner = a > b ? 0 : 1; }
  else g.status = "handEnd";
}

// ---- CPU ----
export function botTrump(seed, s) {
  const hc = deal(seed)[s]; let best = "D", bv = -1;
  for (const su of SUITS) { const x = hc.filter((c) => cs(c) === su); const v = x.length * 10 + x.reduce((a, c) => a + STR[cr(c)], 0); if (v > bv) { bv = v; best = su; } }
  return best;
}
export function botPlay(g, seed, s) {
  const h = g.hand, L = legal(g, seed, s), tr = liveTrick(h), trump = h.trump;
  const asc = (a, b) => STR[cr(a)] - STR[cr(b)];
  const cheap = (arr) => arr.slice().sort((a, b) => (cs(a) === trump) - (cs(b) === trump) || TH(a) - TH(b) || asc(a, b))[0];
  if (!tr.length) {
    const non = L.filter((c) => cs(c) !== trump), pool = non.length ? non : L;
    const tre = pool.find((c) => cr(c) === 3); if (tre) return tre;
    return cheap(pool);
  }
  const w = trickWinner(tr, trump), mate = teamOf(w.s) === teamOf(s), last = tr.length === 3;
  const pts = tr.reduce((x, e) => x + TH(e.c), 0);
  if (mate && (last || STR[cr(w.c)] >= 9 || cs(w.c) === trump)) {
    const rich = L.filter((c) => cs(c) !== trump || L.every((x) => cs(x) === trump)).sort((a, b) => TH(b) - TH(a) || asc(a, b));
    return rich[0] || cheap(L);
  }
  const win = L.filter((c) => beats(c, w.c, trump)).sort((a, b) => (cs(a) === trump) - (cs(b) === trump) || asc(a, b));
  if (!mate && win.length && (pts >= 1 || last || cs(win[0]) !== trump)) return win[0];
  return cheap(L);
}
