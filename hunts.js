// Banco coletivo de hunts da extensão Sigma Hunt ("comunidade").
// Cada jogador que ACEITOU compartilhar manda, de tempos em tempos, as medições das hunts dele:
//   facts  fatos da hunt, que valem para qualquer líder: vida do selvagem, intervalo entre encontros,
//          chance de vizinho no golpe em área, loot por abate e a diferença da parte escondida do XP;
//   runs   resultado do líder: tempo e abates por hunt + espécie do líder + faixa de força do líder.
// O servidor guarda UMA ficha por instalação (o envio novo substitui o anterior, então repetir não infla nada),
// junta tudo por mediana e devolve em GET /api/hunts/stats, que a extensão usa no "Onde caçar?".
// Quem desliga o compartilhamento na extensão tem a ficha apagada (POST com forget: true).
// Não guarda nome, conta, token nem IP: a instalação vira um código embaralhado (HMAC do id aleatório da extensão).
// Os dados ficam em data/hunts.json no repositório, gravados pela API do GitHub com "[skip render]" no commit
// (igual às visitas), porque o disco do Render gratuito é apagado a cada deploy.
//   GITHUB_TOKEN / GITHUB_REPO   os mesmos dos banners
//   ANALYTICS_SALT               opcional; se faltar, usa ADMIN_PASSWORD
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const FILE = "data/hunts.json";
const KEEP_DAYS = 60;                  // instalação que não envia há 60 dias sai da conta
const MAX_FACTS = 300, MAX_RUNS = 300; // por relatório
const MIN_RUN_MS = 5 * 60000;          // resultado de líder só entra com 5 min de hunt...
const MIN_RUN_KILLS = 30;              // ...e 30 abates
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const DAY = 86400000;

