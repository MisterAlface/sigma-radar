// Sigma Radar — site de porcentagem de captura + doações Pix (Mercado Pago)
// Variáveis de ambiente (configure no Render, nunca no código):
//   MP_ACCESS_TOKEN       Access Token de PRODUÇÃO do Mercado Pago (APP_USR-...)
//   MP_WEBHOOK_SECRET     "Assinatura secreta" do webhook (painel MP > Webhooks)
//   PUBLIC_URL            Endereço público do site, ex.: https://sigma-radar.onrender.com
//   DONOR_FALLBACK_EMAIL  E-mail usado como pagador quando o doador não informa um
//   DONATIONS_SINCE       Data (AAAA-MM-DD) a partir da qual as doações contam no ranking
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PUBLIC_URL = "",
  DONOR_FALLBACK_EMAIL = "",
  DONATIONS_SINCE = "2026-11-08",
  PORT = 3000,
} = process.env;

const APP_TAG = "sigma-radar";            // marca as doações deste site no Mercado Pago
const MIN_AMOUNT = 1, MAX_AMOUNT = 1000;  // limites de valor por doação (R$)
const PIX_MINUTES = 30;                   // validade do QR Code

if (!MP_ACCESS_TOKEN) console.warn("[aviso] MP_ACCESS_TOKEN não configurado: doações desativadas.");
if (!MP_WEBHOOK_SECRET) console.warn("[aviso] MP_WEBHOOK_SECRET não configurado: webhook vai recusar notificações.");

