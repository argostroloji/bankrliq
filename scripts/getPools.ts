// BANKRLIQ — getPools (PUBLIC script, tight budget: ≤10 chain reads, ≤5s, ≤8KB return)
// Snapshots the WETH/stable pools across all 4 fee tiers using exactly 2 multicalls.
// 24h volume is estimated from the feeGrowthGlobal delta between snapshots — no
// log scanning needed, so the read budget stays tiny.
// Contract addresses are CHAIN-VERIFIED (2026-07-20): the commonly cited Base
// addresses (0x...21f19fFD factory / 0x03a520b32B04... NPM) have NO code on-chain.

const CHAINS = {
  base: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    stableSym: "USDC",
    wethDec: 18,
    stableDec: 6,
  },
  robinhood: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    stableSym: "USDG",
    wethDec: 18,
    stableDec: 6,
  },
};

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
    outputs: [{ type: "address" }] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "feeGrowthGlobal0X128", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
];

const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;
const Q128 = BigInt(2) ** BigInt(128);

const chainKey = args && args.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const FEES = [100, 500, 3000, 10000];

// multicall #1: locate the 4 pools
const poolRes = await bankr.chain.multicall({
  chain: chainKey,
  calls: FEES.map((fee) => ({ address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [cfg.weth, cfg.stable, fee] })),
});
const live = [];
poolRes.forEach((r, i) => {
  const addr = norm(r);
  if (addr && addr !== ZERO) live.push({ fee: FEES[i], addr });
});

const kvKey = "pools_snapshot_" + chainKey;
const metaKey = kvKey + "_meta";
const now = Date.now();

if (live.length === 0) {
  const empty = { pools: [], updatedAt: now };
  await appKV.set(kvKey, empty);
  return empty;
}

// multicall #2: slot0 + liquidity + feeGrowthGlobal0 + both token balances, per pool
const calls = [];
for (const p of live) {
  calls.push({ address: p.addr, abi: POOL_ABI, functionName: "slot0", args: [] });
  calls.push({ address: p.addr, abi: POOL_ABI, functionName: "liquidity", args: [] });
  calls.push({ address: p.addr, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128", args: [] });
  calls.push({ address: cfg.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [p.addr] });
  calls.push({ address: cfg.stable, abi: ERC20_ABI, functionName: "balanceOf", args: [p.addr] });
}
const res = await bankr.chain.multicall({ chain: chainKey, calls });

let prevMeta = null;
try { prevMeta = await appKV.get(metaKey); } catch (e) { prevMeta = null; }

const pools = [];
const newMeta = { t: now, perFee: {} };
for (let i = 0; i < live.length; i++) {
  const p = live[i];
  const slot0 = norm(res[i * 5]);
  const liq = BigInt(norm(res[i * 5 + 1]) || 0);
  const fg0 = BigInt(norm(res[i * 5 + 2]) || 0);
  const wethBal = BigInt(norm(res[i * 5 + 3]) || 0);
  const stableBal = BigInt(norm(res[i * 5 + 4]) || 0);
  if (!slot0) continue;

  // WETH is token0 on both chains (verified: lower address than the stable)
  const sqrtP = Number(BigInt(slot0[0])) / Q96;
  const price = sqrtP * sqrtP * Math.pow(10, cfg.wethDec - cfg.stableDec); // stable per WETH
  const tvl =
    Number(stableBal) / Math.pow(10, cfg.stableDec) +
    (Number(wethBal) / Math.pow(10, cfg.wethDec)) * price;

  // volume estimate: feeGrowthGlobal0 delta since last snapshot
  let volume24h = 0;
  const prev = prevMeta && prevMeta.perFee && prevMeta.perFee[p.fee];
  if (prev && prevMeta.t && now > prevMeta.t) {
    try {
      const dFg = fg0 - BigInt(prev.fg0);
      if (dFg > BigInt(0) && liq > BigInt(0)) {
        const feeTokens0 = Number((dFg * liq) / Q128) / Math.pow(10, cfg.wethDec); // WETH-side fees
        const feesUsd = feeTokens0 * price;
        const volUsd = feesUsd / (p.fee / 1e6);
        volume24h = volUsd * (86400000 / (now - prevMeta.t));
      }
    } catch (e) { volume24h = 0; }
  }
  const apr = tvl > 0 ? ((volume24h * (p.fee / 1e6)) / tvl) * 365 * 100 : 0;

  newMeta.perFee[p.fee] = { fg0: fg0.toString() };
  pools.push({
    pair: "WETH/" + cfg.stableSym,
    fee: p.fee,
    tvl: Math.round(tvl * 100) / 100,
    volume24h: Math.round(volume24h * 100) / 100,
    apr: Math.round(apr * 10) / 10,
    currentPrice: price.toFixed(price >= 100 ? 2 : 6),
  });
}

const snapshot = { pools, updatedAt: now };
await appKV.set(kvKey, snapshot);
await appKV.set(metaKey, newMeta);
return snapshot;
