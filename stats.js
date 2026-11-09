// Monta as estatísticas do site a partir dos arquivos data/*.psv
// Cada linha: t|player|pokemon|raridade|ivs|bola|bolas_gastas|msg_id  (separador "|")
// O arquivo de cada dia é enviado pela tarefa diária; linhas repetidas (mesmo msg_id) contam uma vez só.
import fs from "node:fs";
import path from "node:path";

const LUCK_MIN_SPECIES = 5, LUCK_MIN_CAPS = 5; const DATA_SINCE = "2026-09-07T03:00:00Z"; // 07/09/2026 00:00 em Brasília (fim do beta)

function parseBalls(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(/, | e /)) {
    const m = part.trim().match(/^([\d.]+)\s+(.+?) Balls?$/);
    if (m) out[m[2]] = (out[m[2]] || 0) + parseInt(m[1].replace(/\./g, ""), 10);
  }
  return out;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y), n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

export function readCaptures(dir) {
  const seen = new Map();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".psv")).sort();
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
    const occ = new Map(); // mesma captura repetida na mesma mensagem conta separado
    const head = lines.shift().split("|");
    const idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
    for (const line of lines) {
      if (!line.trim()) continue;
      const c = line.split("|");
      const r = {
        t: c[idx.t], player: (c[idx.player] || "").trim(), pokemon: (c[idx.pokemon] || "").trim(),
        raridade: (c[idx.raridade] || "").trim(), ivs: c[idx.ivs] || "", bola: (c[idx.bola] || "").trim(),
        bolas: c[idx.bolas_gastas] || "", id: (c[idx.msg_id] || "").trim(),
      };
      if (!r.t || !r.pokemon || !r.id) continue;
      const base = r.id + "|" + r.pokemon + "|" + r.player;
      const k = (occ.get(base) || 0) + 1;
      occ.set(base, k);
      seen.set(base + "|" + k, r); // mesma mensagem em dois arquivos conta uma vez só
    }
  }
  return [...seen.values()];
}

export function buildStats(rows, dex) {
  const shiny = rows.filter(r => r.pokemon.startsWith("Shiny ") && r.t >= DATA_SINCE);
  const groups = new Map();
  for (const r of shiny) {
    const k = r.pokemon.slice(6);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const data = [];
  for (const [p, rs] of groups) {
    const withB = rs.map(r => parseBalls(r.bolas)).filter(b => Object.keys(b).length); const caps = rs.map(r => ({ pl: r.player, t: r.t, b: Object.values(parseBalls(r.bolas)).reduce((a, c) => a + c, 0) })).filter(x => x.b > 0).sort((x, y) => x.t.localeCompare(y.t)); let lk = null, ul = null; if (caps.length >= 2) { const lo = Math.min(...caps.map(x => x.b)), hi = Math.max(...caps.map(x => x.b)); const a1 = caps.find(x => x.b === lo), a2 = caps.find(x => x.b === hi); lk = { pl: a1.pl, b: lo, d: a1.t.slice(0, 10), tie: caps.filter(x => x.b === lo).length - 1 }; ul = { pl: a2.pl, b: hi, d: a2.t.slice(0, 10), tie: caps.filter(x => x.b === hi).length - 1 }; }
    const tots = withB.map(b => Object.values(b).reduce((a, c) => a + c, 0));
    const thrown = {}, single = {}, catchB = {}, rc = {};
    for (const b of withB) {
      for (const [k, v] of Object.entries(b)) thrown[k] = (thrown[k] || 0) + v;
      const ks = Object.keys(b);
      if (ks.length === 1) { single[ks[0]] ||= [0, 0]; single[ks[0]][0]++; single[ks[0]][1] += b[ks[0]]; }
    }
    for (const r of rs) {
      const cb = r.bola.replace(/ Ball$/, "");
      catchB[cb] = (catchB[cb] || 0) + 1;
      rc[r.raridade] = (rc[r.raridade] || 0) + 1;
    }
    const sum = tots.reduce((a, c) => a + c, 0);
    const info = dex[p] || { id: 0, ty: ["normal"] };
    data.push({
      p, s: true, rc, n: rs.length, nb: tots.length,
      mean: tots.length ? Math.round((sum / tots.length) * 10) / 10 : null,
      med: median(tots), mn: tots.length ? Math.min(...tots) : null, mx: tots.length ? Math.max(...tots) : null,
      tot: sum, thrown, single, catch: catchB, lk, ul,
      last: rs.reduce((m, r) => (r.t > m ? r.t : m), "").slice(0, 10),
      id: info.id, ty: info.ty,
    });
  }
  data.sort((a, b) => b.n - a.n || a.p.localeCompare(b.p));

  // raridades
  const rarity = {};
  for (const r of shiny) rarity[r.raridade] = (rarity[r.raridade] || 0) + 1;

  // top 10 jogadores
  const pl = new Map();
  for (const r of shiny) {
    const k = r.player.toLowerCase();
    const cur = pl.get(k) || { player: r.player, n: 0, rar: {}, species: {} };
    cur.n++;
    cur.rar[r.raridade] = (cur.rar[r.raridade] || 0) + 1;
    cur.species[r.pokemon.slice(6)] = (cur.species[r.pokemon.slice(6)] || 0) + 1;
    pl.set(k, cur);
  }
  const players = [...pl.values()]
    .sort((a, b) => b.n - a.n || a.player.localeCompare(b.player))
    .slice(0, 10)
    .map(x => {
      const [fav, favN] = Object.entries(x.species).sort((a, b) => b[1] - a[1])[0];
      return { player: x.player, n: x.n, rar: x.rar, fav, favN, distinct: Object.keys(x.species).length };
    });

  const meanOf = Object.fromEntries(data.filter(d => d.nb >= LUCK_MIN_SPECIES && d.mean).map(d => [d.p, d.mean])); const lp = new Map(); for (const r of shiny) { const m = meanOf[r.pokemon.slice(6)]; if (!m) continue; const b = Object.values(parseBalls(r.bolas)).reduce((a, c) => a + c, 0); if (!b) continue; const k = r.player.toLowerCase(); const cur = lp.get(k) || { player: r.player, n: 0, sr: 0, b: 0 }; cur.n++; cur.sr += b / m; cur.b += b; lp.set(k, cur); } const lq = [...lp.values()].filter(x => x.n >= LUCK_MIN_CAPS).map(x => ({ player: x.player, n: x.n, r: Math.round((x.sr / x.n) * 1000) / 10, b: x.b })); const luck = { min: LUCK_MIN_CAPS, qualified: lq.length, lucky: [...lq].sort((a, b) => a.r - b.r || b.n - a.n).slice(0, 10), unlucky: [...lq].sort((a, b) => b.r - a.r || b.n - a.n).slice(0, 10) }; const until = shiny.reduce((m, r) => (r.t > m ? r.t : m), "");
  return {
    meta: { n: shiny.length, since: "2026-09-07", until: until.slice(0, 16), species: data.length, players: pl.size },
    rarity, players, luck, data,
  };
}
