// Funzione "beccaccino": unico punto in cui lo stato del tavolo cambia.
// Il mazzo (seed) e le chiavi dei giocatori stanno in tabelle che legge solo il server.
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
const enc = encodeURIComponent;

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
const isDup = (e: unknown) => String(e).includes("409") || String(e).includes("23505");

async function hash(token: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("becca:" + token));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// codici senza lettere che si confondono (niente O/0, I/1, L)
const ALFA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function nuovoCodice(n: number) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALFA[x % ALFA.length]).join("");
}
const cleanNick = (n: unknown) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
const cleanAvatar = (a: unknown) => { const n = Number(a); return a !== null && a !== "" && Number.isInteger(n) && n >= 0 && n <= 11 ? n : null; };

// ---------- profili ----------
type Profilo = { id: string; codice: string; nick: string; avatar: number | null };
async function profiloDi(keyHash: string): Promise<Profilo> {
  const k = await rest(`chiavi?hash=eq.${enc(keyHash)}&select=giocatore`);
  if (k && k[0]) {
    const p = await rest(`giocatori?id=eq.${enc(k[0].giocatore)}&select=id,codice,nick,avatar`);
    if (p && p[0]) return p[0];
  }
  // primo accesso da questo telefono: il profilo prende l'impronta della chiave come id
  // (così chi era già seduto a un tavolo resta riconosciuto)
  for (let i = 0; i < 6; i++) {
    try {
      await rest("giocatori", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: keyHash, codice: nuovoCodice(6) }) });
      break;
    } catch (e) {
      if (!isDup(e)) throw e;
      const gia = await rest(`giocatori?id=eq.${enc(keyHash)}&select=id`);
      if (gia && gia[0]) break; // esisteva già: era il codice a essere doppio? no, è lo stesso id
    }
  }
  await rest("chiavi", { method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: JSON.stringify({ hash: keyHash, giocatore: keyHash }) });
  const p = await rest(`giocatori?id=eq.${enc(keyHash)}&select=id,codice,nick,avatar`);
  return p[0];
}

// ---------- tavoli ----------
type Load = { g: any; ver: number; seed: number | null; posti: (string | null)[]; host: string; codice: string | null };
async function load(id: string): Promise<Load> {
  const q = enc(id);
  const [ts, ss] = await Promise.all([
    rest(`tavoli?id=eq.${q}&select=stato,versione,codice`),
    rest(`segreti?tavolo_id=eq.${q}&select=seed,posti,host`),
  ]);
  const t = ts && ts[0], s = ss && ss[0];
  if (!t || !s) fail("Tavolo non trovato");
  return { g: t!.stato, ver: t!.versione, seed: s!.seed, posti: s!.posti, host: s!.host, codice: t!.codice ?? null };
}
// segna quando è cominciato il turno di qualcuno: serve per il tempo di gioco
function touchTurn(g: any) {
  if (!g.hand) return;
  const a = R.actor(g);
  if (a !== g.hand.turnActor) { g.hand.turnActor = a; g.hand.turnAt = Date.now(); }
}
async function save(id: string, L: Load, seed: number | null, posti: (string | null)[] | null) {
  touchTurn(L.g);
  const data = await rest("rpc/salva_tavolo", { method: "POST", body: JSON.stringify({ p_id: id, p_ver: L.ver, p_stato: L.g, p_seed: seed, p_posti: posti }) });
  return data === true;
}
async function mossa(id: string, fn: (L: Load) => { seed?: number; posti?: (string | null)[] } | void) {
  for (let i = 0; i < 4; i++) {
    const L = await load(id);
    const prima = L.g.status;
    const out = fn(L) || {};
    if (await save(id, L, out.seed ?? null, out.posti ?? null)) {
      if (prima !== "end" && L.g.status === "end") await registraFine(id, L);
      if (out.posti) L.posti = out.posti;
      if (out.seed != null) L.seed = out.seed;
      L.ver += 1;
      return L;
    }
  }
  fail("Il tavolo è molto trafficato, riprova");
}
// partita finita: una riga nello storico per la classifica
async function registraFine(id: string, L: Load) {
  const g = L.g;
  const giocatori = [0, 1, 2, 3].map((s) => ({
    pid: g.seats[s] && !g.seats[s].bot ? L.posti[s] : null,
    nick: g.seats[s] ? g.seats[s].nick : "", avatar: g.seats[s] ? g.seats[s].avatar ?? null : null,
    bot: !!(g.seats[s] && g.seats[s].bot), team: s % 2,
  }));
  await rest("partite", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tavolo: id, giocatori, punteggi: g.scores, vincitori: g.winner, mani: (g.history || []).length }) }).catch((e) => console.error("storico", e));
}
const automatico = (g: any, s: number) => !!(g.seats[s] && (g.seats[s].bot || g.seats[s].away));

