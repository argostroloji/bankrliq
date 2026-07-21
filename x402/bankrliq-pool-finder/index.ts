/**
 * bankrliq-pool-finder — x402 service handler ($0.05 USDC per call).
 * Bun runtime, no dependencies: chain reads via raw JSON-RPC, ABI coding by hand.
 *
 * GET query params or POST JSON body: { chain: "base"|"robinhood", token0?, token1?, fee? }
 *  - token0 + token1 → that exact pair; only token0 → CA search (WETH + stable pairs);
 *  - neither → WETH/stable defaults.
 * Returns { chain, pools: [{ fee, address, tickSpacing, token0, token1, tick, liquidity,
 *   price0In1, price1In0, tvlUsd, vol24hUsd, fees24hUsd, aprEst, volNote }] }.
 * Contract addresses chain-verified 2026-07-20.
 */

const CHAINS = {
  base: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    logsRpc: "https://mainnet.base.org",
    blockSec: 2.0,
    windowBlocks: 1800,
    logChunk: 1800,
  },
  robinhood: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    logsRpc: "https://rpc.mainnet.chain.robinhood.com",
    blockSec: 0.09,
    windowBlocks: 9000,
    logChunk: 3000,
  },
};
const FEES = [100, 500, 3000, 10000];
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const ZERO = "0x0000000000000000000000000000000000000000";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const SEL = {
  getPool: "0x1698ee82", slot0: "0x3850c7bd", liquidity: "0x1a686502",
  token0: "0x0dfe1681", balanceOf: "0x70a08231", decimals: "0x313ce567",
  symbol: "0x95d89b41", getBlockNumber: "0x42cbb15c",
};
const Q96 = Math.pow(2, 96);

