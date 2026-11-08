// Outdoor de parceiros: lista de banners + painel /admin protegido por senha.
// Os banners ficam no próprio repositório (data/banners.json e banners/<id>.<ext>), gravados pela API do GitHub,
// porque o disco do Render gratuito é apagado a cada deploy.
//   ADMIN_PASSWORD  senha do painel /admin
//   GITHUB_TOKEN    token "fine-grained" do GitHub com permissão Contents: Read and write só no repositório do site
//   GITHUB_REPO     dono/repositório (padrão: MisterAlface/sigma-radar)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";

export const BANNER_W = 1280, BANNER_H = 640; // medida recomendada (proporção 2:1)
const MAX_BYTES = 1.5 * 1024 * 1024;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MIME = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));

export function createBanners({ rootDir }) {
  const { ADMIN_PASSWORD = "", GITHUB_TOKEN = "", GITHUB_REPO = "MisterAlface/sigma-radar" } = process.env;
  const listFile = path.join(rootDir, "data", "banners.json");
  const imgDir = path.join(rootDir, "banners");
  let banners = [];
  try { banners = JSON.parse(fs.readFileSync(listFile, "utf8")); } catch { banners = []; }
  const memImages = new Map(); // imagens enviadas e ainda não publicadas pelo deploy

  // ---------- GitHub ----------
  async function gh(p, opts = {}) {
    const r = await fetch(`${process.env.GITHUB_API_BASE || "https://api.github.com"}/repos/${GITHUB_REPO}/contents/${p}`, {
      ...opts,
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sigma-radar-site", ...(opts.headers || {}) },
    });
    if (r.status === 404 && (!opts.method || opts.method === "GET")) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${opts.method || "GET"} ${p} -> ${r.status}: ${data.message || ""}`);
    return data;
  }
  async function ghPut(p, base64, message) {
    const cur = await gh(`${p}?ref=main`);
    return gh(p, { method: "PUT", body: JSON.stringify({ message, content: base64, branch: "main", ...(cur?.sha ? { sha: cur.sha } : {}) }) });
  }
  async function ghDelete(p, message) {
    const cur = await gh(`${p}?ref=main`);
    if (cur?.sha) await gh(p, { method: "DELETE", body: JSON.stringify({ message, sha: cur.sha, branch: "main" }) });
  }
  // gravações em fila para não conflitar
  let queue = Promise.resolve();
  const enqueue = fn => (queue = queue.then(fn, fn));
  const saveList = msg => enqueue(() => ghPut("data/banners.json", Buffer.from(JSON.stringify(banners, null, 2) + "\n").toString("base64"), msg));

  // ---------- sessão ----------
  const sessKey = crypto.createHash("sha256").update("sess:" + ADMIN_PASSWORD).digest();
  const sign = v => v + "." + crypto.createHmac("sha256", sessKey).update(v).digest("base64url");
  const valid = tok => {
    if (!tok || !ADMIN_PASSWORD) return false;
    const i = tok.lastIndexOf("."), v = tok.slice(0, i);
    const a = Buffer.from(sign(v)), b = Buffer.from(tok);
    return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(v) > Date.now();
  };
  const cookie = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(x => x[0]))["sr_admin"];
  const auth = (req, res, next) => valid(cookie(req)) ? next() : res.status(401).json({ error: "Entre com a senha do painel." });

  const tries = new Map();
  function tooMany(ip) {
    const now = Date.now(), arr = (tries.get(ip) || []).filter(t => now - t < 15 * 60000);
    tries.set(ip, arr);
    return arr.length >= 8;
  }

  // ---------- validação ----------
  const cleanText = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n) : "");
  function cleanUrl(s) {
    if (typeof s !== "string" || !s.trim()) return "";
    try { const u = new URL(s.trim()); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; }
  }
  const cleanDate = s => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "");

  function publicList() {
    const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília
    return banners
      .filter(b => b.active && (!b.from || b.from <= today) && (!b.until || b.until >= today))
      .sort((a, b) => a.order - b.order)
      .map(({ id, title, link, img }) => ({ id, title, link, img }));
  }

  // ---------- rotas ----------
  const router = express.Router();
  router.get("/banners/:file", (req, res) => {
    const f = req.params.file;
    if (!/^[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(f)) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=86400");
    const mem = memImages.get(f);
    if (mem) return res.type(MIME[f.split(".").pop()]).send(mem);
    const p = path.join(imgDir, f);
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).end();
  });
  router.get("/api/banners", (req, res) => { res.set("Cache-Control", "no-cache"); res.json(publicList()); });

  const admin = express.Router();
  admin.use(express.json({ limit: "3mb" }));
  admin.post("/login", (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Painel desativado: falta configurar ADMIN_PASSWORD no Render." });
    if (tooMany(req.ip)) return res.status(429).json({ error: "Muitas tentativas. Espere 15 minutos." });
    const a = crypto.createHash("sha256").update(String(req.body?.password || "")).digest();
    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, b)) { tries.get(req.ip).push(Date.now()); return res.status(401).json({ error: "Senha incorreta." }); }
    const tok = sign(String(Date.now() + 12 * 3600e3));
    res.set("Set-Cookie", `sr_admin=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`);
    res.json({ ok: true });
  });
  admin.post("/logout", (req, res) => { res.set("Set-Cookie", "sr_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"); res.json({ ok: true }); });
  admin.get("/banners", auth, (req, res) => res.json({ banners: [...banners].sort((a, b) => a.order - b.order), size: { w: BANNER_W, h: BANNER_H }, canSave: !!GITHUB_TOKEN }));

  admin.post("/banners", auth, async (req, res) => {
    if (!GITHUB_TOKEN) return res.status(503).json({ error: "Falta configurar GITHUB_TOKEN no Render para salvar banners." });
    const b = req.body || {};
    const existing = b.id ? banners.find(x => x.id === b.id) : null;
    if (b.id && !existing) return res.status(404).json({ error: "Banner não encontrado." });
    const title = cleanText(b.title, 80), link = cleanUrl(b.link);
    if (!title) return res.status(400).json({ error: "Dê um nome ao banner (aparece para leitores de tela)." });
    if (link === null) return res.status(400).json({ error: "O link precisa começar com http:// ou https://." });
    let img = existing?.img || "", buf = null, ext = "";
    if (b.image) {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      if (!m) return res.status(400).json({ error: "Envie a imagem em PNG, JPG, WEBP ou GIF." });
      buf = Buffer.from(m[2], "base64");
      if (buf.length > MAX_BYTES) return res.status(400).json({ error: "A imagem passa de 1,5 MB. Diminua o tamanho e tente de novo." });
      ext = TYPES[m[1]];
    }
    if (!img && !buf) return res.status(400).json({ error: "Escolha a imagem do banner." });
    const id = existing?.id || crypto.randomBytes(6).toString("hex");
    const oldImg = existing?.img;
    if (buf) { img = `${id}-${Date.now().toString(36)}.${ext}`; memImages.set(img, buf); }
    const rec = { id, title, link: link || "", img, active: b.active !== false,
      from: cleanDate(b.from), until: cleanDate(b.until),
      order: existing ? existing.order : (Math.max(0, ...banners.map(x => x.order)) + 1) };
    try {
      if (buf) await enqueue(() => ghPut(`banners/${img}`, buf.toString("base64"), `Banner: imagem de "${title}"`));
      if (existing) Object.assign(existing, rec); else banners.push(rec);
      await saveList(`Banner: ${existing ? "editar" : "novo"} "${title}"`);
      if (buf && oldImg && oldImg !== img) enqueue(() => ghDelete(`banners/${oldImg}`, `Banner: remover imagem antiga de "${title}"`)).catch(() => {});
      res.json({ ok: true, banner: rec });
    } catch (e) {
      console.error("[banners]", e.message);
      res.status(502).json({ error: "Não consegui salvar no GitHub. Confira o GITHUB_TOKEN e tente de novo." });
    }
  });

  admin.post("/banners/order", auth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    ids.forEach((id, i) => { const b = banners.find(x => x.id === id); if (b) b.order = i + 1; });
    try { await saveList("Banner: nova ordem"); res.json({ ok: true }); }
    catch (e) { console.error("[banners]", e.message); res.status(502).json({ error: "Não consegui salvar a ordem." }); }
  });

  admin.delete("/banners/:id", auth, async (req, res) => {
    const i = banners.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "Banner não encontrado." });
    const [b] = banners.splice(i, 1);
    try {
      await saveList(`Banner: remover "${b.title}"`);
      enqueue(() => ghDelete(`banners/${b.img}`, `Banner: remover imagem de "${b.title}"`)).catch(() => {});
      res.json({ ok: true });
    } catch (e) { banners.splice(i, 0, b); console.error("[banners]", e.message); res.status(502).json({ error: "Não consegui remover agora." }); }
  });
  router.use("/api/admin", admin);

  return { router, publicList, auth };
}
