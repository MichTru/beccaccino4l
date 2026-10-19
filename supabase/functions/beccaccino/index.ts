// Funzione "beccaccino": unico punto in cui lo stato del tavolo cambia.
// Il mazzo (seed) e le chiavi dei giocatori stanno in public.segreti e non escono mai.
// Nessuna libreria: chiamate dirette a PostgREST, così la funzione parte più in fretta.
import * as R from "./regole.js";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...SB_H, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Errore extends Error {}
const fail = (msg: string): never => { throw new Errore(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hash(token: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("becca:" + token));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cleanNick = (n: unknown) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 20);

type Load = { g: any; ver: number; seed: number | null; posti: (string | null)[]; host: string };
async function load(id: string): Promise<Load> {
  const q = encodeURIComponent(id);
  const [ts, ss] = await Promise.all([
    rest(`tavoli?id=eq.${q}&select=stato,versione`),
    rest(`segreti?tavolo_id=eq.${q}&select=seed,posti,host`),
  ]);
  const t = ts && ts[0], s = ss && ss[0];
  if (!t || !s) fail("Tavolo non trovato");
  return { g: t!.stato, ver: t!.versione, seed: s!.seed, posti: s!.posti, host: s!.host };
}
async function save(id: string, L: Load, seed: number | null, posti: (string | null)[] | null) {
  const data = await rest("rpc/salva_tavolo", { method: "POST", body: JSON.stringify({ p_id: id, p_ver: L.ver, p_stato: L.g, p_seed: seed, p_posti: posti }) });
  return data === true;
}

// Applica una mossa con controllo di versione; riprova se qualcuno ha scritto nel frattempo.
async function mossa(id: string, fn: (L: Load) => { seed?: number; posti?: (string | null)[] } | void) {
  for (let i = 0; i < 4; i++) {
    const L = await load(id);
    const out = fn(L) || {};
    if (await save(id, L, out.seed ?? null, out.posti ?? null)) {
      if (out.posti) L.posti = out.posti;
      if (out.seed != null) L.seed = out.seed;
      L.ver += 1;
      return L;
    }
  }
  fail("Il tavolo è molto trafficato, riprova");
}

// Le CPU giocano sul server, una carta alla volta, con una pausa per farle vedere.
async function giocaCpu(id: string) {
  for (let i = 0; i < 80; i++) {
    let L: Load;
    try { L = await load(id); } catch { return; }
    const a = R.actor(L.g);
    if (a < 0 || !L.g.seats[a]?.bot) return;
    await sleep(L.g.hand.trick.length === 4 ? 950 : 550);
    const ok = await save(id, (() => {
      if (L.g.status === "trump") R.chooseTrump(L.g, L.seed, R.botTrump(L.seed, a));
      else R.applyPlay(L.g, a, R.botPlay(L.g, L.seed, a), null);
      return L;
    })(), null, null).catch(() => false);
    if (!ok) continue; // qualcun altro ha mosso: rileggo
  }
}

const bg = (p: Promise<unknown>) => {
  // @ts-ignore EdgeRuntime esiste nel runtime Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p); else p.catch(() => {});
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ errore: "Metodo non ammesso" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ errore: "Richiesta non valida" }, 400); }
  const { azione, tavolo } = body;
  const token = String(body.token || "");
  if (token.length < 16 || token.length > 100) return json({ errore: "Chiave giocatore mancante" }, 400);

  try {
    const me = await hash(token);
    const seatOf = (L: Load) => L.posti.findIndex((p) => p === me);

    if (azione === "crea") {
      const nick = cleanNick(body.nick) || fail("Scrivi il tuo nome");
      const id = "t" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
      const stato = { hostNick: nick, seats: [{ nick, bot: false }, null, null, null], status: "lobby", scores: [0, 0], history: [], hand: null, log: [], winner: null };
      try {
        await rest("tavoli", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id, nome: "Tavolo di " + nick, stato }) });
        await rest("segreti", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tavolo_id: id, host: me, posti: [me, null, null, null] }) });
      } catch (_) { fail("Non riesco a creare il tavolo"); }
      return json({ id });
    }

    if (typeof tavolo !== "string" || !/^t[a-z0-9]{4,20}$/.test(tavolo)) fail("Tavolo non valido");

    const ioOf = (L: Load) => {
      const s = seatOf(L);
      const mano = s >= 0 && L.g.hand && L.seed != null ? R.handOf(L.g, L.seed, s) : [];
      const legali = s >= 0 && L.g.status === "play" && L.g.hand.turn === s && L.seed != null ? R.legal(L.g, L.seed, s) : [];
      return { seat: s, host: L.host === me, mano, legali, n: L.g.hand ? L.g.hand.n : 0 };
    };
    if (azione === "info") {
      const L = await load(tavolo);
      return json({ ...ioOf(L), stato: L.g, versione: L.ver });
    }

    let cpu = false;
    const done = await mossa(tavolo, (L) => {
      const g = L.g, s = seatOf(L), host = L.host === me;
      const posti = L.posti.slice();
      switch (azione) {
        case "siedi": {
          const i = Number(body.seat), nick = cleanNick(body.nick) || fail("Scrivi il tuo nome");
          if (g.status !== "lobby") fail("La partita è già iniziata");
          if (!(i >= 0 && i < 4) || g.seats[i]) fail("Posto occupato");
          if (s >= 0) { g.seats[s] = null; posti[s] = null; }
          g.seats[i] = { nick, bot: false }; posti[i] = me;
          return { posti };
        }
        case "alzati": {
          const i = Number(body.seat);
          if (g.status !== "lobby" || !g.seats[i]) fail("Non puoi alzarti adesso");
          if (i !== s && !host) fail("Non è il tuo posto");
          g.seats[i] = null; posti[i] = null;
          return { posti };
        }
        case "cpu": {
          const i = Number(body.seat);
          if (!host) fail("Solo chi ha aperto il tavolo aggiunge CPU");
          if (g.status !== "lobby" || !(i >= 0 && i < 4) || g.seats[i]) fail("Posto occupato");
          g.seats[i] = { nick: R.BOT_NAMES[i], bot: true }; posti[i] = null;
          return { posti };
        }
        case "inizia": {
          if (!host) fail("Solo chi ha aperto il tavolo dà le carte");
          if (g.status !== "lobby" || g.seats.some((x: any) => !x)) fail("Servono 4 giocatori");
          g.scores = [0, 0]; g.history = []; g.log = []; g.winner = null;
          cpu = true;
          return { seed: R.newHand(g, 1, null) };
        }
        case "briscola": {
          if (g.status !== "trump" || g.hand.leader !== s) fail("Non tocca a te scegliere");
          if (!R.SUITS.includes(body.seme)) fail("Seme non valido");
          R.chooseTrump(g, L.seed, body.seme); cpu = true;
          return;
        }
        case "gioca": {
          if (g.status !== "play" || g.hand.turn !== s) fail("Non è il tuo turno");
          if (!R.legal(g, L.seed, s).includes(body.carta)) fail("Devi rispondere al seme");
          const sig = ["busso", "striscio", "volo"].includes(body.segnale) ? body.segnale : null;
          R.applyPlay(g, s, body.carta, sig); cpu = true;
          return;
        }
        case "prossima": {
          if (g.status !== "handEnd") fail("La mano non è finita");
          if (s < 0 && !host) fail("Non sei al tavolo");
          cpu = true;
          return { seed: R.newHand(g, g.hand.n + 1, (g.hand.leader + 1) % 4) };
        }
        case "rivincita": {
          if (g.status !== "end") fail("La partita non è finita");
          if (s < 0 && !host) fail("Non sei al tavolo");
          g.status = "lobby"; g.hand = null; g.scores = [0, 0]; g.history = []; g.winner = null;
          return;
        }
        default: fail("Azione sconosciuta");
      }
    });
    if (cpu) bg(giocaCpu(tavolo));
    return json({ ok: true, ...ioOf(done as Load), stato: (done as Load).g, versione: (done as Load).ver });
  } catch (e) {
    if (e instanceof Errore) return json({ errore: e.message }, 400);
    console.error(e);
    return json({ errore: "Errore del server" }, 500);
  }
});