// ---------- Mercado Pago ----------
async function mp(pathname, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch((process.env.MP_API_BASE || "https://api.mercadopago.com") + pathname, {
    method,
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`MP ${method} ${pathname} -> ${r.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ---------- Doações (memória, reconstruída a partir do Mercado Pago) ----------
// O Render gratuito apaga o disco a cada deploy, então a fonte da verdade é o próprio Mercado Pago:
// ao iniciar e a cada 10 min o servidor busca os pagamentos aprovados marcados com APP_TAG.
const donations = new Map(); // paymentId -> { nick, amount, date }

function isOurs(p) {
  return typeof p.external_reference === "string" && p.external_reference.startsWith(APP_TAG + ":");
}
function record(p) {
  if (!isOurs(p)) return;
  if (p.status === "approved") {
    const nick = cleanNick(p.metadata?.nick) || "Anônimo";
    donations.set(String(p.id), { nick, amount: Number(p.transaction_amount) || 0, date: new Date(p.date_approved || p.date_created).toISOString() });
  } else {
    donations.delete(String(p.id)); // estornado, cancelado etc. sai do ranking
  }
}

let lastSync = null, syncing = false;
async function syncFromMP() {
  if (!MP_ACCESS_TOKEN || syncing) return;
  syncing = true;
  try {
    const begin = new Date(DONATIONS_SINCE + "T00:00:00-03:00").toISOString();
    const end = new Date().toISOString();
    const seen = new Map();
    for (let offset = 0; offset < 5000; offset += 100) {
      const q = new URLSearchParams({ sort: "date_created", criteria: "desc", range: "date_created",
        begin_date: begin, end_date: end, limit: "100", offset: String(offset) });
      const page = await mp(`/v1/payments/search?${q}`);
      for (const p of page.results || []) if (isOurs(p)) seen.set(String(p.id), p);
      if (!page.results || page.results.length < 100) break;
    }
    donations.clear();
    for (const p of seen.values()) record(p);
    lastSync = new Date().toISOString();
    console.log(`[sync] ${donations.size} doações aprovadas`);
  } catch (e) {
    console.error("[sync] falhou:", e.message);
  } finally {
    syncing = false;
  }
}

function ranking() {
  const by = new Map();
  for (const d of donations.values()) {
    if (d.nick === "Anônimo") continue; // anônimos contam no total, mas não aparecem no ranking
    const k = d.nick.toLowerCase();
    const cur = by.get(k) || { nick: d.nick, total: 0, count: 0, last: d.date };
    cur.total += d.amount; cur.count += 1;
    if (d.date > cur.last) { cur.last = d.date; cur.nick = d.nick; }
    by.set(k, cur);
  }
  const top = [...by.values()].sort((a, b) => b.total - a.total || a.last.localeCompare(b.last)).slice(0, 50);
  const recent = [...donations.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
    .map(d => ({ nick: d.nick, amount: d.amount, date: d.date }));
  const total = [...donations.values()].reduce((s, d) => s + d.amount, 0);
  return { top, recent, total: Math.round(total * 100) / 100, donors: donations.size, updated: lastSync };
}

// ---------- Validação ----------
function cleanNick(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// limite simples por IP: 5 Pix gerados a cada 10 minutos
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 5;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some(t => now - t < 600000)) hits.delete(ip); }, 600000).unref();

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Webhook: precisa do corpo bruto? Não — a assinatura usa data.id, request-id e ts, não o corpo.
app.post("/api/webhook", express.json({ limit: "64kb" }), (req, res) => {
  const signature = req.get("x-signature") || "";
  const requestId = req.get("x-request-id") || "";
  const parts = Object.fromEntries(signature.split(",").map(p => p.split("=").map(s => s.trim())));
  const { ts, v1 } = parts;
  const rawId = req.query["data.id"] ?? req.body?.data?.id;
  const dataId = rawId == null ? "" : String(rawId).toLowerCase();
  if (!MP_WEBHOOK_SECRET || !ts || !v1 || !dataId || !requestId) return res.status(400).end();

  const canonical = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(canonical).digest("hex");
  const ok = expected.length === v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  if (!ok) return res.status(401).end();

  res.status(200).end(); // responde já; processa depois
  const type = req.query.type || req.body?.type;
  if (type !== "payment") return;
  queueMicrotask(async () => {
    try { record(await mp(`/v1/payments/${encodeURIComponent(dataId)}`)); }
    catch (e) { console.error("[webhook]", e.message); }
  });
});

app.use("/api", express.json({ limit: "8kb" }));

app.get("/api/donors", (req, res) => {
  res.set("Cache-Control", "public, max-age=15");
  res.json({ enabled: !!MP_ACCESS_TOKEN, ...ranking() });
});

app.post("/api/donate", async (req, res) => {
  if (!MP_ACCESS_TOKEN) return res.status(503).json({ error: "As doações ainda não foram ativadas." });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "Muitos Pix gerados em pouco tempo. Tente de novo em alguns minutos." });

  const anonymous = req.body?.anonymous === true;
  const nick = anonymous ? "" : cleanNick(req.body?.nick);
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().slice(0, 254) : "";

  if (!anonymous && nick.length < 2) return res.status(400).json({ error: "Escreva um nick com pelo menos 2 letras, ou marque “doar anônimo”." });
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT)
    return res.status(400).json({ error: `Escolha um valor entre R$ ${MIN_AMOUNT} e R$ ${MAX_AMOUNT}.` });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Esse e-mail não parece válido. Pode deixar em branco." });
  const payerEmail = email || DONOR_FALLBACK_EMAIL;
  if (!payerEmail) return res.status(400).json({ error: "Informe um e-mail para gerar o Pix." });

  const ref = `${APP_TAG}:${crypto.randomUUID()}`;
  try {
    const p = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": ref },
      body: {
        transaction_amount: amount,
        description: "Doação - Porcentagem de captura de Pokemons",
        payment_method_id: "pix",
        payer: { email: payerEmail },
        external_reference: ref,
        metadata: { app: APP_TAG, nick: nick || "Anônimo" },
        notification_url: PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, "")}/api/webhook` : undefined,
        date_of_expiration: new Date(Date.now() + PIX_MINUTES * 60000).toISOString().replace("Z", "-00:00"),
      },
    });
    const td = p.point_of_interaction?.transaction_data || {};
    if (!td.qr_code) throw new Error("Pix sem QR Code na resposta");
    res.json({ id: String(p.id), qr_code: td.qr_code, qr_code_base64: td.qr_code_base64, expires: p.date_of_expiration, amount });
  } catch (e) {
    console.error("[donate]", e.message);
    res.status(502).json({ error: "Não conseguimos gerar o Pix agora. Tente de novo em instantes." });
  }
});

// Consulta de status para a tela de "obrigado" (só para pagamentos deste site)
app.get("/api/donate/:id", async (req, res) => {
  if (!MP_ACCESS_TOKEN || !/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: "Pedido inválido." });
  try {
    const p = await mp(`/v1/payments/${req.params.id}`);
    if (!isOurs(p)) return res.status(404).json({ error: "Doação não encontrada." });
    record(p);
    res.set("Cache-Control", "no-store");
    res.json({ status: p.status });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).json({ error: "Não foi possível consultar agora." });
  }
});

const INDEX = path.join(__dirname, "index.html");
app.get(["/", "/index.html"], (req, res) => { res.set("Cache-Control", "public, max-age=300"); res.sendFile(INDEX); });
app.use((req, res) => res.redirect(302, "/"));

app.listen(PORT, () => {
  console.log(`Sigma Radar no ar na porta ${PORT}`);
  syncFromMP();
  setInterval(syncFromMP, 10 * 60 * 1000).unref();
});
