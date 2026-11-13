// Páginas de conteúdo (renderizadas no servidor, boas para o Google e para o AdSense):
//   /shiny            lista de todos os shinies
//   /shiny/:slug      uma página por shiny, com texto e números próprios
//   /como-funciona    o que são brokes, de onde vêm os dados, como ler as médias
//   /sobre, /contato
//   /sitemap.xml      todas as páginas acima
const TYPE_PT = { normal: "Normal", fire: "Fogo", water: "Água", grass: "Planta", electric: "Elétrico", ice: "Gelo", fighting: "Lutador", poison: "Venenoso", ground: "Terra", flying: "Voador", psychic: "Psíquico", bug: "Inseto", rock: "Pedra", ghost: "Fantasma", dragon: "Dragão", dark: "Sombrio", steel: "Aço", fairy: "Fada" };
const RAR = [["RARO", "Raro"], ["ÉPICO", "Épico"], ["LENDÁRIO", "Lendário"]];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = p => p.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/♀/g, "-f").replace(/♂/g, "-m").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fmt = (n, d = 0) => n == null ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => v == null ? "—" : (v * 100 >= 1 ? fmt(v * 100, 1) : v * 100 >= 0.1 ? fmt(v * 100, 2) : fmt(v * 100, 3)) + "%";
const dBR = d => d ? d.slice(0, 10).split("-").reverse().join("/") : "—";
const pad = n => "#" + String(n).padStart(3, "0");

function difficulty(mean) {
  if (mean == null) return ["sem dados", "#8A97B0"];
  if (mean < 150) return ["fácil", "#4ADE80"];
  if (mean < 500) return ["médio", "#3FE0C5"];
  if (mean < 1200) return ["difícil", "#F5C451"];
  return ["muito difícil", "#F87171"];
}

const CSS = `:root{color-scheme:dark;--bg:#070B14;--panel:#0E1524;--line:#1A2438;--fg:#E8EEF8;--muted:#8A97B0;--soft:#C9D3E6;--accent:#3FE0C5;--gold:#F5C451}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 "Segoe UI",system-ui,-apple-system,sans-serif}
a{color:var(--accent)}header,footer{border-color:var(--line)}
.top{border-bottom:1px solid var(--line)}.top .w{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;padding-block:14px}
.brand{display:flex;gap:10px;align-items:center;color:var(--fg);text-decoration:none;font-weight:700;font-size:19px}.brand span{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:14.5px}nav a{color:var(--soft);text-decoration:none}nav a:hover{color:var(--accent)}
.w{max-width:900px;margin:0 auto;padding-inline:16px}main{padding-block:28px 56px}
h1{font-size:clamp(26px,5vw,36px);line-height:1.15;margin:6px 0 10px}h2{font-size:21px;margin:34px 0 10px}h3{font-size:17px;margin:22px 0 6px}
p,li{color:var(--soft)}.lead{font-size:18px}.muted{color:var(--muted);font-size:14px}
.crumbs{font-size:13.5px;color:var(--muted)}.crumbs a{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.kpi small{display:block;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.kpi b{font-size:22px}
.tag{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;border:1px solid currentColor}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;font-size:13px}
.tw{overflow-x:auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;list-style:none;padding:0}
.grid a{display:flex;justify-content:space-between;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 12px;text-decoration:none;color:var(--fg)}.grid a:hover{border-color:var(--accent)}.grid small{color:var(--muted)}
.cta{display:inline-block;margin-top:8px;background:var(--accent);color:#070B14;font-weight:700;padding:10px 18px;border-radius:10px;text-decoration:none}
.foot{border-top:1px solid var(--line);padding-block:22px 34px;font-size:14px;color:var(--muted)}.foot a{color:var(--soft)}`;

const LOGO = `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="none" stroke="#3FE0C5" stroke-width="1.5"/><circle cx="15" cy="15" r="7.5" fill="none" stroke="#3FE0C5" stroke-opacity=".5" stroke-width="1.2"/><path d="M15 15 L26 9" stroke="#3FE0C5" stroke-width="2" stroke-linecap="round"/><circle cx="21" cy="19" r="2.2" fill="#F5C451"/></svg>`;

