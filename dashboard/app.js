// Token Radar dashboard. Renders window.RADAR (written beside this page by
// main.ts) with no fetch and no network: a sortable, filterable board, a
// detail view per protocol with its model breakdown and farm plan, and the
// live-token set the model learned its peer multiples from.
// Views are addressable so a reader can link them: ?p=<slug> opens a detail
// view, ?chain=<name>&cat=<category>&min=<usd>&wl=1 filters the board.
'use strict';
const R = window.RADAR;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  chain: params.get('chain') || '',
  cat: params.get('cat') || '',
  min: Number(params.get('min') || 0),
  wl: params.get('wl') === '1',
  sort: params.get('sort') || 'rank',
  dir: params.get('dir') === 'asc' ? 1 : -1,
  slug: params.get('p') || '',
};
if (!params.get('sort')) state.dir = 1;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n;
}
const fmtPct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
const fmtAge = (d) => (d === null || d === undefined ? 'unknown' : d >= 365 ? (d / 365).toFixed(1) + ' yrs' : d + ' days');
const bySlug = new Map(R.rows.map((r) => [r.slug, r]));

function filtered() {
  const q = state.q.trim().toLowerCase();
  return R.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    (!state.cat || (r.category || '(none)') === state.cat) &&
    (!state.min || r.implied_value_usd >= state.min) &&
    (!state.wl || r.on_watchlist));
}
function sorted(rows) {
  const k = state.sort, d = state.dir;
  const val = (r) => (k === 'name' ? r.name.toLowerCase() : k === 'tvl' ? r.tvl_usd : k === 'chg' ? (r.change_7d ?? -1e9) : k === 'score' ? r.launch_score : k === 'age' ? (r.age_days ?? -1) : k === 'rank' ? r.rank : r.implied_value_usd);
  return rows.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : a.rank - b.rank) * (k === 'rank' ? 1 : d);
  });
}

function header() {
  return `<header class="top">
    <div class="kicker">Token launch radar · model ${esc(R.model_version)} · snapshot ${esc(R.as_of)}</div>
    <h1>Which pre-token protocol is worth farming next?</h1>
    <p class="sub">Every protocol below <b>records no token</b> in the snapshot and is not a wrapped, staked or bridged product of one that trades. Each is ranked by <b>implied launch value</b>: what a token would be worth if its record stayed as it is. The watchlist of ${R.watchlist_size} protocols at or above ${fmtUsd(R.floor_usd)} TVL is the floor, never the ceiling — the radar also carries ${R.early_size} earlier protocols below it.</p>
    <div class="stats">
      <div class="stat"><div class="n">${R.board_size}</div><div class="l">protocols ranked</div></div>
      <div class="stat"><div class="n">${R.watchlist_size}</div><div class="l">watchlist covered, in full</div></div>
      <div class="stat"><div class="n">${fmtUsd(R.total_tvl_usd)}</div><div class="l">TVL tracked on the board</div></div>
      <div class="stat"><div class="n">${fmtUsd(R.total_implied_usd)}</div><div class="l">combined implied value</div></div>
      <div class="stat"><div class="n">${R.universe_size}</div><div class="l">protocols in the snapshot</div></div>
    </div>
    <div class="model"><b>How the value is derived.</b> For each category, the snapshot's own live-token protocols give a peer multiple (median market cap / TVL, shrunk toward the global median of ${R.global_peer_multiple}x so thin categories cannot run away). Then <code>implied = TVL x peer multiple x growth x maturity x breadth</code>, where growth follows the 7-day TVL change, maturity follows how long the protocol has run with no token, and breadth follows its chain count. No name is special-cased; open any row to see its own factors. Implied value is this radar's claim, not a prediction that a token will launch.</div>
  </header>`;
}