// Le CPU (e chi è assente) giocano sul server, una carta alla volta, con una pausa per farle vedere.
async function giocaCpu(id: string) {
  for (let i = 0; i < 80; i++) {
    let L: Load;
    try { L = await load(id); } catch { return; }
    const a = R.actor(L.g);
    if (a < 0 || !automatico(L.g, a)) return;
    await sleep(L.g.hand.trick.length === 4 ? 950 : 550);
    const prima = L.g.status;
    const ok = await save(id, (() => {
      if (L.g.status === "trump") R.chooseTrump(L.g, L.seed, R.botTrump(L.seed, a));
      else { const c = R.botPlay(L.g, L.seed, a); R.applyPlay(L.g, a, c, R.botSignal(L.g, L.seed, a, c)); }
      return L;
    })(), null, null).catch(() => false);
    if (!ok) continue;
    if (prima !== "end" && L.g.status === "end") await registraFine(id, L);
  }
}
const bg = (p: Promise<unknown>) => {
  // @ts-ignore EdgeRuntime esiste nel runtime Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p); else p.catch(() => {});
};
function cpuAvatar(g: any) {
  const usati = new Set(g.seats.filter(Boolean).map((x: any) => x.avatar).filter((x: any) => x != null));
  const liberi = Array.from({ length: 12 }, (_, i) => i).filter((i) => !usati.has(i));
  return liberi.length ? liberi[Math.floor(Math.random() * liberi.length)] : Math.floor(Math.random() * 12);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ errore: "Metodo non ammesso" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ errore: "Richiesta non valida" }, 400); }
  const { azione, tavolo } = body;
  const token = String(body.token || "");
  if (token.length < 16 || token.length > 100) return json({ errore: "Chiave giocatore mancante" }, 400);

  try {
    const keyHash = await hash(token);
    let P = await profiloDi(keyHash);
    const me = P.id;
    const seatOf = (L: Load) => L.posti.findIndex((p) => p === me);

    // ----- profilo -----
    if (azione === "profilo") {
      const patch: any = { seen_at: new Date().toISOString() };
      const n = cleanNick(body.nick); if (n) patch.nick = n;
      const a = cleanAvatar(body.avatar); if (a != null) patch.avatar = a;
      const r = await rest(`giocatori?id=eq.${enc(me)}&select=id,codice,nick,avatar`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
      P = r[0];
      return json({ profilo: { codice: P.codice, nick: P.nick, avatar: P.avatar } });
    }
    if (azione === "recupera") {
      const code = String(body.codice || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 6) fail("Il codice personale ha 6 caratteri");
      const p = await rest(`giocatori?codice=eq.${enc(code)}&select=id,codice,nick,avatar`);
      if (!p || !p[0]) fail("Nessun giocatore con questo codice");
      await rest(`chiavi?hash=eq.${enc(keyHash)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ giocatore: p[0].id }) });
      return json({ profilo: { codice: p[0].codice, nick: p[0].nick, avatar: p[0].avatar } });
    }
    if (azione === "miei") {
      const ss = await rest(`segreti?posti=cs.${enc(JSON.stringify([me]))}&select=tavolo_id`);
      const ids = (ss || []).map((x: any) => x.tavolo_id);
      if (!ids.length) return json({ tavoli: [] });
      const since = new Date(Date.now() - 2 * 86400e3).toISOString();
      const ts = await rest(`tavoli?id=in.(${ids.map(enc).join(",")})&updated_at=gte.${enc(since)}&select=id,nome,stato,updated_at&order=updated_at.desc&limit=5`);
      return json({ tavoli: (ts || []).filter((t: any) => !["closed", "end"].includes(t.stato.status)) });
    }

    if (azione === "storico") {
      const rows = await rest(`partite?giocatori=cs.${enc(JSON.stringify([{ pid: me }]))}&select=finita_at,giocatori,punteggi,vincitori,mani&order=finita_at.desc&limit=25`);
      const out = (rows || []).map((r: any) => {
        const mio = r.giocatori.find((x: any) => x.pid === me);
        const t = mio ? mio.team : 0;
        const nomi = (tt: number) => r.giocatori.filter((x: any) => x.team === tt).map((x: any) => ({ nick: x.nick, avatar: x.avatar, bot: x.bot }));
        return { data: r.finita_at, noi: nomi(t), loro: nomi(1 - t), punti: [r.punteggi[t], r.punteggi[1 - t]], vinto: r.vincitori === t, mani: r.mani };
      });
      return json({ partite: out });
    }

    if (azione === "crea") {
      const nick = cleanNick(P.nick || body.nick) || fail("Scrivi il tuo nome");
      const id = "t" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
      const stato = { hostNick: nick, seats: [{ nick, bot: false, avatar: P.avatar }, null, null, null], status: "lobby", scores: [0, 0], history: [], hand: null, log: [], winner: null };
      let codice = "";
      for (let i = 0; i < 6 && !codice; i++) {
        const c = nuovoCodice(4);
        try {
          await rest("tavoli", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id, nome: "Tavolo di " + nick, stato, codice: c }) });
          codice = c;
        } catch (e) { if (!isDup(e)) fail("Non riesco a creare il tavolo"); }
      }
      if (!codice) fail("Non riesco a creare il tavolo, riprova");
      try {
        await rest("segreti", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ tavolo_id: id, host: me, posti: [me, null, null, null] }) });
      } catch (_) { fail("Non riesco a creare il tavolo"); }
      return json({ id, codice });
    }

    if (typeof tavolo !== "string" || !/^t[a-z0-9]{4,20}$/.test(tavolo)) fail("Tavolo non valido");

    const ioOf = (L: Load) => {
      const s = seatOf(L);
      const mano = s >= 0 && L.g.hand && L.seed != null ? R.handOf(L.g, L.seed, s) : [];
      const legali = s >= 0 && L.g.status === "play" && L.g.hand.turn === s && L.seed != null ? R.legal(L.g, L.seed, s) : [];
      return { seat: s, host: L.host === me, mano, legali, n: L.g.hand ? L.g.hand.n : 0, codice: L.g.status === "closed" ? null : L.codice };
    };
    if (azione === "info") {
      const L = await load(tavolo);
      return json({ ...ioOf(L), stato: L.g, versione: L.ver });
    }

    let cpu = false;
    const done = await mossa(tavolo, (L) => {
      const g = L.g, s = seatOf(L), host = L.host === me;
      const posti = L.posti.slice();
      if (g.status === "closed" && azione !== "chiudi") fail("Questo tavolo è stato chiuso");
      // chi agisce è presente: se giocava la CPU per lui, riprende il posto
      if (s >= 0 && g.seats[s] && g.seats[s].away && azione !== "sveglia") { delete g.seats[s].away; }
      switch (azione) {
        case "siedi": {
          const i = Number(body.seat), nick = cleanNick(P.nick || body.nick) || fail("Scrivi il tuo nome");
          if (g.status !== "lobby") fail("La partita è già iniziata");
          if (!(i >= 0 && i < 4) || g.seats[i]) fail("Posto occupato");
          if (s >= 0) { g.seats[s] = null; posti[s] = null; }
          g.seats[i] = { nick, bot: false, avatar: P.avatar }; posti[i] = me;
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
          g.seats[i] = { nick: R.BOT_NAMES[i], bot: true, avatar: cpuAvatar(g) }; posti[i] = null;
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
        case "presente": {
          if (s < 0) fail("Non sei al tavolo");
          cpu = true; // se tocca a una CPU, riparte
          return;
        }
        case "sveglia": {
          // un giocatore non tocca carta da 60 secondi: gioca la CPU al posto suo finché non torna
          const t = Number(body.seat);
          if (!["trump", "play"].includes(g.status) || R.actor(g) !== t) fail("Non tocca a quel giocatore");
          if (!g.seats[t] || g.seats[t].bot || g.seats[t].away) return;
          if (Date.now() - Number(g.hand.turnAt || 0) < 58000) fail("Ha ancora tempo per giocare");
          g.seats[t].away = true; cpu = true;
          g.log = (g.log || []).concat([`${g.seats[t].nick} è via: gioca la CPU per lui`]).slice(-6);
          return;
        }
        case "chiudi": {
          if (!host) fail("Solo chi ha aperto il tavolo può chiuderlo");
          if (g.status === "closed") return;
          g.status = "closed";
          return;
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
    if (azione === "chiudi") {
      await rest(`tavoli?id=eq.${enc(tavolo)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ codice: null }) }).catch(() => {});
    }
    if (cpu) bg(giocaCpu(tavolo));
    return json({ ok: true, ...ioOf(done as Load), stato: (done as Load).g, versione: (done as Load).ver });
  } catch (e) {
    if (e instanceof Errore) return json({ errore: e.message }, 400);
    console.error(e);
    return json({ errore: "Errore del server" }, 500);
  }
});
