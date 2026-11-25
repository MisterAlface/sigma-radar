// Referências de vendedores (aba "Referências" do site).
// Qualquer pessoa cria conta com nick + senha. Para VOTAR ou deixar referência, a conta precisa ter
// o Discord vinculado (login oficial do Discord) ou um telefone confirmado pelo WhatsApp (um número por conta):
// a pessoa digita o número, recebe um código e manda "Meu código do Sigma Radar é 1234" do próprio WhatsApp
// para REFS_WHATSAPP; o admin confere a mensagem e confirma no /admin (por isso pode demorar).
//   - "Confio": um voto por conta em cada vendedor (clicar de novo tira o voto).
//   - Referência "Comprei e deu tudo certo": aparece na hora.
//   - Referência "Tive um problema": fica em análise e só aparece depois que o admin aprovar.
// Qualquer conta pode cadastrar um vendedor. O admin pode dar o selo "Verificado", ocultar ou apagar.
// Cada conta tem um perfil com foto. Se o nick da conta for o mesmo do vendedor, ela pode assumir o perfil ("Sou eu"):
// a foto dela passa a aparecer no vendedor e ela pode editar contato, observação e o que vende. O admin pode tirar o dono.
// As fotos (128 px, públicas) ficam em data/fotos/<código>.jpg|png|webp no repositório e em cache na memória.
// Os dados ficam CRIPTOGRAFADOS (AES-256-GCM) em data/refs.enc no repositório (o repositório é público):
// senhas (só o hash scrypt), telefones e ids do Discord nunca aparecem em texto aberto.
//   REFS_SECRET                    chave da criptografia (se faltar, usa ADMIN_PASSWORD; não troque depois)
//   DISCORD_CLIENT_ID/SECRET       app do Discord para o botão "Vincular Discord" (sem eles o botão some)
//   GITHUB_TOKEN / GITHUB_REPO     os mesmos dos banners
import crypto from "node:crypto";
import express from "express";