function filtersHtml() {
  const chainOpts = ['<option value="">All chains</option>'].concat(R.chains.map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`)).join('');
  const catOpts = ['<option value="">All categories</option>'].concat(R.categories.map((c) => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`)).join('');
  const mins = [[0, 'Any value'], [1e7, '$10M+'], [5e7, '$50M+'], [1e8, '$100M+'], [5e8, '$500M+']];
  const minOpts = mins.map(([v, l]) => `<option value="${v}" ${v === state.min ? 'selected' : ''}>${l}</option>`).join('');
  return `<form class="filters" id="filters">
    <label>Search<input type="search" id="f-q" value="${esc(state.q)}" placeholder="name or slug"></label>
    <label>Chain<select id="f-chain">${chainOpts}</select></label>
    <label>Category<select id="f-cat">${catOpts}</select></label>
    <label>Implied value<select id="f-min">${minOpts}</select></label>
    <label class="chk"><input type="checkbox" id="f-wl" ${state.wl ? 'checked' : ''}> Watchlist only</label>
    <span class="count" id="f-count"></span>
  </form>`;
}

function th(label, key, cls) {
  const on = state.sort === key;
  return `<th class="sortable ${cls || ''}" data-sort="${key}">${label}${on ? `<span class="arr"> ${state.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;
}

function boardHtml() {
  const rows = sorted(filtered());
  const body = rows.map((r) => `<tr data-slug="${esc(r.slug)}">
    <td class="num">${r.rank}</td>
    <td><span class="pname">${esc(r.name)}</span>${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}<br><span class="pslug">${esc(r.slug)}</span></td>
    <td class="cat">${esc(r.category || '—')}</td>
    <td class="chains">${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</td>
    <td class="num">${fmtUsd(r.tvl_usd)}</td>
    <td class="num ${r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''}">${fmtPct(r.change_7d)}</td>
    <td class="num">${fmtAge(r.age_days)}</td>
    <td class="num implied">${fmtUsd(r.implied_value_usd)}</td>
    <td class="num"><span class="score">${r.launch_score}</span></td>
  </tr>`).join('');
  const table = rows.length
    ? `<table><thead><tr>${th('#', 'rank', 'num')}${th('Protocol', 'name')}<th>Category</th><th>Chains</th>${th('TVL', 'tvl', 'num')}${th('7d', 'chg', 'num')}${th('Age', 'age', 'num')}${th('Implied value', 'implied', 'num')}${th('Score', 'score', 'num')}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="empty">No protocol matches these filters. Loosen one and the radar sweeps again.</div>';
  const live = R.live.map((p) => `<span class="chip"><b>${esc(p.name)}</b> <span class="sym">${esc(p.symbol || '')}</span> · mcap ${fmtUsd(p.mcap_usd)} · TVL ${fmtUsd(p.tvl_usd)}</span>`).join('');
  return header() + filtersHtml() + table +
    `<section class="live"><h2>Already trading — the peer set, not the board</h2>
    <p>These protocols' tokens already trade, so the radar never ranks them. Their market cap / TVL ratios are what each category's peer multiple is learned from; they are shown at the market's own values.</p>
    <div class="chips">${live}</div></section>
    <footer>Source: ${esc(R.source)}. A protocol here records no token in that record; that is not proof it has none. Implied values are this radar's model output (model ${esc(R.model_version)}), not make.fun's claim and not financial advice.</footer>`;
}

function factor(label, mult, lo, hi, note) {
  const pct = Math.max(2, Math.min(100, ((mult - lo) / (hi - lo)) * 100));
  return `<div class="kv"><span>${label}</span><b>x${mult.toFixed(3)}</b></div><div class="bar"><i style="width:${pct}%"></i></div><p class="note">${note}</p>`;
}

function detailHtml(r) {
  const m = r.model;
  const steps = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<button class="back" id="back">← Back to the board</button>
  <section class="detail">
    <div class="head"><h1>${esc(r.name)}</h1>${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '<span class="badge">EARLY · BELOW THE FLOOR</span>'}</div>
    <p class="sub">${esc(r.slug)} · ${esc(r.category || 'uncategorised')} · records no token in the snapshot of ${esc(R.as_of)}</p>
    <div class="stats">
      <div class="stat"><div class="n">#${r.rank}</div><div class="l">rank on the board</div></div>
      <div class="stat"><div class="n">${fmtUsd(r.implied_value_usd)}</div><div class="l">implied launch value</div></div>
      <div class="stat"><div class="n">${fmtUsd(r.tvl_usd)}</div><div class="l">TVL</div></div>
      <div class="stat"><div class="n">${r.launch_score}/100</div><div class="l">launch-readiness score</div></div>
      <div class="stat"><div class="n">${fmtAge(r.age_days)}</div><div class="l">tracked with no token</div></div>
    </div>
    <div class="grid">
      <div class="card"><h3>The record</h3>
        <div class="kv"><span>7-day TVL change</span><b>${fmtPct(r.change_7d)}</b></div>
        <div class="kv"><span>Tracked since</span><b>${esc(r.listed_at || 'unknown')}</b></div>
        <div class="kv"><span>Chains</span><b>${esc(r.chains.join(', ') || '—')}</b></div>
        <div class="kv"><span>Watchlist (≥ ${fmtUsd(R.floor_usd)} TVL)</span><b>${r.on_watchlist ? 'yes' : 'no'}</b></div>
        <div class="kv"><span>Token recorded</span><b>none</b></div>
      </div>
      <div class="card"><h3>Why this implied value</h3>
        ${factor('Peer multiple (' + esc(r.category || 'all') + ', ' + m.peer_count + ' live peers)', m.peer_multiple, 0, 2.5, 'Median market cap / TVL of the category’s trading protocols, shrunk toward the global median.')}
        ${factor('Growth (7d ' + fmtPct(r.change_7d) + ')', m.growth_multiplier, 0.7, 1.6, 'A rising TVL raises what a launch would be worth today; a falling one discounts it.')}
        ${factor('Maturity', m.maturity_multiplier, 0.7, 1.0, 'Longer running with no token means a larger, more seasoned user base at launch.')}
        ${factor('Breadth (' + r.chains.length + ' chains)', m.breadth_multiplier, 1, 1.2, 'Each extra chain is another community a launch would reach.')}
      </div>
    </div>
    <h2>How to farm it</h2>
    <p class="note">A plan built from this protocol's category, main chain, size and age. Costs are working capital plus typical gas; times are honest, including the wait.</p>
    <ol class="farm">${steps}</ol>
    <footer>Implied value is this radar's claim under model ${esc(R.model_version)}, derived only from the snapshot's figures. It is not a prediction that ${esc(r.name)} will issue a token.</footer>
  </section>`;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.slug) p.set('p', state.slug);
  if (state.q) p.set('q', state.q);
  if (state.chain) p.set('chain', state.chain);
  if (state.cat) p.set('cat', state.cat);
  if (state.min) p.set('min', String(state.min));
  if (state.wl) p.set('wl', '1');
  if (state.sort !== 'rank') { p.set('sort', state.sort); p.set('dir', state.dir === 1 ? 'asc' : 'desc'); }
  history.replaceState(null, '', p.toString() ? '?' + p.toString() : location.pathname);
}