/* ---- rpc + abi helpers ---- */
const strip = (h) => (typeof h === "string" && h.startsWith("0x") ? h.slice(2) : h || "");
const U256MASK = (BigInt(1) << BigInt(256)) - BigInt(1);
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
    if (ws.length === 1) return hexToUtf8(ws[0]).trim() || "???"; // bytes32 symbol
    const off = Number(toBig(ws[0])) / 32;
    const len = Number(toBig(ws[off]));
    return hexToUtf8(strip(hex).slice((off + 1) * 64, (off + 1) * 64 + len * 2)) || "???";
  } catch (e) { return "???"; }
}
async function rpc(urls, method, params) {
  let lastErr = null;
  for (const url of urls) {
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
const ethCall = (cfg, to, data) => rpc(cfg.rpcs, "eth_call", [{ to, data }, "latest"]);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

/* ---- main ---- */
async function main(q) {
  const chainKey = q.chain === "robinhood" ? "robinhood" : "base";
  const cfg = CHAINS[chainKey];
  const feeFilter = q.fee ? [Number(q.fee)] : FEES;
  for (const f of feeFilter) if (!TICK_SPACING[f]) return { error: "unsupported fee tier " + f };

  let pairs;
  if (isAddr(q.token0) && !q.token1) {
    const t = q.token0;
    const anchors = [cfg.weth, cfg.stable].filter((x) => x.toLowerCase() !== t.toLowerCase());
    pairs = anchors.length ? anchors.map((x) => [t, x]) : [[cfg.weth, cfg.stable]];
  } else {
    const tA = isAddr(q.token0) ? q.token0 : cfg.weth;
    const tB = isAddr(q.token1) ? q.token1 : cfg.stable;
    if (tA.toLowerCase() === tB.toLowerCase()) return { error: "token0 and token1 are the same" };
    pairs = [[tA, tB]];
  }

  // resolve pools (parallel eth_calls)
  const combos = [];
  for (const [tA, tB] of pairs) for (const fee of feeFilter) combos.push({ tA, tB, fee });
  const poolAddrs = await Promise.all(combos.map((c) =>
    ethCall(cfg, cfg.factory, SEL.getPool + padAddr(c.tA) + padAddr(c.tB) + word(c.fee)).catch(() => null)
  ));
  const found = [];
  combos.forEach((c, i) => {
    const addr = poolAddrs[i] ? toAddr(words(poolAddrs[i])[0]) : null;
    if (addr && addr !== ZERO) found.push({ ...c, addr });
  });
  if (!found.length) return { chain: chainKey, pools: [], note: "no pools found for this query" };

  // token metadata
  const uniq = [...new Set(found.flatMap((p) => [p.tA.toLowerCase(), p.tB.toLowerCase()]))];
  const meta = {};
  await Promise.all(uniq.map(async (t) => {
    const [symHex, decHex] = await Promise.all([
      ethCall(cfg, t, SEL.symbol).catch(() => null),
      ethCall(cfg, t, SEL.decimals).catch(() => null),
    ]);
    meta[t] = { symbol: symHex ? decodeString(symHex) : "???", decimals: decHex ? Number(toBig(words(decHex)[0])) : 18 };
  }));

  // WETH → USD via deepest WETH/stable pool (both chains: WETH is token0 vs 6-dec stable)
  let wethUsdCache;
  async function wethUsd() {
    if (wethUsdCache !== undefined) return wethUsdCache;
    wethUsdCache = null;
    for (const f of [500, 3000, 100]) {
      try {
        const pr = await ethCall(cfg, cfg.factory, SEL.getPool + padAddr(cfg.weth) + padAddr(cfg.stable) + word(f));
        const pool = toAddr(words(pr)[0]);
        if (pool === ZERO) continue;
        const s0 = await ethCall(cfg, pool, SEL.slot0);
        const sp = Number(toBig(words(s0)[0])) / Q96;
        wethUsdCache = sp * sp * Math.pow(10, 12);
        break;
      } catch (e) { /* next tier */ }
    }
    return wethUsdCache;
  }

  // latest block for volume sampling
  let latest = null;
  try {
    const r = await ethCall(cfg, MULTICALL3, SEL.getBlockNumber);
    latest = toBig(words(r)[0]);
  } catch (e) { latest = null; }

  const pools = await Promise.all(found.map(async (p) => {
    try {
      const [s0Hex, liqHex, t0Hex, balAHex, balBHex] = await Promise.all([
        ethCall(cfg, p.addr, SEL.slot0),
        ethCall(cfg, p.addr, SEL.liquidity),
        ethCall(cfg, p.addr, SEL.token0),
        ethCall(cfg, p.tA, SEL.balanceOf + padAddr(p.addr)),
        ethCall(cfg, p.tB, SEL.balanceOf + padAddr(p.addr)),
      ]);
      const s0w = words(s0Hex);
      const sqrtP = toBig(s0w[0]);
      const tick = Number(toInt(s0w[1]));
      const liq = toBig(words(liqHex)[0]);
      const aIs0 = toAddr(words(t0Hex)[0]).toLowerCase() === p.tA.toLowerCase();
      const t0 = aIs0 ? p.tA : p.tB, t1 = aIs0 ? p.tB : p.tA;
      const m0 = meta[t0.toLowerCase()], m1 = meta[t1.toLowerCase()];
      const bal0 = toBig(words(aIs0 ? balAHex : balBHex)[0]);
      const bal1 = toBig(words(aIs0 ? balBHex : balAHex)[0]);

      const sp = Number(sqrtP) / Q96;
      const price0In1 = sp * sp * Math.pow(10, m0.decimals - m1.decimals);

      // USD pricing: stable=1, WETH via anchor pool, other leg via this pool's price
      async function usdOf(addr) {
        const lo = addr.toLowerCase();
        if (lo === cfg.stable.toLowerCase()) return 1;
        if (lo === cfg.weth.toLowerCase()) return wethUsd();
        return null;
      }
      let usd0 = await usdOf(t0), usd1 = await usdOf(t1);
      if (usd0 == null && usd1 != null) usd0 = price0In1 * usd1;
      if (usd1 == null && usd0 != null && price0In1 > 0) usd1 = usd0 / price0In1;

      let tvlUsd = null;
      if (usd0 != null && usd1 != null) {
        tvlUsd = (Number(bal0) / Math.pow(10, m0.decimals)) * usd0 + (Number(bal1) / Math.pow(10, m1.decimals)) * usd1;
      }

      // 24h volume: sample recent Swap logs, scale by assumed block time
      let vol24hUsd = null, volNote = null;
      if (latest != null && (usd0 != null || usd1 != null)) {
        try {
          const from = latest > BigInt(cfg.windowBlocks) ? latest - BigInt(cfg.windowBlocks) : BigInt(0);
          const sideIs0 = usd0 != null;
          const sideUsd = sideIs0 ? usd0 : usd1;
          const sideDec = sideIs0 ? m0.decimals : m1.decimals;
          let sum = 0, count = 0;
          for (let start = from; start <= latest; start += BigInt(cfg.logChunk) + BigInt(1)) {
            const end = start + BigInt(cfg.logChunk) > latest ? latest : start + BigInt(cfg.logChunk);
            const logs = await rpc([cfg.logsRpc], "eth_getLogs", [{
              address: p.addr, topics: [SWAP_TOPIC],
              fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16),
            }]);
            for (const lg of logs || []) {
              const ws = words(lg.data);
              let amt = toInt(ws[sideIs0 ? 0 : 1]);
              if (amt < BigInt(0)) amt = -amt;
              sum += Number(amt) / Math.pow(10, sideDec);
              count++;
            }
          }
          const windowSec = cfg.windowBlocks * cfg.blockSec;
          vol24hUsd = sum * sideUsd * (86400 / windowSec);
          volNote = "scaled to 24h from a ~" + Math.round(windowSec / 60) + "-min sample (" + count + " swaps, assumed " + cfg.blockSec + "s blocks)";
        } catch (e) { volNote = "volume sampling unavailable"; }
      }
      const fees24hUsd = vol24hUsd != null ? vol24hUsd * (p.fee / 1e6) : null;
      const aprEst = fees24hUsd != null && tvlUsd ? (fees24hUsd / tvlUsd) * 365 * 100 : null;

      return {
        fee: p.fee, address: p.addr, tickSpacing: TICK_SPACING[p.fee],
        token0: { address: t0, symbol: m0.symbol, decimals: m0.decimals },
        token1: { address: t1, symbol: m1.symbol, decimals: m1.decimals },
        tick, liquidity: liq.toString(),
        price0In1, price1In0: price0In1 > 0 ? 1 / price0In1 : null,
        tvlUsd, vol24hUsd, fees24hUsd, aprEst, volNote,
      };
    } catch (e) {
      return { fee: p.fee, address: p.addr, error: String(e && e.message ? e.message : e).slice(0, 160) };
    }
  }));

  return { chain: chainKey, pools };
}

export default async function handler(req) {
  try {
    let q = {};
    if (req.method === "GET") q = Object.fromEntries(new URL(req.url).searchParams);
    else q = await req.json().catch(() => ({}));
    const result = await main(q || {});
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
}
