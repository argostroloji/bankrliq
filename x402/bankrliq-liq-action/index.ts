/**
 * bankrliq-liq-action — x402 service handler ($0.50 USDC per call).
 * Bun runtime, no dependencies: chain reads via raw JSON-RPC, ABI coding by hand.
 * Prepares Uniswap V3 LP transactions — NOTHING is signed server-side.
 *
 * POST JSON body: { action: "mint"|"decrease"|"collect"|"burn"|"close", chain, ... }
 *   mint:     token0, token1, fee, amount0, amount1, rangeMode|tickLower/Upper,
 *             recipient (required), slippageBps?
 *   decrease: tokenId, percent? (default 100), slippageBps?
 *   collect:  tokenId, recipient (required)
 *   burn:     tokenId
 *   close:    tokenId, percent? (default 100), burn? (default true at 100%),
 *             recipient (required), slippageBps?  → ONE NPM.multicall = one signature
 * Returns { txBlobs: [{label, blob, raw}] } — blob === raw === {chain, to, data, value};
 * pass to bankr.confirmTransaction or sign with any wallet.
 * Contract addresses chain-verified 2026-07-20.
 */

const CHAINS = {
  base: {
    npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  },
  robinhood: {
    npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
  },
};
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const MIN_TICK = -887272, MAX_TICK = 887272;
const ZERO = "0x0000000000000000000000000000000000000000";
const SEL = {
  getPool: "0x1698ee82", slot0: "0x3850c7bd", token0: "0x0dfe1681",
  decimals: "0x313ce567", symbol: "0x95d89b41", positions: "0x99fbab88",
  approve: "0x095ea7b3", mint: "0x88316456", decreaseLiquidity: "0x0c49ccbe",
  collect: "0xfc6f7865", burn: "0x42966c68", multicall: "0xac9650d8",
};

