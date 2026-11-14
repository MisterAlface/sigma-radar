// Contador de visitas do site, visto no painel /admin.
// Sem cookies e sem guardar IP: cada visitante vira um código embaralhado que muda todo dia
// (HMAC de IP + navegador + data), só para contar "pessoas diferentes por dia".
// Os números ficam em data/visits.json no repositório, gravados pela API do GitHub com "[skip render]"
// no commit, para não disparar um novo deploy a cada gravação.
//   GITHUB_TOKEN / GITHUB_REPO  os mesmos dos banners
//   ANALYTICS_SALT              opcional; se faltar, usa ADMIN_PASSWORD
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|embed|monitor|uptime|curl|wget|python|node-fetch|axios|go-http|headless|lighthouse|render|scan/i;
const FILE = "data/visits.json";
const KEEP_DAYS = 400;
const SAVE_EVERY = 10 * 60 * 1000;

export function createAnalytics({ rootDir, auth }) {
  const { GITHUB_TOKEN = "", GITHUB_REPO = "MisterAlface/sigma-radar", ADMIN_PASSWORD = "", ANALYTICS_SALT = "" } = process.env;
  const salt = ANALYTICS_SALT || ADMIN_PASSWORD || "sigma-radar";
  const brDay = (t = Date.now()) => new Date(t - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília

  // db.days[AAAA-MM-DD] = { views, uniq, mob, desk, ref: {site: n}, h: [códigos de hoje] }
  let db = { v: 1, since: brDay(), days: {} };
  let ready = false, lastSaved = null;
  const seenToday = new Set();
  let seenDay = brDay();
  const live = new Map(); // código -> último acesso (para "agora no site")

  // ---------- GitHub ----------
  async function gh(opts = {}) {
    const r = await fetch(`${process.env.GITHUB_API_BASE || "https://api.github.com"}/repos/${GITHUB_REPO}/contents/${FILE}${opts.method ? "" : "?ref=main"}`, {
      ...opts,
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sigma-radar-site", ...(opts.headers || {}) },
    });
    if (r.status === 404 && !opts.method) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`GitHub ${opts.method || "GET"} ${FILE} -> ${r.status}: ${data.message || ""}`); e.status = r.status; throw e; }
    return data;
  }

  // O que foi contado nesta instância e ainda não está no GitHub. Na hora de salvar, soma isso ao arquivo
  // atual do GitHub (em vez de sobrescrever), assim nada se perde quando o Render troca de instância num deploy.
  let pending = {};
  const blank = () => ({ views: 0, uniq: 0, mob: 0, desk: 0, ref: {}, h: [], clk: {}, cu: {} });
  const pend = day => (pending[day] ||= { views: 0, ref: {}, h: new Map(), clk: {}, cu: {} }); // h: código -> é celular

  function merged(saved, delta) {
    const out = { v: 1, since: saved?.since || db.since, days: structuredClone(saved?.days || {}) };
    for (const [k, m] of Object.entries(delta)) {
      const s = (out.days[k] ||= blank());
      s.ref ||= {};
      s.views += m.views;
      for (const [r, n] of Object.entries(m.ref)) s.ref[r] = (s.ref[r] || 0) + n;
      s.clk ||= {}; s.cu ||= {}; for (const [r, n] of Object.entries(m.clk || {})) s.clk[r] = (s.clk[r] || 0) + n; for (const [r, n] of Object.entries(m.cu || {})) s.cu[r] = (s.cu[r] || 0) + n;
      if (s.h || k === brDay()) {
        s.h ||= [];
        const had = new Set(s.h);
        for (const [c, mob] of m.h) if (!had.has(c)) { s.h.push(c); s.uniq++; mob ? s.mob++ : s.desk++; }
      } else for (const mob of m.h.values()) { s.uniq++; mob ? s.mob++ : s.desk++; }
    }
    return out;
  }
  function adopt(saved) {
    db = merged(saved, pending);
    const t = db.days[brDay()];
    if (t?.h) t.h.forEach(x => seenToday.add(x));
  }
  const readRemote = async () => {
    const cur = await gh();
    return cur ? { sha: cur.sha, data: JSON.parse(Buffer.from(cur.content, "base64").toString("utf8")) } : { sha: null, data: null };
  };

  async function load() {
    if (!GITHUB_TOKEN) {
      try { adopt(JSON.parse(fs.readFileSync(path.join(rootDir, FILE), "utf8"))); } catch {}
      ready = true; // sem token conta só na memória
      return;
    }
    for (let i = 0; i < 3 && !ready; i++) {
      try {
        const cur = await readRemote();
        if (cur.data) adopt(cur.data);
        ready = true;
      } catch (e) {
        console.error("[visitas] não consegui ler o contador:", e.message);
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      }
    }
    if (!ready) console.error("[visitas] contando só na memória até conseguir ler o GitHub.");
  }

  function prune(d = db) {
    const today = brDay(), keys = Object.keys(d.days).sort();
    for (const k of keys) if (k !== today) delete d.days[k].h; // códigos só do dia atual
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete d.days[k];
  }

  let saving = null;
  async function save() {
    if (!GITHUB_TOKEN || !ready || !Object.keys(pending).length) return;
    if (saving) return saving;
    saving = (async () => {
      const delta = pending; pending = {};
      try {
        for (let i = 0; i < 3; i++) {
          const cur = await readRemote();
          const next = merged(cur.data, delta);
          prune(next);
          try {
            await gh({ method: "PUT", body: JSON.stringify({ message: "Visitas: atualizar contador [skip render]",
              content: Buffer.from(JSON.stringify(next) + "\n").toString("base64"), branch: "main", ...(cur.sha ? { sha: cur.sha } : {}) }) });
            db = merged(next, pending); // o que chegou durante a gravação continua pendente
            const t = db.days[brDay()];
            if (t?.h) t.h.forEach(x => seenToday.add(x));
            lastSaved = new Date().toISOString();
            return;
          } catch (e) {
            if (e.status === 409 || e.status === 422) continue; // outra instância gravou antes: lê de novo e soma
            throw e;
          }
        }
        throw new Error("conflito repetido");
      } catch (e) {
        console.error("[visitas] não consegui salvar:", e.message);
        for (const [k, m] of Object.entries(delta)) { // devolve para tentar de novo
          const p = pend(k);
          p.views += m.views;
          for (const [r, n] of Object.entries(m.ref)) p.ref[r] = (p.ref[r] || 0) + n;
          m.h.forEach((mob, c) => p.h.set(c, mob));
          for (const [r, n] of Object.entries(m.clk || {})) p.clk[r] = (p.clk[r] || 0) + n; for (const [r, n] of Object.entries(m.cu || {})) p.cu[r] = (p.cu[r] || 0) + n;
        }
      }
    })().finally(() => { saving = null; });
    return saving;
  }

  // ---------- contagem ----------
  function track(req) {
    if (req.method !== "GET") return;
    const ua = req.get("user-agent") || "";
    if (!ua || BOT.test(ua)) return;
    if (req.get("purpose") === "prefetch" || req.get("sec-purpose")?.includes("prefetch")) return;
    if (/(?:^|;\s*)sr_admin=/.test(req.headers.cookie || "")) return; // não conta o dono logado no painel
    const day = brDay();
    if (day !== seenDay) { seenDay = day; seenToday.clear(); prune(); }
    const d = (db.days[day] ||= { views: 0, uniq: 0, mob: 0, desk: 0, ref: {}, h: [] });
    d.h ||= [];
    const code = crypto.createHmac("sha256", salt).update(`${day}|${req.ip}|${ua}`).digest("base64url").slice(0, 12);
    const p = pend(day);
    d.views++; p.views++;
    live.set(code, Date.now());
    if (!seenToday.has(code)) {
      const mob = /Mobi|Android|iPhone|iPad/i.test(ua);
      seenToday.add(code); d.h.push(code); d.uniq++; p.h.set(code, mob);
      mob ? d.mob++ : d.desk++;
      let host = "";
      try { host = new URL(req.get("referer") || "").hostname.replace(/^www\./, ""); } catch {}
      if (host && !host.endsWith("onrender.com")) {
        const k = /discord/.test(host) ? "discord" : /google\./.test(host) ? "google" : /youtube|youtu\.be/.test(host) ? "youtube" : /twitch/.test(host) ? "twitch" : host;
        if (d.ref[k] || Object.keys(d.ref).length < 30) { d.ref[k] = (d.ref[k] || 0) + 1; p.ref[k] = (p.ref[k] || 0) + 1; }
      }
    }
  }

  // cliques em botões do site (ex.: "Precisando de diamantes?"), mesmas regras: sem IP, sem robôs, sem o dono logado
  const CLICK_KEYS = new Set(["diamantes"]);
  const clickSeen = new Set(); let clickDay = brDay();
  function click(req, key) {
    if (!CLICK_KEYS.has(key)) return false;
    const ua = req.get("user-agent") || "";
    if (!ua || BOT.test(ua)) return false;
    if (/(?:^|;\s*)sr_admin=/.test(req.headers.cookie || "")) return false;
    const day = brDay();
    if (day !== clickDay) { clickDay = day; clickSeen.clear(); }
    const d = (db.days[day] ||= blank()); d.clk ||= {}; d.cu ||= {};
    const p = pend(day); p.clk ||= {}; p.cu ||= {};
    d.clk[key] = (d.clk[key] || 0) + 1; p.clk[key] = (p.clk[key] || 0) + 1;
    const code = crypto.createHmac("sha256", salt).update(`${day}|${req.ip}|${ua}|${key}`).digest("base64url").slice(0, 12);
    if (!clickSeen.has(code)) { clickSeen.add(code); d.cu[key] = (d.cu[key] || 0) + 1; p.cu[key] = (p.cu[key] || 0) + 1; }
    return true;
  }

  function summary() {
    const now = Date.now(), today = brDay(now);
    for (const [k, t] of live) if (now - t > 5 * 60000) live.delete(k);
    const dayOf = n => brDay(now - n * 86400e3);
    const last = n => Array.from({ length: n }, (_, i) => dayOf(n - 1 - i));
    const row = d => ({ d, views: db.days[d]?.views || 0, uniq: db.days[d]?.uniq || 0 });
    const sum = (days, k) => days.reduce((s, d) => s + (db.days[d]?.[k] || 0), 0);
    const all = Object.keys(db.days);
    const d30 = last(30), d7 = last(7);
    const refs = {};
    for (const d of d30) for (const [k, n] of Object.entries(db.days[d]?.ref || {})) refs[k] = (refs[k] || 0) + n;
    const firstDay = all.sort()[0] || today;
    return {
      online: live.size,
      today: row(today), yesterday: row(dayOf(1)),
      last7: { views: sum(d7, "views"), uniq: sum(d7, "uniq") },
      last30: { views: sum(d30, "views"), uniq: sum(d30, "uniq"), mob: sum(d30, "mob"), desk: sum(d30, "desk") },
      total: { views: sum(all, "views"), uniq: sum(all, "uniq"), since: db.since < firstDay ? db.since : firstDay },
      series: d30.map(row),
      clicks: Object.fromEntries([...CLICK_KEYS].map(key => { const cs = days => ({ n: days.reduce((s, d) => s + (db.days[d]?.clk?.[key] || 0), 0), u: days.reduce((s, d) => s + (db.days[d]?.cu?.[key] || 0), 0) }); return [key, { today: cs([today]), d7: cs(d7), d30: cs(d30), all: cs(all) }]; })),
      refs: Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 8),
      saving: !!GITHUB_TOKEN, ready, lastSaved,
    };
  }

  // ---------- ligar ----------
  load();
  setInterval(save, SAVE_EVERY).unref();
  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => {
    if (closing) return; closing = true;
    await Promise.race([save(), new Promise(r => setTimeout(r, 8000))]);
    process.exit(0);
  });

  const router = express.Router();
  router.post("/api/click/:key", (req, res) => { try { click(req, String(req.params.key)); } catch (e) { console.error("[cliques]", e.message); } res.status(204).end(); });
  router.get("/api/admin/visits", auth, (req, res) => { res.set("Cache-Control", "no-store"); res.json(summary()); });
  return { track, router, save };
}