const FILE = "data/refs.enc";
const DAY = 86400000;
const NICK = /^[A-Za-z0-9À-ÿ _.\-]{3,20}$/;
const CATS = ["diamantes", "itens", "contas", "servicos", "outros"];
const ITEMS = ["diamantes", "itens", "conta", "servico", "outro"];
const PHOTO_MAX = 80 * 1024;
const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const PHOTO_KEY = /^[A-Za-z0-9_-]{8,24}\.(jpg|png|webp)$/;
const MIN_DISCORD_AGE = 30 * DAY;     // conta do Discord com menos de 30 dias não vincula (evita conta fake)
const rid = (n = 10) => crypto.randomBytes(n).toString("base64url");
const clean = (s, max) => String(s ?? "").replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const low = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function createRefs({ siteUrl, adminAuth, saveDelayMs = 20000 }) {
  const { GITHUB_TOKEN = "", GITHUB_REPO = "MisterAlface/sigma-radar", ADMIN_PASSWORD = "", REFS_SECRET = "",
    DISCORD_CLIENT_ID = "", DISCORD_CLIENT_SECRET = "", REFS_WHATSAPP = "" } = process.env;
  const waNumber = REFS_WHATSAPP.replace(/\D/g, "");
  const API = process.env.GITHUB_API_BASE || "https://api.github.com";
  const secret = REFS_SECRET || ADMIN_PASSWORD || "sigma-radar-dev";
  if (!REFS_SECRET) console.warn("[referencias] REFS_SECRET não configurado; usando ADMIN_PASSWORD como chave.");
  const KEY = crypto.createHash("sha256").update("refs-key:" + secret).digest();
  const MAC = crypto.createHash("sha256").update("refs-mac:" + secret).digest();
  const discordOn = !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET);
  const redirectUri = `${siteUrl}/api/refs/discord/callback`;

  // db.users[id]  = { nick, nl, ph, at, ver, phone?, dc?: { id, name } }
  // db.sellers[id]= { name, nl, cats[], contact, note, by, at, verified, hidden }
  // db.votes["vendedor|usuario"] = data
  // db.reviews[id]= { s, u, kind: "ok"|"bad", item, text, at, st: "pub"|"pend"|"rej" }
  let db = { v: 1, users: {}, sellers: {}, votes: {}, reviews: {} };
  let sha = null, dirty = false, timer = null, ready = !GITHUB_TOKEN;

  // ---------- criptografia ----------
  const seal = obj => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    return `refs1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}\n`; };
  const open = txt => { const [v, iv, tag, body] = txt.trim().split("."); if (v !== "refs1") throw new Error("formato");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8")); };

  // ---------- GitHub ----------
  async function gh(opts = {}) {
    const r = await fetch(`${API}/repos/${GITHUB_REPO}/contents/${FILE}${opts.method ? "" : "?ref=main"}`, { ...opts,
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sigma-radar-site" } });
    if (r.status === 404 && !opts.method) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`GitHub ${opts.method || "GET"} ${FILE} -> ${r.status}: ${data.message || ""}`); e.status = r.status; throw e; }
    return data;
  }
  async function ghFile(p, opts = {}) {
    const r = await fetch(`${API}/repos/${GITHUB_REPO}/contents/${p}${opts.method ? "" : "?ref=main"}`, { ...opts,
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: opts.raw ? "application/vnd.github.raw" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sigma-radar-site" } });
    if (r.status === 404 && !opts.method) return null;
    if (opts.raw && r.ok) return Buffer.from(await r.arrayBuffer());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${opts.method || "GET"} ${p} -> ${r.status}: ${data.message || ""}`);
    return data;
  }
  // fotos: cache na memória; o que não estiver aqui vem do GitHub na primeira vez que alguém pedir
  const photos = new Map();
  let photoQ = Promise.resolve();
  const photoJob = fn => (photoQ = photoQ.then(fn, fn));
  async function photoGet(key) {
    if (photos.has(key)) return photos.get(key);
    if (!GITHUB_TOKEN) return null;
    const buf = await ghFile(`data/fotos/${key}`, { raw: true }).catch(() => null);
    if (buf) { if (photos.size > 3000) photos.delete(photos.keys().next().value); photos.set(key, buf); }
    return buf;
  }
  const photoPut = (key, buf) => photoJob(() => GITHUB_TOKEN && ghFile(`data/fotos/${key}`, { method: "PUT", body: JSON.stringify({ message: "Referências: foto de perfil [skip render]", content: buf.toString("base64"), branch: "main" }) }));
  const photoDel = key => photoJob(async () => { photos.delete(key); if (!GITHUB_TOKEN) return; const cur = await ghFile(`data/fotos/${key}`).catch(() => null);
    if (cur?.sha) await ghFile(`data/fotos/${key}`, { method: "DELETE", body: JSON.stringify({ message: "Referências: remover foto [skip render]", sha: cur.sha, branch: "main" }) }); });
  const photoUrl = u => u?.photo ? `/api/refs/foto/${u.photo}` : "";

  async function load() {
    if (!GITHUB_TOKEN) { console.warn("[referencias] sem GITHUB_TOKEN: dados só na memória"); return; }
    for (let i = 0; i < 5; i++) {
      try {
        const cur = await gh();
        if (cur) { sha = cur.sha; const d = open(Buffer.from(cur.content || "", "base64").toString("utf8"));
          db = { v: 1, users: d.users || {}, sellers: d.sellers || {}, votes: d.votes || {}, reviews: d.reviews || {} }; }
        ready = true; console.log(`[referencias] ${Object.keys(db.sellers).length} vendedores, ${Object.keys(db.users).length} contas`); return;
      } catch (e) { console.error("[referencias] não consegui ler:", e.message); await new Promise(r => setTimeout(r, 5000 * (i + 1))); }
    }
  }
  const loading = load();
  async function save() {
    if (!GITHUB_TOKEN || !ready || !dirty) return;
    dirty = false;
    const body = { message: "Referências: atualizar [skip render]", content: Buffer.from(seal(db)).toString("base64"), branch: "main" };
    try { const r = await gh({ method: "PUT", body: JSON.stringify({ ...body, ...(sha ? { sha } : {}) }) }); sha = r.content?.sha || sha; }
    catch (e) {
      if (e.status === 409 || e.status === 422) { try { const cur = await gh(); sha = cur?.sha || null; dirty = true; schedule(2000); return; } catch {} }
      console.error("[referencias] não consegui salvar:", e.message); dirty = true; schedule(60000);
    }
  }
  const schedule = (ms = saveDelayMs) => { clearTimeout(timer); timer = setTimeout(save, ms); };
  const touch = () => { dirty = true; schedule(); };

  // ---------- contas e sessão ----------
  const hashPass = (pass, salt = rid(12)) => `${salt}:${crypto.scryptSync(pass, salt, 32).toString("base64url")}`;
  const checkPass = (pass, stored) => { const [salt, h] = String(stored).split(":"); const a = Buffer.from(hashPass(pass, salt).split(":")[1]), b = Buffer.from(h || "");
    return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const sign = s => crypto.createHmac("sha256", MAC).update(s).digest("base64url").slice(0, 32);
  const token = u => { const p = `${u}.${db.users[u].ver}.${Date.now() + 60 * DAY}`; return `${p}.${sign(p)}`; };
  const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(x => x[0]).map(([k, ...v]) => [k, v.join("=")]));
  function userOf(req) {
    const t = cookies(req).sr_u; if (!t) return null;
    const [u, ver, exp, sig] = t.split("."); const p = `${u}.${ver}.${exp}`;
    if (!sig || sig !== sign(p) || +exp < Date.now()) return null;
    const user = db.users[u]; return user && String(user.ver) === ver ? { id: u, ...user } : null;
  }
  const secure = siteUrl.startsWith("https") ? " Secure;" : "";
  const setSession = (res, u) => res.append("Set-Cookie", `sr_u=${token(u)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${60 * 86400}`);
  const linked = u => !!(u && (u.phone || u.dc));
  const me = u => { if (!u) return null; const uid = u.id || Object.keys(db.users).find(k => db.users[k] === u); return { nick: u.nick, game: u.gn || "", photo: photoUrl(u), owns: Object.entries(db.sellers).filter(([, s]) => s.owner && s.owner === uid && !s.hidden).map(([id, s]) => ({ id, name: s.name, cats: s.cats, contact: s.contact, note: s.note })), phone: u.phone ? `•••• ${u.phone.slice(-4)}` : "", discord: u.dc ? u.dc.name : "", canVote: linked(u), discordOn, phoneOn: !!waNumber, wa: waNumber,
    phonePending: u.pp ? { last4: u.pp.ph.slice(-4), code: u.pp.code, at: u.pp.at } : null }; };

  // limite simples por IP: n ações por janela
  const hits = new Map();
  const limited = (req, key, n, ms) => { const k = `${key}|${req.ip}`, now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < ms);
    a.push(now); hits.set(k, a); return a.length > n; };
  setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

  // ---------- visão pública ----------
  function sellerView(id, s, viewer) {
    let votes = 0, ok = 0, bad = 0, last = s.at;
    const pre = id + "|";
    for (const k in db.votes) if (k.startsWith(pre)) votes++;
    for (const r of Object.values(db.reviews)) if (r.s === id && r.st === "pub") { r.kind === "ok" ? ok++ : bad++; if (r.at > last) last = r.at; }
    const score = votes + ok * 2 - bad * 6;
    const owner = s.owner ? db.users[s.owner] : null;
    return { id, name: s.name, photo: photoUrl(owner), owned: !!owner, cats: s.cats, contact: s.contact, note: s.note, verified: !!s.verified, at: s.at, last, votes, ok, bad, score,
      canClaim: !!(viewer && !owner && (viewer.nl === s.nl || (viewer.gn && low(viewer.gn) === s.nl))), isOwner: !!(viewer && owner && s.owner === viewer.id),
      mine: viewer ? { vote: !!db.votes[`${id}|${viewer.id}`], review: Object.entries(db.reviews).find(([, r]) => r.s === id && r.u === viewer.id && r.st !== "rej")?.[1]?.kind || "" } : null };
  }
  const reviewView = (id, r) => { const u = db.users[r.u]; return { id, kind: r.kind, item: r.item, text: r.text, at: r.at, by: u ? u.nick : "conta apagada", game: u?.gn || "", photo: photoUrl(u),
    badge: u?.dc ? "discord" : u?.phone ? "telefone" : "" }; };

  // ---------- rotas ----------
  const router = express.Router();
  router.get("/api/refs/foto/:key", async (req, res) => {
    const key = String(req.params.key); if (!PHOTO_KEY.test(key)) return res.status(404).end();
    const buf = await photoGet(key); if (!buf) return res.status(404).end();
    const ext = key.split(".").pop(); res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type(ext === "jpg" ? "jpeg" : ext).send(buf);
  });
  router.post("/api/refs/me/photo", express.json({ limit: "160kb" }), async (req, res) => {
    await loading; res.set("Cache-Control", "no-store");
    const u = userOf(req); if (!u) return res.status(401).json({ error: "Entre na sua conta primeiro." });
    if (limited(req, "photo", 10, 3600000)) return res.status(429).json({ error: "Muitas trocas de foto. Tente mais tarde." });
    const old = db.users[u.id].photo;
    if (req.body?.remove) { delete db.users[u.id].photo; touch(); if (old) photoDel(old); return res.json({ ok: true, me: me(db.users[u.id]) }); }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ""));
    if (!m) return res.status(400).json({ error: "Envie uma imagem JPG, PNG ou WEBP." });
    const buf = Buffer.from(m[2], "base64");
    const okMagic = m[1] === "image/jpeg" ? buf[0] === 0xff && buf[1] === 0xd8 : m[1] === "image/png" ? buf.slice(1, 4).toString() === "PNG" : buf.slice(8, 12).toString() === "WEBP";
    if (!okMagic || buf.length > PHOTO_MAX) return res.status(400).json({ error: "Imagem inválida ou grande demais." });
    const key = `${rid(9)}.${PHOTO_TYPES[m[1]]}`;
    photos.set(key, buf);
    try { await photoPut(key, buf); } catch (e) { photos.delete(key); console.error("[referencias] foto:", e.message); return res.status(502).json({ error: "Não consegui salvar a foto. Tente de novo." }); }
    db.users[u.id].photo = key; touch(); if (old) photoDel(old);
    res.json({ ok: true, me: me(db.users[u.id]) });
  });
  router.use("/api/refs", express.json({ limit: "8kb" }), async (req, res, next) => {
    await Promise.race([loading, new Promise(r => setTimeout(r, 4000))]); res.set("Cache-Control", "no-store");
    if (!ready && req.method === "POST") return res.status(503).json({ error: "As referências estão carregando. Tente de novo em instantes." });
    next();
  });
  const need = (req, res, mustLink) => { const u = userOf(req);
    if (!u) { res.status(401).json({ error: "Entre na sua conta primeiro." }); return null; }
    if (mustLink && !linked(u)) { res.status(403).json({ error: "Vincule seu Discord ou telefone para votar e deixar referência." }); return null; }
    return u; };

  router.get("/api/refs", (req, res) => {
    const u = userOf(req);
    const sellers = Object.entries(db.sellers).filter(([, s]) => !s.hidden).map(([id, s]) => sellerView(id, s, u)).sort((a, b) => b.score - a.score || b.last - a.last);
    res.json({ me: me(u), sellers, cats: CATS, users: Object.keys(db.users).length });
  });
  router.get("/api/refs/sellers/:id", (req, res) => {
    const s = db.sellers[req.params.id]; if (!s || s.hidden) return res.status(404).json({ error: "Vendedor não encontrado." });
    const reviews = Object.entries(db.reviews).filter(([, r]) => r.s === req.params.id && r.st === "pub").sort((a, b) => b[1].at - a[1].at).slice(0, 100).map(([id, r]) => reviewView(id, r));
    const pending = Object.values(db.reviews).filter(r => r.s === req.params.id && r.st === "pend").length;
    res.json({ seller: sellerView(req.params.id, s, userOf(req)), reviews, pending });
  });

  router.post("/api/refs/register", (req, res) => {
    if (limited(req, "reg", 5, 3600000)) return res.status(429).json({ error: "Muitas contas criadas daqui. Tente mais tarde." });
    const nick = clean(req.body?.nick, 20), pass = String(req.body?.pass || "");
    if (!NICK.test(nick)) return res.status(400).json({ error: "Nick de 3 a 20 letras, números, espaço, ponto, _ ou -." });
    if (pass.length < 6 || pass.length > 100) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });
    const nl = low(nick); if (Object.values(db.users).some(x => x.nl === nl)) return res.status(409).json({ error: "Esse nick já tem conta." });
    const gn = clean(req.body?.game, 24); if (gn && !NICK.test(gn)) return res.status(400).json({ error: "Nick do jogo inválido." });
    const id = rid(); db.users[id] = { nick, nl, ph: hashPass(pass), at: Date.now(), ver: 1, ...(gn ? { gn } : {}) }; touch();
    setSession(res, id); res.json({ ok: true, me: me(db.users[id]) });
  });
  router.post("/api/refs/login", (req, res) => {
    if (limited(req, "login", 10, 900000)) return res.status(429).json({ error: "Muitas tentativas. Espere 15 minutos." });
    const nl = low(clean(req.body?.nick, 20)); const e = Object.entries(db.users).find(([, x]) => x.nl === nl);
    if (!e || !checkPass(String(req.body?.pass || ""), e[1].ph)) return res.status(401).json({ error: "Nick ou senha errados." });
    setSession(res, e[0]); res.json({ ok: true, me: me(e[1]) });
  });
  router.post("/api/refs/logout", (req, res) => { res.append("Set-Cookie", `sr_u=; Path=/; Max-Age=0; HttpOnly;${secure} SameSite=Lax`); res.json({ ok: true }); });

  router.post("/api/refs/me/game", (req, res) => {
    const u = need(req, res); if (!u) return;
    const gn = clean(req.body?.game, 24);
    if (gn && !/^[A-Za-z0-9À-ÿ _.\-]{2,24}$/.test(gn)) return res.status(400).json({ error: "Nick do jogo de 2 a 24 letras, números, espaço, ponto, _ ou -." });
    if (gn) db.users[u.id].gn = gn; else delete db.users[u.id].gn;
    touch(); res.json({ ok: true, me: me(db.users[u.id]) });
  });
  router.post("/api/refs/link/phone/cancel", (req, res) => {
    const u = need(req, res); if (!u) return; delete db.users[u.id].pp; touch(); res.json({ ok: true, me: me(db.users[u.id]) });
  });
  router.post("/api/refs/link/phone", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (limited(req, "phone", 5, 3600000)) return res.status(429).json({ error: "Muitas tentativas. Tente mais tarde." });
    let ph = String(req.body?.phone || "").replace(/\D/g, ""); if (ph.length === 10 || ph.length === 11) ph = "55" + ph;
    if (!/^55\d{10,11}$/.test(ph)) return res.status(400).json({ error: "Número inválido. Use DDD + número, ex.: (31) 99999-9999." });
    const hp = sign("phone:" + ph);
    if (Object.entries(db.users).some(([id, x]) => id !== u.id && x.phh === hp)) return res.status(409).json({ error: "Esse número já está vinculado a outra conta." });
    if (!waNumber) return res.status(503).json({ error: "O vínculo por telefone ainda não está disponível." });
    if (db.users[u.id].phone) return res.status(409).json({ error: "Sua conta já tem telefone vinculado." });
    const code = String(crypto.randomInt(1000, 10000));
    db.users[u.id].pp = { ph, code, at: Date.now() }; touch(); res.json({ ok: true, me: me(db.users[u.id]) });
  });

  // Discord: /start manda para a tela oficial do Discord; /callback volta com o código
  router.get("/api/refs/discord/start", (req, res) => {
    const u = userOf(req); if (!u) return res.redirect("/#referencias");
    if (!discordOn) return res.redirect("/#referencias?erro=discord-off");
    const st = `${u.id}.${Date.now()}`; const state = `${st}.${sign("dc:" + st)}`;
    res.redirect(`https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: DISCORD_CLIENT_ID, response_type: "code", scope: "identify", redirect_uri: redirectUri, state, prompt: "none" })}`);
  });
  router.get("/api/refs/discord/callback", async (req, res) => {
    const back = m => res.redirect(`/#referencias${m ? "?erro=" + m : "?ok=discord"}`);
    try {
      const [uid, ts, sig] = String(req.query.state || "").split(".");
      if (!sig || sig !== sign(`dc:${uid}.${ts}`) || Date.now() - +ts > 600000 || !db.users[uid]) return back("discord-estado");
      const cur = userOf(req); if (!cur || cur.id !== uid) return back("discord-sessao");
      if (!req.query.code) return back("discord-cancelado");
      const tr = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: redirectUri }) });
      const tk = await tr.json(); if (!tk.access_token) return back("discord-token");
      const ur = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tk.access_token}` } }); const du = await ur.json();
      if (!du.id) return back("discord-token");
      const created = Number(BigInt(du.id) >> 22n) + 1420070400000;
      if (Date.now() - created < MIN_DISCORD_AGE) return back("discord-novo");
      const hd = sign("dc:" + du.id);
      if (Object.entries(db.users).some(([id, x]) => id !== uid && x.dch === hd)) return back("discord-usado");
      Object.assign(db.users[uid], { dc: { id: du.id, name: clean(du.global_name || du.username, 40) }, dch: hd }); touch(); back();
    } catch (e) { console.error("[referencias] discord:", e.message); back("discord-erro"); }
  });

  router.post("/api/refs/sellers", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (limited(req, "seller", 5, DAY)) return res.status(429).json({ error: "Você já cadastrou muitos vendedores hoje." });
    const name = clean(req.body?.name, 24); if (!NICK.test(name)) return res.status(400).json({ error: "Nick do vendedor de 3 a 24 caracteres." });
    const nl = low(name); const dup = Object.entries(db.sellers).find(([, s]) => s.nl === nl && !s.hidden);
    if (dup) return res.status(409).json({ error: "Esse vendedor já está na lista.", id: dup[0] });
    const cats = (Array.isArray(req.body?.cats) ? req.body.cats : []).filter(c => CATS.includes(c)).slice(0, 5);
    if (!cats.length) return res.status(400).json({ error: "Escolha o que ele vende." });
    const id = rid(8);
    db.sellers[id] = { name, nl, cats, contact: clean(req.body?.contact, 40), note: clean(req.body?.note, 140), by: u.id, at: Date.now(), verified: false, hidden: false };
    touch(); res.json({ ok: true, id });
  });
  router.post("/api/refs/sellers/:id/claim", (req, res) => {
    const u = need(req, res, true); if (!u) return;
    const s = db.sellers[req.params.id]; if (!s || s.hidden) return res.status(404).json({ error: "Vendedor não encontrado." });
    if (s.owner && db.users[s.owner]) return res.status(409).json({ error: "Esse perfil já tem dono. Se for você, fale com o admin." });
    if (u.nl !== s.nl && !(u.gn && low(u.gn) === s.nl)) return res.status(403).json({ error: "Só quem tem o mesmo nick do vendedor (da conta ou do jogo) pode assumir o perfil." });
    s.owner = u.id; touch(); res.json({ ok: true, me: me(db.users[u.id]) });
  });
  router.post("/api/refs/sellers/:id/edit", (req, res) => {
    const u = need(req, res); if (!u) return;
    const s = db.sellers[req.params.id]; if (!s || s.owner !== u.id) return res.status(403).json({ error: "Só o dono do perfil pode editar." });
    const cats = (Array.isArray(req.body?.cats) ? req.body.cats : []).filter(c => CATS.includes(c)).slice(0, 5);
    if (!cats.length) return res.status(400).json({ error: "Escolha o que você vende." });
    Object.assign(s, { cats, contact: clean(req.body?.contact, 40), note: clean(req.body?.note, 140) }); touch();
    res.json({ ok: true, me: me(db.users[u.id]) });
  });
  router.post("/api/refs/sellers/:id/vote", (req, res) => {
    const u = need(req, res, true); if (!u) return;
    if (!db.sellers[req.params.id] || db.sellers[req.params.id].hidden) return res.status(404).json({ error: "Vendedor não encontrado." });
    if (db.sellers[req.params.id].owner === u.id) return res.status(403).json({ error: "Você não pode votar no seu próprio perfil." });
    const k = `${req.params.id}|${u.id}`; if (db.votes[k]) delete db.votes[k]; else db.votes[k] = Date.now();
    touch(); res.json({ ok: true, seller: sellerView(req.params.id, db.sellers[req.params.id], u) });
  });
  router.post("/api/refs/sellers/:id/review", (req, res) => {
    const u = need(req, res, true); if (!u) return;
    const sid = req.params.id; if (!db.sellers[sid] || db.sellers[sid].hidden) return res.status(404).json({ error: "Vendedor não encontrado." });
    if (db.sellers[sid].owner === u.id) return res.status(403).json({ error: "Você não pode deixar referência no seu próprio perfil." });
    if (limited(req, "review", 10, DAY)) return res.status(429).json({ error: "Muitas referências hoje. Tente amanhã." });
    const kind = req.body?.kind === "bad" ? "bad" : "ok", item = ITEMS.includes(req.body?.item) ? req.body.item : "outro";
    const text = clean(req.body?.text, 280);
    if (kind === "bad" && text.length < 15) return res.status(400).json({ error: "Conte o que aconteceu (pelo menos 15 caracteres)." });
    for (const [id, r] of Object.entries(db.reviews)) if (r.s === sid && r.u === u.id) delete db.reviews[id];   // uma referência por conta
    db.reviews[rid(8)] = { s: sid, u: u.id, kind, item, text, at: Date.now(), st: kind === "ok" ? "pub" : "pend" };
    touch(); res.json({ ok: true, pending: kind === "bad", seller: sellerView(sid, db.sellers[sid], u) });
  });

  // ---------- admin ----------
  router.get("/api/admin/refs", adminAuth, (req, res) => {
    res.set("Cache-Control", "no-store");
    const pending = Object.entries(db.reviews).filter(([, r]) => r.st === "pend").sort((a, b) => a[1].at - b[1].at)
      .map(([id, r]) => ({ ...reviewView(id, r), seller: db.sellers[r.s]?.name || "?", sellerId: r.s }));
    const sellers = Object.entries(db.sellers).map(([id, s]) => ({ ...sellerView(id, s), hidden: !!s.hidden, by: db.users[s.by]?.nick || "?", ownerNick: s.owner ? db.users[s.owner]?.nick || "" : "" })).sort((a, b) => b.at - a.at);
    const users = Object.values(db.users);
    const phones = Object.entries(db.users).filter(([, x]) => x.pp).sort((a, b) => a[1].pp.at - b[1].pp.at)
      .map(([uid, x]) => ({ uid, nick: x.nick, game: x.gn || "", phone: x.pp.ph, code: x.pp.code, at: x.pp.at }));
    res.json({ pending, phones, wa: waNumber, sellers, users: users.length, linked: users.filter(linked).length, canSave: !!GITHUB_TOKEN, discordOn });
  });
  router.post("/api/admin/refs/review/:id", adminAuth, express.json(), (req, res) => {
    const r = db.reviews[req.params.id]; if (!r) return res.status(404).json({ error: "Não encontrada." });
    if (req.body?.action === "approve") r.st = "pub"; else if (req.body?.action === "reject") r.st = "rej"; else if (req.body?.action === "delete") delete db.reviews[req.params.id];
    touch(); res.json({ ok: true });
  });
  router.post("/api/admin/refs/phone/:uid", adminAuth, express.json(), (req, res) => {
    const x = db.users[req.params.uid]; if (!x || !x.pp) return res.status(404).json({ error: "Pedido não encontrado." });
    if (req.body?.action === "confirm") {
      const hp = sign("phone:" + x.pp.ph);
      if (Object.entries(db.users).some(([id, y]) => id !== req.params.uid && y.phh === hp)) { delete x.pp; touch(); return res.status(409).json({ error: "Esse número já está em outra conta. O pedido foi recusado." }); }
      Object.assign(x, { phone: x.pp.ph, phh: hp });
    }
    delete x.pp; touch(); res.json({ ok: true });
  });
  router.post("/api/admin/refs/seller/:id", adminAuth, express.json(), (req, res) => {
    const s = db.sellers[req.params.id]; if (!s) return res.status(404).json({ error: "Não encontrado." });
    const a = req.body?.action;
    if (a === "verify") s.verified = !s.verified; else if (a === "unown") delete s.owner; else if (a === "hide") s.hidden = !s.hidden;
    else if (a === "delete") { delete db.sellers[req.params.id]; for (const k of Object.keys(db.votes)) if (k.startsWith(req.params.id + "|")) delete db.votes[k];
      for (const [id, r] of Object.entries(db.reviews)) if (r.s === req.params.id) delete db.reviews[id]; }
    touch(); res.json({ ok: true });
  });
  router.use("/api/refs", (err, req, res, next) => res.status(400).json({ error: "Pedido inválido." }));

  return { router, save: () => { dirty = true; return save(); } };
}