function render() {
  const detail = state.slug ? bySlug.get(state.slug) : undefined;
  app.innerHTML = detail ? detailHtml(detail) : boardHtml();
  app.setAttribute('aria-busy', 'false');
  if (detail) {
    document.getElementById('back').addEventListener('click', () => { state.slug = ''; syncUrl(); render(); });
    return;
  }
  const count = document.getElementById('f-count');
  const update = () => { count.textContent = filtered().length + ' of ' + R.board_size + ' shown'; };
  update();
  const bind = (id, key, parse) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { state[key] = parse(el); syncUrl(); rerenderTable(); update(); });
    el.addEventListener('change', () => { state[key] = parse(el); syncUrl(); rerenderTable(); update(); });
  };
  bind('f-q', 'q', (el) => el.value);
  bind('f-chain', 'chain', (el) => el.value);
  bind('f-cat', 'cat', (el) => el.value);
  bind('f-min', 'min', (el) => Number(el.value));
  bind('f-wl', 'wl', (el) => el.checked);
  wireTable();
}
function rerenderTable() {
  const form = document.getElementById('filters');
  const tmp = document.createElement('div');
  tmp.innerHTML = boardHtml();
  const fresh = tmp.querySelector('table') || tmp.querySelector('.empty');
  const old = app.querySelector('table') || app.querySelector('.empty');
  if (old && fresh) old.replaceWith(fresh);
  wireTable();
}
function wireTable() {
  app.querySelectorAll('th.sortable').forEach((el) => el.addEventListener('click', () => {
    const k = el.getAttribute('data-sort');
    if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
    syncUrl(); render();
  }));
  app.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    state.slug = tr.getAttribute('data-slug'); syncUrl(); render(); window.scrollTo(0, 0);
  }));
}
render();