/* ---- rpc + abi helpers ---- */
const strip = (h) => (typeof h === "string" && h.startsWith("0x") ? h.slice(2) : h || "");
const U256MASK = (BigInt(1) << BigInt(256)) - BigInt(1);
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const word = (v) => (BigInt(v) & U256MASK).toString(16).padStart(64, "0");
const padAddr = (a) => strip(a).toLowerCase().padStart(64, "0");
function words(hex) { const h = strip(hex); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64)); return out; }
const toBig = (w) => BigInt("0x" + (w || "0"));
const toInt = (w) => { let v = toBig(w); if (v >= BigInt(1) << BigInt(255)) v -= BigInt(1) << BigInt(256); return v; };
const toAddr = (w) => "0x" + (w || "").slice(24);
function hexToUtf8(h) {
  let s = "";
  for (let i = 0; i < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c > 0) s += String.fromCharCode(c);
  }
  return s;
}
function decodeString(hex) {
  try {
    const ws = words(hex);
    if (!ws.length) return "???";
    if (ws.length === 1) return hexToUtf8(ws[0]).trim() || "???";
    const off = Number(toBig(ws[0])) / 32;
    const len = Number(toBig(ws[off]));
    return hexToUtf8(strip(hex).slice((off + 1) * 64, (off + 1) * 64 + len * 2)) || "???";
  } catch (e) { return "???"; }
}
async function rpcCall(cfg, method, params) {
  let lastErr = null;
  for (const url of cfg.rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all RPCs failed");
}
const ethCall = (cfg, to, data) => rpcCall(cfg, "eth_call", [{ to, data }, "latest"]);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

// multicall(bytes[]) — dynamic array of dynamic bytes
function encMulticall(callsHex) {
  const els = callsHex.map(strip);
  const offsets = [];
  const bodies = [];
  let cur = els.length * 32;
  for (const e of els) {
    offsets.push(cur);
    const len = e.length / 2;
    const padded = e.padEnd(Math.ceil(len / 32) * 64, "0");
    bodies.push(word(len) + padded);
    cur += 32 + padded.length / 2;
  }
  return SEL.multicall + word(0x20) + word(els.length) + offsets.map(word).join("") + bodies.join("");
}

/* ---- uniswap v3 math (pure JS) ---- */
const Q96n = BigInt(1) << BigInt(96);
function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio = (absTick & BigInt(1)) !== BigInt(0)
    ? BigInt("0xfffcb933bd6fad37aa2d162d1a594001")
    : BigInt("0x100000000000000000000000000000000");
  const steps = [
    ["0x2", "0xfff97272373d413259a46990580e213a"], ["0x4", "0xfff2e50f5f656932ef12357cf3c7fdcc"],
    ["0x8", "0xffe5caca7e10e4e61c3624eaa0941cd0"], ["0x10", "0xffcb9843d60f6159c9db58835c926644"],
    ["0x20", "0xff973b41fa98c081472e6896dfb254c0"], ["0x40", "0xff2ea16466c96a3843ec78b326b52861"],
    ["0x80", "0xfe5dee046a99a2a811c461f1969c3053"], ["0x100", "0xfcbe86c7900a88aedcffc83b479aa3a4"],
    ["0x200", "0xf987a7253ac413176f2b074cf7815e54"], ["0x400", "0xf3392b0822b70005940c7a398e4b70f3"],
    ["0x800", "0xe7159475a2c29b7443b29c7fa6e889d9"], ["0x1000", "0xd097f3bdfd2022b8845ad8f792aa5825"],
    ["0x2000", "0xa9f746462d870fdf8a65dc1f90e061e5"], ["0x4000", "0x70d869a156d2a1b890bb3df62baf32f7"],
    ["0x8000", "0x31be135f97d08fd981231505542fcfa6"], ["0x10000", "0x9aa508b5b7a84e1c677de54f3e99bc9"],
    ["0x20000", "0x5d6af8dedb81196699c329225ee604"], ["0x40000", "0x2216e584f5fa1ea926041bedfe98"],
    ["0x80000", "0x48a170391f7dc42444e8fa2"],
  ];
  for (const [bit, mul] of steps) {
    if ((absTick & BigInt(bit)) !== BigInt(0)) ratio = (ratio * BigInt(mul)) >> BigInt(128);
  }
  if (tick > 0) ratio = U256MASK / ratio;
  return (ratio >> BigInt(32)) + ((ratio & ((BigInt(1) << BigInt(32)) - BigInt(1))) === BigInt(0) ? BigInt(0) : BigInt(1));
}
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) { const t = sqrtA; sqrtA = sqrtB; sqrtB = t; }
  let amount0 = BigInt(0), amount1 = BigInt(0);
  if (sqrtP <= sqrtA) amount0 = (L * Q96n * (sqrtB - sqrtA)) / sqrtB / sqrtA;
  else if (sqrtP >= sqrtB) amount1 = (L * (sqrtB - sqrtA)) / Q96n;
  else {
    amount0 = (L * Q96n * (sqrtB - sqrtP)) / sqrtB / sqrtP;
    amount1 = (L * (sqrtP - sqrtA)) / Q96n;
  }
  return [amount0, amount1];
}
function parseUnits(s, dec) {
  s = String(s == null ? "0" : s).trim();
  if (s === "") s = "0";
  if (/e/i.test(s)) s = Number(s).toFixed(dec);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid amount: " + s);
  const parts = s.split(".");
  const frac = ((parts[1] || "") + "0".repeat(dec)).slice(0, dec);
  return BigInt(parts[0] + frac);
}
function alignTick(t, spacing, up) {
  const q = up ? Math.ceil(t / spacing) : Math.floor(t / spacing);
  const lo = Math.ceil(MIN_TICK / spacing) * spacing;
  const hi = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(Math.max(q * spacing, lo), hi);
}
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };

/* ---- shared reads ---- */
async function readPosition(cfg, tokenId) {
  const r = await ethCall(cfg, cfg.npm, SEL.positions + word(tokenId));
  const ws = words(r);
  if (ws.length < 12) throw new Error("position not found");
  return {
    token0: toAddr(ws[2]), token1: toAddr(ws[3]), fee: Number(toBig(ws[4])),
    tickLower: Number(toInt(ws[5])), tickUpper: Number(toInt(ws[6])),
    liquidity: toBig(ws[7]), owed0: toBig(ws[10]), owed1: toBig(ws[11]),
  };
}
async function decreaseMins(cfg, p, liq, slippageBps) {
  let amount0Min = BigInt(0), amount1Min = BigInt(0);
  try {
    const pr = await ethCall(cfg, cfg.factory, SEL.getPool + padAddr(p.token0) + padAddr(p.token1) + word(p.fee));
    const pool = toAddr(words(pr)[0]);
    if (pool !== ZERO && liq > BigInt(0)) {
      const s0 = await ethCall(cfg, pool, SEL.slot0);
      const [a0, a1] = amountsForLiquidity(toBig(words(s0)[0]), getSqrtRatioAtTick(p.tickLower), getSqrtRatioAtTick(p.tickUpper), liq);
      const bps = BigInt(10000 - slippageBps);
      amount0Min = (a0 * bps) / BigInt(10000);
      amount1Min = (a1 * bps) / BigInt(10000);
    }
  } catch (e) { /* keep zero mins */ }
  return [amount0Min, amount1Min];
}
const encDecrease = (tokenId, liq, a0Min, a1Min, deadline) =>
  SEL.decreaseLiquidity + word(tokenId) + word(liq) + word(a0Min) + word(a1Min) + word(deadline);