export function registerPages(app, { getStats, siteUrl, getAdsense }) {
  let cache = null, cacheFor = null;
  function index() {
    const S = getStats();
    if (cacheFor === S) return cache;
    const list = S.data.filter(d => d.p).map(d => ({ ...d, slug: slugify(d.p), chance: d.tot ? d.nb / d.tot : null }));
    const bySlug = new Map(list.map(d => [d.slug, d]));
    const ranked = list.filter(d => d.mean != null && d.nb >= 5).sort((a, b) => b.mean - a.mean);
    const rankOf = new Map(ranked.map((d, i) => [d.slug, i + 1]));
    cache = { S, list, bySlug, ranked, rankOf }; cacheFor = S;
    return cache;
  }

  function page({ title, desc, path, body, jsonld }) {
    const ads = getAdsense();
    const url = siteUrl + path;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" href="/favicon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="Sigma Radar"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${url}"><meta property="og:locale" content="pt_BR">
${ads ? `<meta name="google-adsense-account" content="ca-${ads}"><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${ads}" crossorigin="anonymous"></script>` : ""}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/<\//g, "<\\/")}</script>` : ""}
<style>${CSS}</style></head><body>
<header class="top"><div class="w"><a class="brand" href="/">${LOGO}<b>SIGMA <span>RADAR</span></b></a>
<nav aria-label="Principal"><a href="/">Capturas</a><a href="/shiny">Todos os shinies</a><a href="/#jogadores">Jogadores</a><a href="/como-funciona">Como funciona</a><a href="/#doacoes">Apoie</a></nav></div></header>
<main class="w">${body}</main>
<footer class="foot"><div class="w"><p>Sigma Radar é um site feito de player para player por <a href="https://twitch.tv/misteralface" rel="noopener">MisterAlface</a>, sem vínculo oficial com o Poke Sigma. Dados do canal #sigma-radar do Discord do Sigma Project, atualizados todo dia.</p>
<p><a href="/sobre">Sobre</a> · <a href="/como-funciona">Como funciona</a> · <a href="/contato">Contato</a> · <a href="/privacidade">Privacidade</a> · <a href="/shiny">Todos os shinies</a></p></div></footer>
</body></html>`;
  }

  // ---------- /shiny/:slug ----------
  function shinyPage(d, ix) {
    const { S, ranked, rankOf, list } = ix;
    const types = d.ty.map(t => TYPE_PT[t] || t).join(" / ");
    const [dl, dc] = difficulty(d.mean);
    const rank = rankOf.get(d.slug);
    const totalRanked = ranked.length;
    const share = S.meta.n ? d.n / S.meta.n : 0;
    const rarTxt = RAR.filter(([k]) => d.rc[k]).map(([k, l]) => `${l}: ${fmt(d.rc[k])} (${pct(d.rc[k] / d.n)})`).join(" · ");
    const sigma = d.single?.Sigma;
    const sigmaMean = sigma ? sigma[1] / sigma[0] : null;

    let intro = `O shiny de <b>${esc(d.p)}</b> (${pad(d.id)}, tipo ${esc(types)}) já foi capturado <b>${fmt(d.n)} ${d.n === 1 ? "vez" : "vezes"}</b> no Poke Sigma desde 07/09/2026, segundo os anúncios do canal #sigma-radar.`;
    if (d.mean != null) intro += ` Em média, cada captura custou <b>${fmt(d.mean, 1)} brokes</b>, o que dá uma chance média de <b>${pct(d.chance)}</b> por broke (a chance começa menor e sobe a cada broke que falha).`;

    let context = "";
    if (rank) {
      const pos = rank <= totalRanked / 2 ? `É o <b>${rank}º shiny mais difícil</b> de pegar entre os ${totalRanked} com dados suficientes` : `É o <b>${totalRanked - rank + 1}º shiny mais fácil</b> de pegar entre os ${totalRanked} com dados suficientes`;
      context = `${pos}, e por isso fica na faixa <span class="tag" style="color:${dc}">${dl}</span>.`;
    } else if (d.mean != null) {
      context = `Ainda há poucas capturas com brokes registrados (${fmt(d.nb)}), então a média pode mudar bastante com as próximas.`;
    } else {
      context = `Ainda não há capturas com quantidade de brokes registrada para este shiny.`;
    }

    let medTxt = "";
    if (d.med != null && d.mean != null) {
      medTxt = d.med < d.mean
        ? `A mediana é <b>${fmt(d.med)} brokes</b>: metade dos jogadores pegou com até esse número. Ela fica abaixo da média porque algumas capturas muito azaradas puxam a média para cima.`
        : `A mediana é <b>${fmt(d.med)} brokes</b>: metade dos jogadores pegou com até esse número, e a outra metade precisou de mais.`;
    }

    let luck = "";
    if (d.lk && d.ul) {
      luck = `<h2>Mais sortudo e mais azarado</h2><p>O jogador mais sortudo foi <b>${esc(d.lk.pl)}</b>, que pegou o ${esc(d.p)} shiny com apenas <b>${fmt(d.lk.b)} broke${d.lk.b === 1 ? "" : "s"}</b> em ${dBR(d.lk.d)}${d.lk.tie ? ` (${fmt(d.lk.tie)} outro${d.lk.tie > 1 ? "s" : ""} empatado${d.lk.tie > 1 ? "s" : ""})` : ""}. Já o mais azarado foi <b>${esc(d.ul.pl)}</b>, que precisou de <b>${fmt(d.ul.b)} brokes</b> em ${dBR(d.ul.d)}.</p>`;
    }

    const balls = Object.entries(d.catch || {}).sort((a, b) => b[1] - a[1]);
    const ballRows = balls.map(([b, n]) => `<tr><td>${esc(b)} Ball</td><td>${fmt(n)}</td><td>${pct(n / d.n)}</td><td>${d.single?.[b] ? fmt(d.single[b][1] / d.single[b][0], 1) : "—"}</td></tr>`).join("");

    let tip;
    if (d.mean == null) tip = `Como ainda não há dados de brokes, não dá para estimar o custo. Se você pegar esse shiny, anuncie no #sigma-radar para ajudar a comunidade.`;
    else if (d.mean < 150) tip = `É um dos shinies mais baratos: com cerca de ${fmt(Math.ceil(d.mean * 1.5))} Sigma Balls você tem uma boa margem para a maioria das tentativas.`;
    else if (d.mean < 500) tip = `Vá preparado com pelo menos ${fmt(Math.ceil(d.mean))} brokes, e lembre que a chance sobe a cada broke: metade das pessoas pegou com até ${fmt(d.med)}.`;
    else if (d.mean < 1200) tip = `É um shiny caro. Planeje ter de ${fmt(Math.round(d.med ?? d.mean))} a ${fmt(Math.round(d.mean * 1.6))} brokes antes de começar, e não desanime se passar da média: isso acontece com muita gente.`;
    else tip = `É um dos shinies mais difíceis do jogo. Muitos jogadores passam de ${fmt(Math.round(d.mean))} brokes; vale juntar Sigma Balls antes e acompanhar a sua sorte na extensão Sigma Hunt.`;

    const same = list.filter(x => x.slug !== d.slug && x.ty.some(t => d.ty.includes(t))).sort((a, b) => b.n - a.n).slice(0, 8);
    const sameHtml = same.length ? `<h2>Outros shinies com tipo ${esc(d.ty.map(t => TYPE_PT[t] || t).join(" ou "))}</h2><ul class="grid">${same.map(x => `<li><a href="/shiny/${x.slug}"><span>${esc(x.p)}</span><small>${x.mean != null ? fmt(x.mean, 0) + " brokes" : fmt(x.n) + " capt."}</small></a></li>`).join("")}</ul>` : "";

    const body = `<p class="crumbs"><a href="/">Início</a> › <a href="/shiny">Shinies</a> › ${esc(d.p)}</p>
<h1>${esc(d.p)} shiny: chance de captura e média de brokes</h1>
<p class="lead">${intro}</p><p>${context}</p>
<div class="kpis"><div class="kpi"><small>Capturas</small><b>${fmt(d.n)}</b></div><div class="kpi"><small>Média de brokes</small><b>${fmt(d.mean, 1)}</b></div><div class="kpi"><small>Mediana</small><b>${fmt(d.med)}</b></div><div class="kpi"><small>Chance média por broke</small><b>${pct(d.chance)}</b></div><div class="kpi"><small>Menor / maior</small><b>${fmt(d.mn)} / ${fmt(d.mx)}</b></div><div class="kpi"><small>Total de brokes</small><b>${fmt(d.tot)}</b></div></div>
${medTxt ? `<p>${medTxt}</p>` : ""}
${sigmaMean ? `<p>Considerando só as capturas feitas usando apenas Sigma Balls (${fmt(sigma[0])}), a média foi de <b>${fmt(sigmaMean, 1)} Sigma Balls</b> por shiny.</p>` : ""}
<h2>Dica para caçar ${esc(d.p)} shiny</h2><p>${tip}</p>
${luck}
${ballRows ? `<h2>Bola usada na captura</h2><div class="tw"><table><thead><tr><th>Bola</th><th>Capturas</th><th>% das capturas</th><th>Média só com ela</th></tr></thead><tbody>${ballRows}</tbody></table></div>` : ""}
${rarTxt ? `<h2>Raridade das capturas</h2><p>${rarTxt}.</p>` : ""}
<p class="muted">${esc(d.p)} representa ${pct(share)} de todos os shinies anunciados. Última captura registrada em ${dBR(d.last)}. ${d.nb < d.n ? `${fmt(d.n - d.nb)} captura(s) sem quantidade de brokes informada.` : ""}</p>
<p><a class="cta" href="/#p-${d.id}">Ver ${esc(d.p)} no radar</a></p>
${sameHtml}
<p class="muted">Estes números são médias das capturas anunciadas no Discord. A chance aumenta a cada broke, mas ainda há sorte: você pode pegar com bem menos ou bem mais brokes. Entenda os cálculos em <a href="/como-funciona">Como funciona</a>.</p>`;

    return page({
      title: `${d.p} shiny: chance de captura e média de brokes | Sigma Radar`,
      desc: d.mean != null
        ? `${d.p} shiny no Poke Sigma: média de ${fmt(d.mean, 1)} brokes, mediana de ${fmt(d.med)} e chance média de ${pct(d.chance)} por broke, com base em ${fmt(d.n)} capturas.`
        : `${d.p} shiny no Poke Sigma: ${fmt(d.n)} capturas registradas no #sigma-radar.`,
      path: `/shiny/${d.slug}`, body,
      jsonld: { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Sigma Radar", item: siteUrl + "/" },
        { "@type": "ListItem", position: 2, name: "Shinies", item: siteUrl + "/shiny" },
        { "@type": "ListItem", position: 3, name: d.p, item: `${siteUrl}/shiny/${d.slug}` }] },
    });
  }

  // ---------- /shiny ----------
  function listPage(ix) {
    const { S, list, ranked } = ix;
    const byName = [...list].sort((a, b) => a.p.localeCompare(b.p, "pt-BR"));
    const easiest = [...ranked].reverse().slice(0, 5), hardest = ranked.slice(0, 5);
    const item = d => `<li><a href="/shiny/${d.slug}"><span>${esc(d.p)}</span><small>${d.mean != null ? fmt(d.mean, 0) + " brokes" : fmt(d.n) + " capt."}</small></a></li>`;
    const body = `<p class="crumbs"><a href="/">Início</a> › Shinies</p>
<h1>Todos os shinies do Poke Sigma</h1>
<p class="lead">Lista dos ${fmt(list.length)} Pokémon shiny já capturados no Poke Sigma, com a média de brokes de cada um. São ${fmt(S.meta.n)} capturas anunciadas no #sigma-radar desde 07/09/2026, por ${fmt(S.meta.players)} jogadores diferentes.</p>
<h2>Os 5 shinies mais fáceis</h2><ul class="grid">${easiest.map(item).join("")}</ul>
<h2>Os 5 shinies mais difíceis</h2><ul class="grid">${hardest.map(item).join("")}</ul>
<h2>Todos, em ordem alfabética</h2><ul class="grid">${byName.map(item).join("")}</ul>
<p class="muted">A média só aparece para shinies com capturas que informaram a quantidade de brokes. Veja como os números são calculados em <a href="/como-funciona">Como funciona</a>.</p>`;
    return page({ title: "Todos os shinies do Poke Sigma: média de brokes de cada um | Sigma Radar", desc: `Lista dos ${list.length} shinies do Poke Sigma com média de brokes, chance de captura e os mais fáceis e mais difíceis de pegar.`, path: "/shiny", body });
  }

  // ---------- páginas fixas ----------
  function howPage(ix) {
    const { S, ranked } = ix;
    const ex = ranked.find(d => d.p === "Charizard") || ranked[Math.floor(ranked.length / 2)];
    const body = `<p class="crumbs"><a href="/">Início</a> › Como funciona</p>
<h1>Como funciona o Sigma Radar</h1>
<p class="lead">O Sigma Radar junta todas as capturas de Pokémon shiny anunciadas no Poke Sigma e calcula quanto, em média, cada shiny custa para ser capturado.</p>
<h2>De onde vêm os dados</h2>
<p>Toda vez que alguém captura um shiny no Poke Sigma, o jogo anuncia a captura no canal <b>#sigma-radar</b> do Discord do Sigma Project, com o nick do jogador, o Pokémon, a raridade e quantas bolas foram usadas. O Sigma Radar lê esse canal todos os dias à meia-noite e soma as capturas novas. Hoje são <b>${fmt(S.meta.n)} capturas</b> de <b>${fmt(S.meta.species)} shinies diferentes</b>, feitas por ${fmt(S.meta.players)} jogadores, desde 07/09/2026 (fim do beta).</p>
<h2>O que é um broke</h2>
<p>No Poke Sigma, os jogadores chamam de <b>broke</b> cada bola gasta tentando capturar um Pokémon shiny. Se você jogou 300 bolas até o shiny ficar preso, foram 300 brokes. Quanto mais brokes um shiny costuma pedir, mais difícil e mais caro ele é.</p>
<h2>Média, mediana, menor e maior</h2>
<ul><li><b>Média de brokes:</b> soma de todos os brokes dividida pelo número de capturas. É o custo "típico" do shiny.</li>
<li><b>Mediana:</b> o número do meio. Metade das pessoas pegou com até esse valor e a outra metade precisou de mais. Ela é útil porque não é puxada por casos extremos de azar.</li>
<li><b>Menor e maior:</b> a captura mais sortuda e a mais azarada já registradas.</li>
<li><b>Chance média por broke:</b> número de capturas dividido pelo total de brokes. É uma média de todo o caminho: como a chance sobe a cada broke, os primeiros arremessos têm chance menor que essa e os últimos, maior.</li></ul>
${ex ? `<p>Exemplo: o <a href="/shiny/${ex.slug}">${esc(ex.p)} shiny</a> tem média de ${fmt(ex.mean, 1)} brokes e mediana de ${fmt(ex.med)}. Ou seja, metade dos jogadores pegou com até ${fmt(ex.med)} brokes, mas alguns precisaram de bem mais, o que puxa a média para cima.</p>` : ""}
<h2>A chance aumenta a cada broke</h2>
<p>O Poke Sigma tem um sistema de mérito: cada Sigma Ball que falha num shiny aumenta a chance da próxima. Ou seja, quanto mais brokes você já gastou, mais perto está de pegar. A média e a mediana mostram até onde a comunidade costuma precisar ir até a chance subir o suficiente. Ainda há sorte envolvida: dá para pegar logo nos primeiros brokes ou passar bastante da média.</p>
<h2>Rankings de jogadores</h2>
<p>Na aba <a href="/#jogadores">Jogadores</a> há o top 10 de caçadores de shiny, os recordes de mais e menos brokes numa captura e o ranking de sorte. A sorte de cada jogador é calculada comparando cada captura com a média daquele shiny: 50% significa que gastou metade da média (sortudo) e 200% que gastou o dobro (azarado).</p>
<h2>Limitações</h2>
<p>Só entram capturas anunciadas no #sigma-radar. Algumas mensagens não informam a quantidade de bolas, e essas capturas contam no total, mas não nas médias. Shinies com poucas capturas podem ter médias que ainda vão mudar bastante.</p>
<p><a class="cta" href="/shiny">Ver todos os shinies</a></p>`;
    return page({ title: "Como funciona: brokes, médias e chance de captura | Sigma Radar", desc: "Entenda de onde vêm os dados do Sigma Radar, o que são brokes e como calculamos a média, a mediana e a chance de captura de cada shiny do Poke Sigma.", path: "/como-funciona", body });
  }

  function aboutPage() {
    const body = `<p class="crumbs"><a href="/">Início</a> › Sobre</p>
<h1>Sobre o Sigma Radar</h1>
<p class="lead">O Sigma Radar é um site feito de player para player para a comunidade do Poke Sigma.</p>
<p>A ideia nasceu de uma pergunta que todo caçador de shiny faz: <i>quantas bolas eu vou precisar?</i> Em vez de chutar, o site reúne todas as capturas anunciadas no #sigma-radar e mostra, para cada Pokémon shiny, a média de brokes, a mediana, a chance média por broke, os jogadores mais sortudos e os mais azarados.</p>
<p>O site foi criado e é mantido por <b>MisterAlface</b>, jogador e streamer do Poke Sigma (<a href="https://twitch.tv/misteralface" rel="noopener">twitch.tv/misteralface</a>). Ele <b>não tem vínculo oficial</b> com o Poke Sigma ou com a equipe do Sigma Project.</p>
<h2>Como o site se mantém</h2>
<p>O Sigma Radar é gratuito. Os custos são cobertos por <a href="/#doacoes">doações via Pix</a> de quem gosta do projeto, por parceiros que aparecem no espaço de banners e por anúncios.</p>
<h2>Ferramentas</h2>
<ul><li><a href="/shiny">Lista de todos os shinies</a> com página própria para cada um.</li><li><a href="/#jogadores">Rankings de jogadores</a>, recordes e sorte.</li><li>A extensão <b>Sigma Hunt</b> para o Chrome, que mostra a média do Sigma Radar enquanto você caça.</li></ul>
<p>Encontrou um erro ou tem uma sugestão? Veja a página de <a href="/contato">contato</a>.</p>`;
    return page({ title: "Sobre o Sigma Radar | Feito de player para player", desc: "O Sigma Radar é um site da comunidade do Poke Sigma, criado por MisterAlface, com a média de brokes e a chance de captura de cada shiny.", path: "/sobre", body });
  }

  function contactPage() {
    const body = `<p class="crumbs"><a href="/">Início</a> › Contato</p>
<h1>Contato</h1>
<p class="lead">Quer falar com quem faz o Sigma Radar? Fale com <b>MisterAlface</b>.</p>
<ul><li><b>Twitch:</b> <a href="https://twitch.tv/misteralface" rel="noopener">twitch.tv/misteralface</a>, pelo chat ou por mensagem.</li>
<li><b>Discord do Sigma Project:</b> procure por <b>MisterAlface</b>.</li></ul>
<h2>Sobre o que falar</h2>
<ul><li><b>Erro nos dados:</b> diga o Pokémon, o nick e a data da captura.</li>
<li><b>Anunciar ou ser parceiro:</b> o site tem um espaço de banners para parceiros (1280 × 640 px).</li>
<li><b>Seus dados:</b> para ver, corrigir ou apagar o WhatsApp informado numa doação, veja a <a href="/privacidade">Política de Privacidade</a>.</li></ul>`;
    return page({ title: "Contato | Sigma Radar", desc: "Fale com MisterAlface, criador do Sigma Radar: erros nos dados, parcerias e anúncios.", path: "/contato", body });
  }

  const send = (res, html) => { res.set("Cache-Control", "public, max-age=600"); res.type("html").send(html); };
  app.get("/shiny", (req, res) => send(res, listPage(index())));
  app.get("/shiny/:slug", (req, res, next) => {
    const ix = index(); const d = ix.bySlug.get(String(req.params.slug).toLowerCase());
    if (!d) return next();
    send(res, shinyPage(d, ix));
  });
  app.get("/como-funciona", (req, res) => send(res, howPage(index())));
  app.get("/sobre", (req, res) => send(res, aboutPage()));
  app.get("/contato", (req, res) => send(res, contactPage()));
  app.get("/sitemap.xml", (req, res) => {
    const ix = index(); const d = (ix.S.meta?.until || new Date().toISOString()).slice(0, 10);
    const u = (p, f, pr, lm = d) => `  <url><loc>${siteUrl}${p}</loc><lastmod>${lm}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`;
    const urls = [u("/", "daily", "1.0"), u("/shiny", "daily", "0.9"), u("/como-funciona", "monthly", "0.6"), u("/sobre", "monthly", "0.4"), u("/contato", "yearly", "0.3"), u("/privacidade", "yearly", "0.2"),
      ...ix.list.map(x => u(`/shiny/${x.slug}`, "daily", "0.8", (x.last || d).slice(0, 10)))];
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  });
  return { slugify };
}
