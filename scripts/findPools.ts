// BANKRLIQ — findPools (OWNER-ONLY free twin of the paid pool-finder endpoint;
// everyone else pays $0.05 via x402). Same args and same response shape:
// { chain, token0?, token1?, fee? } → { chain, pools: [...] }.

const OWNER = "0xa2baa5527e25de10099096a3257d0b1938f095b1";
const callerAddr0 = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr0 || callerAddr0.toLowerCase() !== OWNER) {
  return { error: "owner-only script — use the paid pool-finder endpoint ($0.05)" };
}

const CHAINS = {
  base: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    logsRpc: "https://mainnet.base.org",
    blockSec: 2.0,
    windowBlocks: 1800,
  },
  robinhood: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    logsRpc: "https://rpc.mainnet.chain.robinhood.com",
    blockSec: 0.09,
    windowBlocks: 6000,
  },
};
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/* bankr.chain.getLogs can be privileged in the app sandbox — fall back to raw
   JSON-RPC via http.fetch (returns the parsed body directly). Chunked ranges. */
async function fetchSwapLogs(cfg, chainKey, poolAddr, fromBlock, toBlock) {
  try {
    const logs = await bankr.chain.getLogs({
      chain: chainKey, address: poolAddr,
      fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16),
      event: SWAP_EVENT,
    });
    return logs || [];
  } catch (eLogs) {
    const HALF = BigInt(1) << BigInt(255), FULL = BigInt(1) << BigInt(256);
    const out = [];
    const CH = BigInt(2000);
    for (let s = fromBlock; s <= toBlock; s += CH + BigInt(1)) {
      const e2 = s + CH > toBlock ? toBlock : s + CH;
      const resp = await http.fetch(cfg.logsRpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getLogs",
          params: [{ address: poolAddr, topics: [SWAP_TOPIC], fromBlock: "0x" + s.toString(16), toBlock: "0x" + e2.toString(16) }],
        }),
      });
      const raw = resp && resp.result !== undefined ? resp.result : resp;
      for (const lg of raw || []) {
        const h = String(lg.data || "").replace(/^0x/, "");
        let w0 = BigInt("0x" + (h.slice(0, 64) || "0"));
        let w1 = BigInt("0x" + (h.slice(64, 128) || "0"));
        if (w0 >= HALF) w0 -= FULL;
        if (w1 >= HALF) w1 -= FULL;
        out.push({ args: { amount0: w0, amount1: w1 } });
      }
    }
    return out;
  }
}
const FEES = [100, 500, 3000, 10000];
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const ZERO = "0x0000000000000000000000000000000000000000";

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
    outputs: [{ type: "address" }] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
];
const MC3_ABI = [
  { type: "function", name: "getBlockNumber", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const SWAP_EVENT = {
  type: "event", name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
};

const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const Q96 = Math.pow(2, 96);
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

// multicall may be restricted in some sandbox contexts — fall back to plain
// sequential readContract calls, which need only the read:chain permission.
async function mcall(ck, calls) {
  try {
    return await bankr.chain.multicall({ chain: ck, calls });
  } catch (e) {
    const out = [];
    for (const c of calls) {
      try {
        out.push({ status: "success", result: await bankr.chain.readContract({ chain: ck, address: c.address, abi: c.abi, functionName: c.functionName, args: c.args }) });
      } catch (e2) { out.push({ status: "failure", result: null }); }
    }
    return out;
  }
}

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const feeFilter = a.fee ? [Number(a.fee)] : FEES;
for (const f of feeFilter) if (!TICK_SPACING[f]) return { error: "unsupported fee tier " + f };

// build pair list
let pairs;
if (isAddr(a.token0) && !a.token1) {
  const t = a.token0;
  const anchors = [cfg.weth, cfg.stable].filter((x) => x.toLowerCase() !== t.toLowerCase());
  pairs = anchors.length ? anchors.map((x) => [t, x]) : [[cfg.weth, cfg.stable]];
} else {
  const tA = isAddr(a.token0) ? a.token0 : cfg.weth;
  const tB = isAddr(a.token1) ? a.token1 : cfg.stable;
  if (tA.toLowerCase() === tB.toLowerCase()) return { error: "token0 and token1 are the same" };
  pairs = [[tA, tB]];
}

// resolve pools for every pair×fee in one multicall
const poolCalls = [];
for (const [tA, tB] of pairs) for (const fee of feeFilter) {
  poolCalls.push({ address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [tA, tB, fee] });
}
const poolAddrs = (await mcall(chainKey, poolCalls)).map(norm);

const found = [];
let pi = 0;
for (const [tA, tB] of pairs) for (const fee of feeFilter) {
  const addr = poolAddrs[pi++];
  if (addr && addr !== ZERO) found.push({ tA, tB, fee, addr });
}
if (found.length === 0) return { chain: chainKey, pools: [], note: "no pools found for this query" };

// pool state + token metadata in one multicall
const stateCalls = [];
for (const p of found) {
  stateCalls.push(
    { address: p.addr, abi: POOL_ABI, functionName: "slot0", args: [] },
    { address: p.addr, abi: POOL_ABI, functionName: "liquidity", args: [] },
    { address: p.addr, abi: POOL_ABI, functionName: "token0", args: [] },
    { address: p.tA, abi: ERC20_ABI, functionName: "balanceOf", args: [p.addr] },
    { address: p.tB, abi: ERC20_ABI, functionName: "balanceOf", args: [p.addr] },
  );
}
const uniqTokens = [...new Set(found.flatMap((p) => [p.tA.toLowerCase(), p.tB.toLowerCase()]))];
for (const t of uniqTokens) {
  stateCalls.push(
    { address: t, abi: ERC20_ABI, functionName: "symbol", args: [] },
    { address: t, abi: ERC20_ABI, functionName: "decimals", args: [] },
  );
}
const st = (await mcall(chainKey, stateCalls)).map(norm);
const meta = {};
uniqTokens.forEach((t, i) => {
  meta[t] = { symbol: st[found.length * 5 + i * 2] || "???", decimals: Number(st[found.length * 5 + i * 2 + 1] ?? 18) };
});

// WETH → USD via the deepest WETH/stable pool (for pricing non-stable pairs)
async function wethUsd() {
  const cands = (await mcall(chainKey,
    [500, 3000, 100].map((f) => ({ address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [cfg.weth, cfg.stable, f] }))
  )).map(norm).filter((x) => x && x !== ZERO);
  if (!cands.length) return null;
  const s0 = norm(await bankr.chain.readContract({ chain: chainKey, address: cands[0], abi: POOL_ABI, functionName: "slot0", args: [] }));
  const sp = Number(BigInt(s0[0])) / Q96;
  return sp * sp * Math.pow(10, 18 - 6); // WETH is token0 vs 6-dec stable on both chains
}
let wethPriceUsd = null;

// latest block for the volume sampling window
let latestBlock = null;
try {
  latestBlock = BigInt(norm(await bankr.chain.readContract({
    chain: chainKey, address: MULTICALL3, abi: MC3_ABI, functionName: "getBlockNumber", args: [],
  })));
} catch (e) { latestBlock = null; }

const pools = [];
for (let i = 0; i < found.length; i++) {
  const p = found[i];
  const slot0 = st[i * 5];
  const liq = st[i * 5 + 1];
  const poolT0 = String(st[i * 5 + 2] || "").toLowerCase();
  if (!slot0) { pools.push({ fee: p.fee, address: p.addr, error: "unreadable" }); continue; }

  const aIs0 = poolT0 === p.tA.toLowerCase();
  const t0 = aIs0 ? p.tA : p.tB, t1 = aIs0 ? p.tB : p.tA;
  const m0 = meta[t0.toLowerCase()], m1 = meta[t1.toLowerCase()];
  const bal0 = BigInt(st[i * 5 + (aIs0 ? 3 : 4)] || 0);
  const bal1 = BigInt(st[i * 5 + (aIs0 ? 4 : 3)] || 0);

  const sp = Number(BigInt(slot0[0])) / Q96;
  const price0In1 = sp * sp * Math.pow(10, m0.decimals - m1.decimals);
  const tick = Number(slot0[1]);

  // USD prices per token (stable=1, WETH via anchor pool, else via this pool if paired with one)
  async function tokenUsd(addr, dec, priceInOther, otherUsd) {
    const lo = addr.toLowerCase();
    if (lo === cfg.stable.toLowerCase()) return 1;
    if (lo === cfg.weth.toLowerCase()) {
      if (wethPriceUsd == null) wethPriceUsd = await wethUsd();
      return wethPriceUsd;
    }
    return otherUsd != null && priceInOther != null ? priceInOther * otherUsd : null;
  }
  const usd1Direct = await tokenUsd(t1, m1.decimals, null, null);
  const usd0Direct = await tokenUsd(t0, m0.decimals, null, null);
  const usd0 = usd0Direct != null ? usd0Direct : (usd1Direct != null ? price0In1 * usd1Direct : null);
  const usd1 = usd1Direct != null ? usd1Direct : (usd0Direct != null && price0In1 > 0 ? usd0Direct / price0In1 : null);

  let tvlUsd = null;
  if (usd0 != null && usd1 != null) {
    tvlUsd = (Number(bal0) / Math.pow(10, m0.decimals)) * usd0 + (Number(bal1) / Math.pow(10, m1.decimals)) * usd1;
  }

  // 24h volume: sample recent Swap logs, scale by assumed block time
  let vol24hUsd = null, volNote = null;
  if (latestBlock != null) {
    try {
      const from = latestBlock > BigInt(cfg.windowBlocks) ? latestBlock - BigInt(cfg.windowBlocks) : BigInt(0);
      const logs = await fetchSwapLogs(cfg, chainKey, p.addr, from, latestBlock);
      const sideIs0 = usd0 != null;
      const sideUsd = sideIs0 ? usd0 : usd1;
      if (sideUsd != null) {
        let sum = 0;
        for (const lg of logs || []) {
          const amt = lg && lg.args ? (sideIs0 ? lg.args.amount0 : lg.args.amount1) : null;
          if (amt == null) continue;
          let v = BigInt(amt); if (v < BigInt(0)) v = -v;
          sum += Number(v) / Math.pow(10, sideIs0 ? m0.decimals : m1.decimals);
        }
        const windowSec = cfg.windowBlocks * cfg.blockSec;
        vol24hUsd = sum * sideUsd * (86400 / windowSec);
        volNote = "scaled to 24h from a ~" + Math.round(windowSec / 60) + "-min sample (" + (logs ? logs.length : 0) + " swaps, assumed " + cfg.blockSec + "s blocks)";
      }
    } catch (e) { volNote = "volume sampling failed: " + String(e && e.message ? e.message : e).slice(0, 120); }
  }
  const fees24hUsd = vol24hUsd != null ? vol24hUsd * (p.fee / 1e6) : null;
  const aprEst = fees24hUsd != null && tvlUsd ? (fees24hUsd / tvlUsd) * 365 * 100 : null;

  pools.push({
    fee: p.fee, address: p.addr, tickSpacing: TICK_SPACING[p.fee],
    token0: { address: t0, symbol: m0.symbol, decimals: m0.decimals },
    token1: { address: t1, symbol: m1.symbol, decimals: m1.decimals },
    tick, liquidity: String(liq),
    price0In1, price1In0: price0In1 > 0 ? 1 / price0In1 : null,
    tvlUsd, vol24hUsd, fees24hUsd, aprEst, volNote,
  });
}

return { chain: chainKey, pools };
