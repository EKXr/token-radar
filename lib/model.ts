// token-radar model "radar-2": one sealed snapshot in, one ranked board out.
//
// Every number on the board is derived from the snapshot's own figures at run
// time. No protocol name is special-cased anywhere: the same functions score
// every row, so a snapshot taken tomorrow ranks protocols that do not exist
// in this one with no code change.
//
// Who is ranked
// -------------
// A protocol is a candidate when the snapshot records no token for it (no
// market cap, no CoinGecko id, no symbol) AND it is not a wrapped, staked or
// bridged product of a token that already trades. The product screen is the
// watchlist's own rule, applied to the whole universe instead of only above
// the $50M floor: the category is not Bridge, Canonical Bridge, Liquid
// Staking, Liquid Restaking, Restaked BTC or CEX; the name carries no whole
// word wrapped / staked / staking, does not end in a version marker and does
// not begin with an exchange's name. Every watchlist slug passes this screen
// by construction, so coverage is guaranteed, and the board then adds every
// candidate below the floor too: the early rows are the point of a radar.
// Protocols whose token already trades are never ranked; the dashboard shows
// the largest of them separately, at the market's own values.
//
// What a launch would be worth
// -----------------------------
// The snapshot's live-token protocols are the peer set. For each category,
// the peers' market-cap / TVL ratios give a peer multiple: the category
// median, shrunk toward the global median by the peer count so a category
// with one wild peer cannot dominate (weight 4), clamped to [0.03, 2.5].
//
//   peerMult(c)  = clamp( (n_c * median_c + 4 * globalMedian) / (n_c + 4) )
//   base         = tvl_usd * peerMult(category)
//   growthMult   = 1 + clamp(change_7d, -50, 100) / 100 * 0.6
//   maturityMult = 0.70 + 0.30 * min(age_days, 1095) / 1095   (age unknown: 548)
//   breadthMult  = 1 + 0.04 * min(chains - 1, 5)
//   implied      = max(1, round(base * growthMult * maturityMult * breadthMult))
//
// A launch-readiness score (0-100) is reported beside the value for the
// dashboard only; the rank itself is the implied value, descending.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';

export interface ModelBreakdown {
  peer_multiple: number;
  peer_count: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  launch_score: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  universe_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_tvl_usd: number;
  total_implied_usd: number;
  global_peer_multiple: number;
  categories: string[];
  chains: string[];
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** True when the record reads as a wrapped/staked/bridged product or an exchange listing, not a launch candidate. */
export function isProductOfToken(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

export function isCandidate(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && !isProductOfToken(p);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Peer multiples per category, computed from the snapshot's live-token protocols. */
export function peerMultiples(snapshot: Snapshot): { byCategory: Map<string, { multiple: number; count: number }>; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(none)';
    const arr = ratiosByCategory.get(key) ?? [];
    arr.push(ratio);
    ratiosByCategory.set(key, arr);
  }
  all.sort((a, b) => a - b);
  const global = all.length > 0 ? median(all) : 0.2;
  const byCategory = new Map<string, { multiple: number; count: number }>();
  for (const [key, arr] of ratiosByCategory) {
    arr.sort((a, b) => a - b);
    const shrunk = (arr.length * median(arr) + 4 * global) / (arr.length + 4);
    byCategory.set(key, { multiple: Math.min(2.5, Math.max(0.03, shrunk)), count: arr.length });
  }
  return { byCategory, global };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** One protocol's implied value and the factors behind it. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  peers: { byCategory: Map<string, { multiple: number; count: number }>; global: number },
): { implied: number; breakdown: ModelBreakdown } {
  const peer = peers.byCategory.get(p.category ?? '(none)') ?? { multiple: peers.global, count: 0 };
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0, -50, 100);
  const growthMult = 1 + (growthPct / 100) * 0.6;
  const ageForModel = age ?? 548;
  const maturityMult = 0.7 + 0.3 * (clamp(ageForModel, 0, 1095) / 1095);
  const breadthMult = 1 + 0.04 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  const implied = Math.max(1, Math.round(p.tvl_usd * peer.multiple * growthMult * maturityMult * breadthMult));
  return {
    implied,
    breakdown: {
      peer_multiple: round4(peer.multiple),
      peer_count: peer.count,
      growth_pct: growthPct,
      growth_multiplier: round4(growthMult),
      maturity_multiplier: round4(maturityMult),
      breadth_multiplier: round4(breadthMult),
      age_days: age,
    },
  };
}

/** A 0-100 readiness score for display: size, momentum, seasoning and reach, each from the record. */
export function launchScore(p: SnapshotProtocol, breakdown: ModelBreakdown): number {
  const size = clamp((Math.log10(Math.max(p.tvl_usd, 1)) - 6.7) / 3.3, 0, 1) * 40; // $5M -> 0, $10B -> 40
  const momentum = clamp((breakdown.growth_pct + 20) / 60, 0, 1) * 25;
  const seasoning = clamp((breakdown.age_days ?? 548) / 1095, 0, 1) * 20;
  const reach = clamp(p.chains.length / 6, 0, 1) * 15;
  return Math.round(size + momentum + seasoning + reach);
}

// ---------------------------------------------------------------- farm plans

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  if (tvl >= 10_000_000) return 50;
  return 25;
}

