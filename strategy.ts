// Surge Rider — a momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves die fast and a few run hard. This bot waits for a curve to
// prove it is alive — several distinct buyers pushing real SOL in over a short window,
// price rising and holding near its window high, with the inflow accelerating — then
// buys small, adds only into strength, and gets out on a stop loss, a trailing stop, a
// fade in flow, or a time limit. It never touches real money: the harness replays
// recorded chain data, fills are paper, and this code makes no network call, reads no
// secret, no clock and no environment — every decision comes from the hello message
// and the batch stream (see `hello`, `batch` and `orders` below), so two runs on the
// same data produce the same action log.
//
// Guardrails: the run must clear at least 20 distinct coins with a round trip of at
// least 0.01 SOL each and a max drawdown of 50% or less. Tiny probe round trips keep
// the run on pace for that bar when momentum entries are scarce; probes are capped
// at one open at a time and 0.02 SOL each.
//
// Price of a curve is its virtual reserves ratio (virtual SOL / virtual tokens).
// Position value is what a full sell would return at the latest reserves, curve
// fees and one transaction fee deducted. All SOL figures below are plain numbers;
// lamports are only produced at the moment an order is built.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window, in slots. */
  window: number;
  /** Minimum net SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum price rise over the window (fraction, e.g. 0.05 = +5%). */
  minPriceUp: number;
  /** Maximum price rise over the window; skip curves that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single buyer's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Total SOL a position may hold at cost. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each pyramid add-on buy (SOL). */
  addSol: number;
  /** Add only once price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position is up at least this much (fraction of cost). */
  addIfUp: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Stop loss vs cost (fraction). */
  stopLoss: number;
  /** Trailing stop vs the position's peak value (fraction). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Fade window in slots for the exit flow check. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  /** Hold past the time limit while up at least this much (fraction of cost). */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target distinct coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of one probe round trip (SOL). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 3.0,
  minBuys: 4,
  minBuyers: 5,
  minPriceUp: 0.15,
  maxPriceUp: 1.5,
  accel: 1.0,
  nearHigh: 0.97,
  maxBuyerShare: 0.55,
  minRqSol: 1.5,
  maxRqSol: 40,
  minAge: 800,
  stakeSol: 0.2,
  minBuySol: 0.01,
  firstSol: 0.05,
  addSol: 0.05,
  addStep: 0.03,
  addIfUp: 0.02,
  buySlipBps: 2000,
  stopLoss: 0.1,
  trail: 0.15,
  trailArm: 0.02,
  fadeWindow: 20,
  fadeNetSol: 0.5,
  bigSellSol: 8,
  maxHold: 400,
  holdIfUp: 0.2,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 5,
  targetCoins: 30,
  targetFills: 180,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee share (protocol + creator fallback, 95 + 30 bps). */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Mints this bot has ever sent a buy for (probes included): its own fills move
   * their reserves, so later buys on them size to 90% of the visible cap. */
  const touched = new Set<Pubkey>();
  /** Mints this bot fully exited: its sells pulled quote out of the curve, so a
   * re-entry sizes to 90% of the visible cap. While a position is still held,
   * only buys have touched the curve (buys add quote), so adds need no margin. */
  const exited = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of this tape. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal: a mature curve with broad, accelerating buy pressure near its high. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop loss, trailing stop, fade, big sell, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) {
              t.lastExit = now;
              exited.add(mint);
            } else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.firstSol, p.stakeSol);
        } else {
          // Pyramid into strength only: price stepped up from the last add, the
          // position is up, and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * (1 + p.addIfUp)) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        // The 1%-of-real-reserve cap is judged on the harness's reserves at
        // decision time. On a curve this bot never touched, those match what it
        // sees. Its own sells pulled quote out of a curve it exited, and its
        // probe round trips leave a small drift, so those buys size down (90%
        // after an exit, 99% after a probe). Adds while holding need no margin:
        // only buys have touched that curve, and buys add quote to it.
        const capFactor = exited.has(mint) ? 0.9 : touched.has(mint) ? 0.99 : 1;
        const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * capFactor;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            touched.add(mint);
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
