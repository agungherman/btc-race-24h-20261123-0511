// Snap-dip cbBTC racer — btc-race-24h-20261123-0511.
//
// Idea, from the dev window in this bounty kit: cbBTC falls in short
// bursts and then snaps back, while trend-chasing crossovers get
// whipsawed to pieces on this window. So this bot sits in cash most
// of the day and only buys a sharp 30-minute dip once the fall has
// stopped, then sells the snapback quickly. Long only, one position,
// full cash per trade, everything in integer math, no clock, no
// randomness, no network, no files — the reply depends only on the
// bars the harness has sent so far, so two runs are identical.
//
// Rules, in plain words:
//   buy  when the close is at least 60 bps below the close 30 bars
//        ago AND this bar closed at or above the previous bar
//        (the dip has stopped falling);
//   sell when the close is 80 bps above the entry close, or the
//        30-minute return is back above +60 bps (snap done), or
//        the position is 150 bps underwater, or 240 bars have
//        passed since entry;
//   never buy after bar 1380, so the last trades can settle before
//   the window ends and the harness flattens what is left.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const BPS = 10_000n;
const SLIPPAGE = 100;
const LOOKBACK = 30;
const DIP_BPS = 60n;
const TAKE_BPS = 80n;
const SNAP_BPS = 60n;
const STOP_BPS = 150n;
const MAX_HOLD = 240;
const LAST_BUY_SEQ = 1380;

// The closes we have seen, in raw price units (price_scale 5), one
// per scored bar. Warm-up bars are skipped by the caller, so index
// 0 here is the first tradable bar and index i is seq i.
const closes: bigint[] = [];

// Where the current position started: the close of the bar on
// which the buy was decided, and that bar's index. Null in cash.
let entryClose: bigint | null = null;
let entryIndex = -1;

// Return of the latest close against the close `n` bars back, in
// basis points, as a signed bigint. Null until enough bars exist.
function retBps(n: number): bigint | null {
  const len = closes.length;
  if (len <= n) return null;
  const now = closes[len - 1];
  const then = closes[len - 1 - n];
  if (then === 0n) return null;
  return ((now - then) * BPS) / then;
}

// Return of the latest close against the entry close, in bps.
function entryRetBps(): bigint | null {
  if (entryClose === null || entryClose === 0n) return null;
  const now = closes[closes.length - 1];
  return ((now - entryClose) * BPS) / entryClose;
}

// Decide the buy side: we are in cash, the dip is deep enough and
// this bar did not make a new low, so the fall has paused.
function wantBuy(state: BarsState): boolean {
  if (entryClose !== null) return false;
  if (state.warmingUp) return false;
  if (state.seq > LAST_BUY_SEQ) return false;
  if (state.cash <= 0n) return false;
  const dip = retBps(LOOKBACK);
  if (dip === null || dip > -DIP_BPS) return false;
  const len = closes.length;
  if (len < 2) return false;
  if (closes[len - 1] < closes[len - 2]) return false;
  return true;
}

// Decide the sell side: take the snapback, cut a bad dip, or give
// up after the hold limit. Any one reason is enough.
function wantSell(state: BarsState): boolean {
  if (entryClose === null) return false;
  const held = state.positions.get(SYMBOL);
  if (!held || held.qty <= 0n) return false;
  const gain = entryRetBps();
  if (gain !== null && gain >= TAKE_BPS) return true;
  if (gain !== null && gain <= -STOP_BPS) return true;
  const snap = retBps(LOOKBACK);
  if (snap !== null && snap >= SNAP_BPS) return true;
  if (state.seq - entryIndex >= MAX_HOLD) return true;
  return false;
}

// One batch, one reply. Record the bar, note any fill that opened
// or closed our position, then answer with at most one order.
async function onBatch(
  state: BarsState,
  batch: { fills: { client_id: string; status: string; side: string }[] },
): Promise<OrderInput[]> {
  const close = state.close(SYMBOL);
  if (close === null) return [];
  closes.push(close);

  // The fills on this batch tell us what the previous reply did.
  // A filled buy opens the position at this bar's close; a filled
  // sell closes it. Client ids are ours: "buy-<seq>" / "sell-<seq>".
  for (const fill of batch.fills) {
    if (fill.status !== "filled") continue;
    if (fill.side === "buy" && fill.client_id.startsWith("buy-")) {
      entryClose = close;
      entryIndex = state.seq;
    }
    if (fill.side === "sell" && fill.client_id.startsWith("sell-")) {
      entryClose = null;
      entryIndex = -1;
    }
  }

  if (state.warmingUp) return [];

  if (wantSell(state)) {
    const held = state.positions.get(SYMBOL);
    if (!held || held.qty <= 0n) return [];
    // Do not clear the entry here: only a filled sell closes the
    // position. Clearing on the decision would let a rejected sell
    // leave us holding with no entry recorded, and the next bar
    // could buy again while still long.
    return [
      {
        side: "sell",
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: SLIPPAGE,
        client_id: `sell-${state.seq}`,
      },
    ];
  }

  if (wantBuy(state)) {
    return [
      {
        side: "buy",
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE,
        client_id: `buy-${state.seq}`,
      },
    ];
  }

  return [];
}

await runBars({ onBatch });