const CHEAP_CHAINS = new Set(['Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Blast', 'Mode', 'BSC', 'Binance', 'Avalanche', 'Sonic', 'Berachain', 'Monad', 'Hyperliquid L1', 'Plasma', 'Sui', 'Aptos']);

function gasFor(chain: string, capital: number): string {
  if (CHEAP_CHAINS.has(chain)) return `about $1-3 of gas on ${chain}`;
  if (chain === 'Ethereum') return 'about $8-20 of gas on Ethereum (batch actions for low-fee hours)';
  return `about $2-6 of gas on ${chain}`;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

/** The category's core farming action, written from the category and the protocol's own first chain. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Supply $${capital} of USDC to ${n} on ${chain}, then borrow about 30% against it and re-supply the borrowed amount once, so both sides of the market count as activity.`;
  if (c.includes('dex') || c.includes('liquidity')) return `Add $${capital} of liquidity to ${n}'s highest-volume pool on ${chain} (a stable or major pair if one exists) and leave the LP position open instead of hopping pools.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Deposit $${capital} of USDC margin on ${n} and trade one small hedged position a week; volume and open interest are what derivatives protocols usually measure.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the native staking asset through ${n} on ${chain}, keep the liquid receipt token in the same wallet, and do not sell the receipt.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('collateral')) return `Deposit $${capital} into one established ${n} vault on ${chain} and keep the vault shares; curator vaults typically reward sustained deposits over size alone.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} through its own app and hold it; RWA protocols track holders and holding time more than trade count.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${n} and take small positions in three liquid markets a week, letting each settle rather than cashing out early.`;
  if (c.includes('stable') || c.includes('algo')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold it in the farming wallet so the balance is visible in snapshots.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('basis')) return `Deposit $${capital} into ${n}'s main strategy on ${chain} and compound the yield back into the same position once a month.`;
  if (c.includes('bridge') || c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} through ${n}, then make two genuine transactions on the destination chain so the trip is not a bare bridge hop.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} for a position you actually hold, and renew it once before it expires.`;
  if (c.includes('launchpad')) return `Stake or commit $${capital} through ${n} on ${chain} and take part in one launch allocation round when it opens.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${n} on ${chain} and make one private transfer to your own second wallet, keeping amounts modest and regular.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and keep the position open; unused deposits in a third-party aggregator do not count.`;
}

/**
 * A farm plan of seven steps, generated from the protocol's category, chains,
 * TVL and age. Each step names an action, a cost and a time, and every string
 * is checked against the gate's 20-600 character window by boardIssue.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain, capital);
  const weekly = CHEAP_CHAINS.has(chain) ? 'about $1-2 of gas a week' : 'about $3-5 of gas a week';
  const steps = [
    `Set up one fresh wallet for ${p.name} only, fund it with $${capital + 25} on ${chain}, and store the seed phrase offline. Cost: ${gas}. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of working capital plus ${gas}. Time: 15-20 minutes to set up.`,
    `Repeat one qualifying action every week (a deposit top-up, a swap, a borrow-repay cycle or a vote, whichever ${p.name} offers) so the wallet shows a history, not a single visit. Cost: ${weekly}. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without emptying the wallet; sustained balances across weekly snapshots are the pattern points programs reward. Cost: the $${capital} stays deployed. Time: ${hold} days.`,
    `Check ${p.name}'s own app and official channels once a week for a points, season or testnet program, and join only through links the protocol itself publishes. Cost: nothing to check. Time: 5 minutes a week.`,
    `Keep every transaction hash, date and amount in a farm log for this wallet, and never move funds through a mixer or a flagged intermediary to reach ${p.name}. Cost: nothing. Time: 5 minutes to set up, 1 minute per entry.`,
    `When a launch or claim is announced, claim only from the link in ${p.name}'s own app, verify the contract address character by character, and never pay a fee to unlock an airdrop. Cost: claim gas only, ${gas}. Time: 10 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------- board

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const peers = peerMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isCandidate)
    .map((p) => {
      const { implied, breakdown } = impliedValue(p, snapshot.as_of, peers);
      return { p, implied, breakdown };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.breakdown.age_days,
    on_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    launch_score: launchScore(s.p, s.breakdown),
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.breakdown.age_days),
  }));
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, symbol: p.symbol }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const peers = peerMultiples(snapshot);
  const categories = [...new Set(board.map((r) => r.category ?? '(none)'))].sort();
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    universe_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    total_tvl_usd: board.reduce((n, r) => n + r.tvl_usd, 0),
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    global_peer_multiple: round4(peers.global),
    categories,
    chains,
    rows: board,
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board fails the gate's shape, or null. Mirrors the seven rows that concern the board itself. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i + 1} carries rank ${r.rank}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