const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const int = (v, min, max) => { const n = num(v, min, max); return n === null ? null : Math.round(n); };
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const median = a => { const v = a.slice().sort((x, y) => x - y), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// Confere e encolhe um relatório. Devolve { f, r } só com o que passou, ou null se nada serviu.
export function cleanReport(body) {
  const f = {}, r = {};
  const facts = body && typeof body.facts === "object" && body.facts && !Array.isArray(body.facts) ? body.facts : {};
  for (const slug of Object.keys(facts).slice(0, MAX_FACTS)) {
    const x = facts[slug];
    if (!SLUG.test(slug) || !x || typeof x !== "object") continue;
    const o = {};
    const hp = int(x.hp, 1, 1e7); if (hp !== null) o.h = hp;                                   // vida do selvagem
    const walk = num(x.walk, 100, 10000), eng = int(x.eng, 30, 1e7);                           // intervalo entre encontros (ms), com 30+ encontros
    if (walk !== null && eng !== null) { o.w = Math.round(walk); o.e = eng; }
    const extra = num(x.extra, 0, 0.9); if (extra !== null) o.x = round(extra, 2);             // vizinho no golpe em área
    const loot = num(x.loot, 0, 1e6), lk = int(x.lk, 150, 1e8);                                // loot por abate (ouro), com 150+ abates
    if (loot !== null && lk !== null) { o.l = round(loot, 1); o.k = lk; }
    const xd = num(x.xd, -1, 3), xn = int(x.xn, 20, 1e8);                                      // diferença da parte escondida do XP, com 20+ abates
    if (xd !== null && xn !== null) { o.d = round(xd, 3); o.n = xn; }
    if (Object.keys(o).length) f[slug] = o;
  }
  const runs = body && Array.isArray(body.runs) ? body.runs : [];
  for (const x of runs.slice(0, MAX_RUNS)) {
    if (!x || typeof x !== "object" || typeof x.slug !== "string" || !SLUG.test(x.slug)) continue;
    const sp = int(x.sp, 1, 5000), fb = int(x.fb, 1, 400), ms = int(x.ms, 60000, 3.6e9), kills = int(x.kills, 1, 1e7);
    if (sp === null || fb === null || ms === null || kills === null) continue;
    const kh = kills / (ms / 3600000);
    if (kh < 10 || kh > 12000) continue;                                                       // abates/h impossível
    r[`${x.slug}|${sp}|${fb}`] = [ms, kills];
  }
  return Object.keys(f).length || Object.keys(r).length ? { f, r } : null;
}

export function createHunts({ rootDir, minGapMs = 30000, ipMax = 30, ipNewMax = 8, maxBytes = 900 * 1024, maxInstalls = 5000,
  checkEveryMs = 2 * 60000, quietMs = 8 * 60000, maxWaitMs = 60 * 60000, retryMs = 5000 }) {
  const { GITHUB_TOKEN = "", GITHUB_REPO = "MisterAlface/sigma-radar", ADMIN_PASSWORD = "", ANALYTICS_SALT = "" } = process.env;
  const API = process.env.GITHUB_API_BASE || "https://api.github.com";
  const salt = ANALYTICS_SALT || ADMIN_PASSWORD || "sigma-radar";
  const BOOT = Date.now();
  const today = () => Math.floor(Date.now() / DAY);
  const keyOf = id => crypto.createHmac("sha256", salt).update("hunts:" + id).digest("base64url").slice(0, 16);

  // db.inst[código] = { t: dia do último envio, f: { slug: {h,w,e,x,l,k,d,n} }, r: { "slug|espécie|faixa": [ms, abates] } }
  let db = { v: 1, since: new Date().toISOString().slice(0, 10), savedAt: 0, inst: {} };
  let dirty = new Set();   // instalações com ficha nova que ainda não está no GitHub
  let isReady = false, loaded = 0, lastSaved = 0, lastReportAt = 0, cache = null;

  // ---------- GitHub ----------
  async function gh(opts = {}) {
    const r = await fetch(`${API}/repos/${GITHUB_REPO}/contents/${FILE}${opts.method ? "" : "?ref=main"}`, {
      ...opts,
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sigma-radar-site", ...(opts.headers || {}) },
    });
    if (r.status === 404 && !opts.method) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`GitHub ${opts.method || "GET"} ${FILE} -> ${r.status}: ${data.message || ""}`); e.status = r.status; throw e; }
    return data;
  }
  const readRemote = async () => {
    const cur = await gh();
    if (!cur) return { sha: null, data: null };
    let data = null;
    try { data = JSON.parse(Buffer.from(cur.content || "", "base64").toString("utf8")); } catch {}
    return { sha: cur.sha, data };
  };
  const instOf = d => {
    const out = {};
    if (!d || typeof d !== "object" || !d.inst || typeof d.inst !== "object") return out;
    for (const [k, v] of Object.entries(d.inst)) {
      if (!/^[A-Za-z0-9_-]{8,32}$/.test(k) || !v || typeof v !== "object" || !(v.t > 0)) continue;
      out[k] = { t: v.t, f: v.f && typeof v.f === "object" ? v.f : {}, r: v.r && typeof v.r === "object" ? v.r : {} };
    }
    return out;
  };
  // uma instalação por linha e em ordem: o git guarda só a diferença entre uma gravação e outra
  const serialize = d => `{"v":1,"since":${JSON.stringify(d.since)},"savedAt":${d.savedAt},"inst":{\n` +
    Object.keys(d.inst).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(d.inst[k])}`).join(",\n") + "\n}}\n";
  // tira quem venceu e, se passar do teto, as instalações mais antigas (quem acabou de enviar fica)
  function prune(d) {
    const t = today();
    for (const [k, v] of Object.entries(d.inst)) if (t - v.t > KEEP_DAYS) delete d.inst[k];
    const byAge = Object.keys(d.inst).sort((a, b) => d.inst[a].t - d.inst[b].t || (dirty.has(a) ? 1 : 0) - (dirty.has(b) ? 1 : 0));
    while (byAge.length > maxInstalls) delete d.inst[byAge.shift()];
    let size = Buffer.byteLength(serialize(d));
    while (size > maxBytes && byAge.length > 1) {
      const k = byAge.shift();
      size -= Buffer.byteLength(JSON.stringify(k) + ":" + JSON.stringify(d.inst[k])) + 2;
      delete d.inst[k];
      if (size <= maxBytes) size = Buffer.byteLength(serialize(d)); // confere a conta de cabeça
    }
  }

  async function load() {
    if (!GITHUB_TOKEN) {
      try { const d = JSON.parse(fs.readFileSync(path.join(rootDir, FILE), "utf8")); db.inst = { ...instOf(d), ...db.inst }; db.since = d.since || db.since; loaded = Number(d.savedAt) || 0; } catch {}
      isReady = true; cache = null; // sem token fica só na memória
      return;
    }
    for (let i = 0; i < 3 && !isReady; i++) {
      try {
        const cur = await readRemote();
        if (cur.data) { db.inst = { ...instOf(cur.data), ...db.inst }; db.since = cur.data.since || db.since; loaded = Number(cur.data.savedAt) || 0; }
        isReady = true; cache = null;
      } catch (e) {
        console.error("[hunts] não consegui ler o banco coletivo:", e.message);
        await new Promise(r => setTimeout(r, retryMs * (i + 1)));
      }
    }
    if (!isReady) { console.error("[hunts] banco coletivo só na memória até conseguir ler o GitHub."); cache = null; }
  }

  let saving = null;
  async function save() {
    if (!GITHUB_TOKEN || !dirty.size) return;
    if (saving) return saving;
    saving = (async () => {
      const keys = [...dirty];
      try {
        for (let i = 0; i < 3; i++) {
          // lê o arquivo de agora e põe por cima só as fichas novas desta instância (não apaga o que outra instância gravou)
          const cur = await readRemote();
          const next = { v: 1, since: (cur.data && cur.data.since) || db.since, savedAt: Date.now(), inst: instOf(cur.data) };
          for (const k of keys) { if (db.inst[k]) next.inst[k] = db.inst[k]; else delete next.inst[k]; } // sem ficha = pediu para apagar
          prune(next);
          try {
            await gh({ method: "PUT", body: JSON.stringify({ message: "Hunts: atualizar banco coletivo [skip render]",
              content: Buffer.from(serialize(next)).toString("base64"), branch: "main", ...(cur.sha ? { sha: cur.sha } : {}) }) });
            for (const k of keys) dirty.delete(k);
            const mem = db.inst;
            db = { ...next, inst: { ...next.inst } };
            for (const k of dirty) if (mem[k]) db.inst[k] = mem[k]; // o que chegou durante a gravação continua pendente
            lastSaved = Date.now(); isReady = true; cache = null;
            return;
          } catch (e) {
            if (e.status === 409 || e.status === 422) continue; // outra instância gravou antes: lê de novo
            throw e;
          }
        }
        throw new Error("conflito repetido");
      } catch (e) {
        console.error("[hunts] não consegui salvar:", e.message);
      }
    })().finally(() => { saving = null; });
    return saving;
  }

  // ---------- contas ----------
  function aggregate() {
    const t = today(), F = {}, G = {};
    let players = 0;
    for (const v of Object.values(db.inst)) {
      if (t - v.t > KEEP_DAYS) continue;
      players++;
      for (const [slug, f] of Object.entries(v.f || {})) {
        const o = (F[slug] ||= { hp: [], walk: [], extra: [], loot: [], xd: [] });
        if (f.h > 0) o.hp.push(f.h);
        if (f.w > 0) o.walk.push(f.w);
        if (typeof f.x === "number") o.extra.push(f.x);
        if (typeof f.l === "number") o.loot.push(f.l);
        if (typeof f.d === "number") o.xd.push(f.d);
      }
      for (const [key, run] of Object.entries(v.r || {})) {
        const ms = Number(run && run[0]), kills = Number(run && run[1]);
        if (!(ms >= MIN_RUN_MS) || !(kills >= MIN_RUN_KILLS)) continue;
        const g = (G[key] ||= { kh: [], ms: 0 });
        g.kh.push(kills / (ms / 3600000)); g.ms += ms;
      }
    }
    // facts[slug] = { hp:[mediana, jogadores], walk:[...], extra:[...], loot:[...], xd:[...] }
    const facts = {};
    for (const [slug, o] of Object.entries(F)) {
      const out = {};
      if (o.hp.length) out.hp = [Math.round(median(o.hp)), o.hp.length];
      if (o.walk.length) out.walk = [Math.round(median(o.walk)), o.walk.length];
      if (o.extra.length) out.extra = [round(median(o.extra), 2), o.extra.length];
      if (o.loot.length) out.loot = [round(median(o.loot), 1), o.loot.length];
      if (o.xd.length) out.xd = [round(median(o.xd), 3), o.xd.length];
      if (Object.keys(out).length) facts[slug] = out;
    }
    // runs[slug] = [[espécie do líder, faixa de força, jogadores, abates/h (mediana), minutos somados], ...]
    const runs = {};
    for (const key of Object.keys(G).sort()) {
      const [slug, sp, fb] = key.split("|");
      (runs[slug] ||= []).push([Number(sp), Number(fb), G[key].kh.length, Math.round(median(G[key].kh)), Math.round(G[key].ms / 60000)]);
    }
    return { v: 1, players, since: db.since, boot: BOOT, loaded, facts, runs };
  }
  const stats = () => {
    if (!cache || Date.now() - cache.at > 60000) cache = { at: Date.now(), data: aggregate() };
    return cache.data;
  };

  // ---------- limites de envio (só na memória; nada de IP no arquivo) ----------
  const hits = new Map(), lastAt = new Map(), newByIp = new Map();
  function limited(ip) {
    const now = Date.now(), win = 10 * 60000;
    const arr = (hits.get(ip) || []).filter(x => now - x < win);
    arr.push(now); hits.set(ip, arr);
    return arr.length > ipMax;
  }
  function tooManyNew(ip) {
    const d = today(), cur = newByIp.get(ip);
    if (!cur || cur.d !== d) { newByIp.set(ip, { d, n: 1 }); return false; }
    return ++cur.n > ipNewMax;
  }
  const timers = [
    setInterval(() => {
      const now = Date.now();
      for (const [ip, a] of hits) if (!a.some(x => now - x < 600000)) hits.delete(ip);
      for (const [k, x] of lastAt) if (now - x > 3600000) lastAt.delete(k);
      for (const [ip, x] of newByIp) if (x.d !== today()) newByIp.delete(ip);
    }, 600000),
    // grava quando os relatórios param por um tempo (antes de o Render dormir) ou, com relatórios sem parar, uma vez por hora
    setInterval(() => {
      const now = Date.now();
      if (dirty.size && (now - lastReportAt >= quietMs || now - (lastSaved || BOOT) >= maxWaitMs)) save();
    }, checkEveryMs),
  ];
  timers.forEach(x => x.unref());

  // ---------- rotas ----------
  const router = express.Router();
  router.use("/api/hunts", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "86400");
    res.set("X-Robots-Tag", "noindex");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  router.get("/api/hunts/stats", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    const s = stats();
    const want = String(req.query.sp || "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!want.length) return res.json(s);
    const runs = {};
    for (const [slug, list] of Object.entries(s.runs)) {
      const keep = list.filter(g => want.includes(g[0]));
      if (keep.length) runs[slug] = keep;
    }
    res.json({ ...s, runs });
  });

  router.post("/api/hunts/report", express.json({ limit: "64kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = req.body;
    if (!body || typeof body !== "object" || typeof body.id !== "string" || !ID.test(body.id)) return res.status(400).json({ error: "Relatório inválido." });
    if (limited(req.ip)) return res.status(429).set("Retry-After", "600").json({ error: "Muitos envios em pouco tempo." });
    const key = keyOf(body.id), now = Date.now();
    // o jogador desligou o compartilhamento: apaga a ficha desta instalação
    if (body.forget === true) {
      const had = !!db.inst[key];
      if (had) { delete db.inst[key]; dirty.add(key); lastReportAt = now; cache = null; }
      lastAt.delete(key);
      return res.json({ ok: true, forgotten: had, at: now, players: stats().players });
    }
    const wait = minGapMs - (now - (lastAt.get(key) || 0));
    if (wait > 0) return res.status(429).set("Retry-After", String(Math.ceil(wait / 1000))).json({ error: "Aguarde para enviar de novo." });
    const clean = cleanReport(body);
    if (!clean) return res.status(400).json({ error: "Relatório sem nenhuma medição válida." });
    if (!db.inst[key] && tooManyNew(req.ip)) return res.status(429).set("Retry-After", "3600").json({ error: "Muitas instalações novas deste endereço hoje." });
    lastAt.set(key, now);
    if (!db.inst[key] && Object.keys(db.inst).length >= maxInstalls) prune(db); // memória cheia: saem as mais antigas
    db.inst[key] = { t: today(), f: clean.f, r: clean.r };
    dirty.add(key); lastReportAt = now; cache = null;
    res.json({ ok: true, at: now, players: stats().players, accepted: { facts: Object.keys(clean.f).length, runs: Object.keys(clean.r).length } });
  });

  // corpo grande demais ou JSON quebrado: responde em JSON em vez de cair na página do site
  router.use("/api/hunts", (err, req, res, next) => {
    res.status(err && err.status === 413 ? 413 : 400).json({ error: err && err.status === 413 ? "Relatório grande demais." : "Relatório inválido." });
  });

  const whenReady = load();
  return { router, save, stats, ready: () => whenReady, stop: () => timers.forEach(clearInterval) };
}
