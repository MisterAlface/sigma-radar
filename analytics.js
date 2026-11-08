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
  let sha = null, dirty = false, ready = false, lastSaved = null;
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

  function adopt(saved) {
    if (!saved || typeof saved !== "object" || !saved.days) return;
    // soma o que já foi contado enquanto o arquivo carregava (o site acorda com a primeira visita)
    for (const [k, m] of Object.entries(db.days)) {
      const s = (saved.days[k] ||= { views: 0, uniq: 0, mob: 0, desk: 0, ref: {}, h: [] });
      s.h ||= []; s.ref ||= {};
      const had = new Set(s.h);
      s.views += m.views;
      for (const c of m.h || []) if (!had.has(c)) { s.h.push(c); s.uniq++; }
      s.mob += m.mob; s.desk += m.desk;
      for (const [r, n] of Object.entries(m.ref || {})) s.ref[r] = (s.ref[r] || 0) + n;
    }
    db = { v: 1, since: saved.since || db.since, days: saved.days };
    const t = db.days[brDay()];
    if (t?.h) t.h.forEach(x => seenToday.add(x));
  }

  async function load() {
    if (!GITHUB_TOKEN) {
      try { adopt(JSON.parse(fs.readFileSync(path.join(rootDir, FILE), "utf8"))); } catch {}
      ready = true; // sem token conta só na memória
      return;
    }
    for (let i = 0; i < 3 && !ready; i++) {
      try {
        const cur = await gh();
        if (cur) { sha = cur.sha; adopt(JSON.parse(Buffer.from(cur.content, "base64").toString("utf8"))); }
        ready = true;
      } catch (e) {
        console.error("[visitas] não consegui ler o contador:", e.message);
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      }
    }
    if (!ready) console.error("[visitas] contando só na memória até conseguir ler o GitHub.");
  }

  function prune() {
    const today = brDay(), keys = Object.keys(db.days).sort();
    for (const k of keys) if (k !== today) delete db.days[k].h; // códigos só do dia atual
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete db.days[k];
  }

  let saving = null;
  async function save() {
    if (!GITHUB_TOKEN || !ready || !dirty) return;
    if (saving) return saving;
    saving = (async () => {
      prune();
      dirty = false;
      const body = Buffer.from(JSON.stringify(db) + "\n").toString("base64");
      for (let i = 0; i < 2; i++) {
        try {
          const r = await gh({ method: "PUT", body: JSON.stringify({ message: "Visitas: atualizar contador [skip render]", content: body, branch: "main", ...(sha ? { sha } : {}) }) });
          sha = r.content?.sha || null; lastSaved = new Date().toISOString();
          return;
        } catch (e) {
          if (e.status === 409 || e.status === 422) { const cur = await gh().catch(() => null); sha = cur?.sha || null; continue; }
          console.error("[visitas] não consegui salvar:", e.message);
          break;
        }
      }
      dirty = true;
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
    d.views++;
    live.set(code, Date.now());
    if (!seenToday.has(code)) {
      seenToday.add(code); d.h.push(code); d.uniq++;
      if (/Mobi|Android|iPhone|iPad/i.test(ua)) d.mob++; else d.desk++;
      let host = "";
      try { host = new URL(req.get("referer") || "").hostname.replace(/^www\./, ""); } catch {}
      if (host && !host.endsWith("onrender.com")) {
        const k = /discord/.test(host) ? "discord" : /google\./.test(host) ? "google" : /youtube|youtu\.be/.test(host) ? "youtube" : /twitch/.test(host) ? "twitch" : host;
        if (d.ref[k] || Object.keys(d.ref).length < 30) d.ref[k] = (d.ref[k] || 0) + 1;
      }
    }
    dirty = true;
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
  router.get("/api/admin/visits", auth, (req, res) => { res.set("Cache-Control", "no-store"); res.json(summary()); });
  return { track, router, save };
}