const encCollect = (tokenId, recipient) =>
  SEL.collect + word(tokenId) + padAddr(recipient) + word(MAX_UINT128) + word(MAX_UINT128);
const encBurn = (tokenId) => SEL.burn + word(tokenId);
const tx = (chain, to, data, label) => ({ label, blob: { chain, to, data, value: "0x0", label }, raw: { chain, to, data, value: "0x0" } });

/* ---- main ---- */
async function main(a) {
  const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
  const cfg = CHAINS[chainKey];
  const action = a.action;
  const parseTokenId = (v) => { const id = BigInt(v); if (id < BigInt(0)) throw new Error("invalid tokenId"); return id; };
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);

  if (action === "mint") {
    const fee = Number(a.fee);
    const spacing = TICK_SPACING[fee];
    if (!spacing) throw new Error("unsupported fee tier");
    if (!isAddr(a.token0) || !isAddr(a.token1)) throw new Error("token0 and token1 are required");
    if (!isAddr(a.recipient)) throw new Error("recipient is required (your wallet address)");
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);

    const pr = await ethCall(cfg, cfg.factory, SEL.getPool + padAddr(a.token0) + padAddr(a.token1) + word(fee));
    const poolAddr = toAddr(words(pr)[0]);
    if (poolAddr === ZERO) throw new Error("pool does not exist for this pair/fee");

    const [s0Hex, t0Hex, decAHex, decBHex, symAHex, symBHex] = await Promise.all([
      ethCall(cfg, poolAddr, SEL.slot0),
      ethCall(cfg, poolAddr, SEL.token0),
      ethCall(cfg, a.token0, SEL.decimals),
      ethCall(cfg, a.token1, SEL.decimals),
      ethCall(cfg, a.token0, SEL.symbol).catch(() => null),
      ethCall(cfg, a.token1, SEL.symbol).catch(() => null),
    ]);
    const s0w = words(s0Hex);
    const tick = Number(toInt(s0w[1]));
    const aIs0 = toAddr(words(t0Hex)[0]).toLowerCase() === a.token0.toLowerCase();
    const token0 = aIs0 ? a.token0 : a.token1, token1 = aIs0 ? a.token1 : a.token0;
    const decA = Number(toBig(words(decAHex)[0])), decB = Number(toBig(words(decBHex)[0]));
    const dec0 = aIs0 ? decA : decB, dec1 = aIs0 ? decB : decA;
    const symA = symAHex ? decodeString(symAHex) : "T0", symB = symBHex ? decodeString(symBHex) : "T1";
    const sym0 = aIs0 ? symA : symB, sym1 = aIs0 ? symB : symA;
    const amount0Desired = parseUnits(aIs0 ? a.amount0 : a.amount1, dec0);
    const amount1Desired = parseUnits(aIs0 ? a.amount1 : a.amount0, dec1);
    if (amount0Desired === BigInt(0) && amount1Desired === BigInt(0)) throw new Error("both amounts are zero");

    let tickLower, tickUpper;
    const mode = a.rangeMode || "manual";
    if (mode === "auto10" || mode === "auto20") {
      const d = Math.round(Math.log(mode === "auto10" ? 1.10 : 1.20) / Math.log(1.0001));
      tickLower = alignTick(tick - d, spacing, false);
      tickUpper = alignTick(tick + d, spacing, true);
    } else if (mode === "full") {
      tickLower = Math.ceil(MIN_TICK / spacing) * spacing;
      tickUpper = Math.floor(MAX_TICK / spacing) * spacing;
    } else {
      tickLower = alignTick(Number(a.tickLower), spacing, false);
      tickUpper = alignTick(Number(a.tickUpper), spacing, true);
    }
    if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper) || tickLower >= tickUpper) throw new Error("invalid tick range");

    const bps = BigInt(10000 - slippageBps);
    const txBlobs = [];
    if (amount0Desired > BigInt(0)) {
      txBlobs.push(tx(chainKey, token0, SEL.approve + padAddr(cfg.npm) + word(amount0Desired), "Approve " + sym0));
    }
    if (amount1Desired > BigInt(0)) {
      txBlobs.push(tx(chainKey, token1, SEL.approve + padAddr(cfg.npm) + word(amount1Desired), "Approve " + sym1));
    }
    const mintData = SEL.mint +
      padAddr(token0) + padAddr(token1) + word(fee) +
      word(tickLower) + word(tickUpper) +
      word(amount0Desired) + word(amount1Desired) +
      word((amount0Desired * bps) / BigInt(10000)) + word((amount1Desired * bps) / BigInt(10000)) +
      padAddr(a.recipient) + word(deadline());
    txBlobs.push(tx(chainKey, cfg.npm, mintData, "Mint " + sym0 + "/" + sym1 + " LP"));

    const sp = Number(toBig(s0w[0])) / Math.pow(2, 96);
    return {
      action, chain: chainKey, pool: poolAddr, fee, tickLower, tickUpper, currentTick: tick,
      currentPrice: sp * sp * Math.pow(10, dec0 - dec1),
      priceLower: Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1),
      priceUpper: Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1),
      token0: { address: token0, symbol: sym0 }, token1: { address: token1, symbol: sym1 },
      txBlobs, note: "Sign in order: approvals first, then mint.",
    };
  }

  if (action === "decrease") {
    const tokenId = parseTokenId(a.tokenId);
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);
    const percent = clamp(a.percent, 1, 100, 100);
    const p = await readPosition(cfg, tokenId);
    const liq = (p.liquidity * BigInt(Math.round(percent * 100))) / BigInt(10000);
    if (liq <= BigInt(0)) throw new Error("nothing to remove");
    const [a0Min, a1Min] = await decreaseMins(cfg, p, liq, slippageBps);
    const data = encDecrease(tokenId, liq, a0Min, a1Min, deadline());
    return { action, chain: chainKey, tokenId: tokenId.toString(), percent, liquidityRemoved: liq.toString(), txBlobs: [tx(chainKey, cfg.npm, data, "Decrease liquidity #" + tokenId)] };
  }

  if (action === "collect") {
    const tokenId = parseTokenId(a.tokenId);
    if (!isAddr(a.recipient)) throw new Error("recipient is required (your wallet address)");
    const data = encCollect(tokenId, a.recipient);
    return { action, chain: chainKey, tokenId: tokenId.toString(), recipient: a.recipient, txBlobs: [tx(chainKey, cfg.npm, data, "Collect fees #" + tokenId)] };
  }

  if (action === "burn") {
    const tokenId = parseTokenId(a.tokenId);
    return { action, chain: chainKey, tokenId: tokenId.toString(), txBlobs: [tx(chainKey, cfg.npm, encBurn(tokenId), "Burn NFT #" + tokenId)] };
  }

  if (action === "close") {
    const tokenId = parseTokenId(a.tokenId);
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);
    const percent = clamp(a.percent, 1, 100, 100);
    if (!isAddr(a.recipient)) throw new Error("recipient is required (your wallet address)");
    const p = await readPosition(cfg, tokenId);
    const liq = (p.liquidity * BigInt(Math.round(percent * 100))) / BigInt(10000);
    const doBurn = a.burn !== false && percent === 100;

    const calls = [];
    const steps = [];
    if (liq > BigInt(0)) {
      const [a0Min, a1Min] = await decreaseMins(cfg, p, liq, slippageBps);
      calls.push(encDecrease(tokenId, liq, a0Min, a1Min, deadline()));
      steps.push("decreaseLiquidity");
    }
    calls.push(encCollect(tokenId, a.recipient));
    steps.push("collect");
    if (doBurn) {
      calls.push(encBurn(tokenId));
      steps.push("burn");
    }
    const data = encMulticall(calls);
    return {
      action, chain: chainKey, tokenId: tokenId.toString(), percent, burn: doBurn, steps,
      liquidityRemoved: liq.toString(),
      txBlobs: [tx(chainKey, cfg.npm, data, "Close #" + tokenId + " (" + percent + "%)")],
      note: "Single signature: " + steps.join(" + ") + ".",
    };
  }

  return { error: "action must be mint | decrease | collect | burn | close" };
}

export default async function handler(req) {
  try {
    let body = {};
    if (req.method === "GET") body = Object.fromEntries(new URL(req.url).searchParams);
    else body = await req.json().catch(() => ({}));
    const result = await main(body || {});
    return new Response(JSON.stringify(result), {
      status: result && result.error ? 400 : 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
}
