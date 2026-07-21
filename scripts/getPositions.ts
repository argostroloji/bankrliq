// BANKRLIQ — getPositions (authenticated viewer script, FREE)
// Lists the caller's Uniswap V3 LP NFTs with amounts, range status and
// uncollected fees (full feeGrowthInside math, pure JS — no libraries).
// Addresses are chain-verified 2026-07-20 (spec addresses had no code).

const CHAINS = {
  base: {
    npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  },
  robinhood: {
    npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  },
};

const NPM_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "i", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" },
    ] },
];
const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
    outputs: [{ type: "address" }] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "feeGrowthGlobal0X128", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeGrowthGlobal1X128", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ticks", stateMutability: "view", inputs: [{ name: "t", type: "int24" }],
    outputs: [
      { type: "uint128" }, { type: "int128" }, { type: "uint256" }, { type: "uint256" },
      { type: "int56" }, { type: "uint160" }, { type: "uint32" }, { type: "bool" },
    ] },
];
const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

/* ---- pure-JS Uniswap V3 math ---- */
const U256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const Q96n = BigInt(1) << BigInt(96);
const Q128n = BigInt(1) << BigInt(128);
const subU256 = (a, b) => (a - b) & U256;

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
  if (tick > 0) ratio = U256 / ratio;
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

function feesOwedSide(fgGlobal, lowerOutside, upperOutside, fgInsideLast, L, tickCur, tickLo, tickHi) {
  const below = tickCur >= tickLo ? lowerOutside : subU256(fgGlobal, lowerOutside);
  const above = tickCur < tickHi ? upperOutside : subU256(fgGlobal, upperOutside);
  const inside = subU256(subU256(fgGlobal, below), above);
  return (L * subU256(inside, fgInsideLast)) / Q128n;
}

function fmtUnits(v, dec) {
  v = BigInt(v);
  const s = v.toString().padStart(dec + 1, "0");
  const i = s.slice(0, s.length - dec) || "0";
  const f = s.slice(s.length - dec).replace(/0+$/, "");
  return i + (f ? "." + f : "");
}

const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const ZERO = "0x0000000000000000000000000000000000000000";

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

/* ---- main ---- */
const chainKey = args && args.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const owner = (args && args.owner) || (ctx && ctx.caller && ctx.caller.walletAddress);
if (!owner) return { error: "not signed in", positions: [] };

const total = Number(await bankr.chain.readContract({
  chain: chainKey, address: cfg.npm, abi: NPM_ABI, functionName: "balanceOf", args: [owner],
}));
const count = Math.min(total, 25);
if (count === 0) return { chain: chainKey, owner, total, positions: [] };

// newest indexes first — recent positions are the live ones
const idRes = await mcall(chainKey, Array.from({ length: count }, (_, i) => ({
  address: cfg.npm, abi: NPM_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, total - 1 - i],
})));
const ids = idRes.map(norm).filter((v) => v !== null && v !== undefined);

const posRes = await mcall(chainKey, ids.map((id) => ({ address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [id] })));

const livePos = [];
for (let i = 0; i < ids.length; i++) {
  const p = norm(posRes[i]);
  if (!p) continue;
  const liquidity = BigInt(p[7]);
  const owed0 = BigInt(p[10]);
  const owed1 = BigInt(p[11]);
  if (liquidity === BigInt(0) && owed0 === BigInt(0) && owed1 === BigInt(0)) continue;
  livePos.push({
    tokenId: ids[i].toString(),
    token0: p[2], token1: p[3], fee: Number(p[4]),
    tickLower: Number(p[5]), tickUpper: Number(p[6]),
    liquidity, fgIn0Last: BigInt(p[8]), fgIn1Last: BigInt(p[9]), owed0, owed1,
  });
}
if (livePos.length === 0) return { chain: chainKey, owner, total, positions: [] };

// pool addresses + token metadata
const tokens = [...new Set(livePos.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()]))];
const lookupRes = await mcall(chainKey, [
    ...livePos.map((p) => ({ address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [p.token0, p.token1, p.fee] })),
    ...tokens.flatMap((t) => [
      { address: t, abi: ERC20_ABI, functionName: "symbol", args: [] },
      { address: t, abi: ERC20_ABI, functionName: "decimals", args: [] },
    ]),
]);
const meta = {};
tokens.forEach((t, i) => {
  meta[t] = {
    symbol: norm(lookupRes[livePos.length + i * 2]) || "???",
    decimals: Number(norm(lookupRes[livePos.length + i * 2 + 1]) ?? 18),
  };
});

// per-position pool state
const poolCalls = [];
for (let i = 0; i < livePos.length; i++) {
  const pool = norm(lookupRes[i]);
  livePos[i].pool = pool && pool !== ZERO ? pool : null;
  if (!livePos[i].pool) continue;
  poolCalls.push(
    { address: livePos[i].pool, abi: POOL_ABI, functionName: "slot0", args: [] },
    { address: livePos[i].pool, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128", args: [] },
    { address: livePos[i].pool, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128", args: [] },
    { address: livePos[i].pool, abi: POOL_ABI, functionName: "ticks", args: [livePos[i].tickLower] },
    { address: livePos[i].pool, abi: POOL_ABI, functionName: "ticks", args: [livePos[i].tickUpper] },
  );
}
const poolRes = await mcall(chainKey, poolCalls);

const positions = [];
let cursor = 0;
for (const p of livePos) {
  const m0 = meta[p.token0.toLowerCase()];
  const m1 = meta[p.token1.toLowerCase()];
  const out = {
    tokenId: p.tokenId,
    token0: { address: p.token0, symbol: m0.symbol, decimals: m0.decimals },
    token1: { address: p.token1, symbol: m1.symbol, decimals: m1.decimals },
    fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper,
    liquidity: p.liquidity.toString(),
    priceLower: Math.pow(1.0001, p.tickLower) * Math.pow(10, m0.decimals - m1.decimals),
    priceUpper: Math.pow(1.0001, p.tickUpper) * Math.pow(10, m0.decimals - m1.decimals),
    pool: p.pool, inRange: null, currentTick: null, currentPrice: null,
    amount0: "0", amount1: "0",
    feesOwed0: fmtUnits(p.owed0, m0.decimals),
    feesOwed1: fmtUnits(p.owed1, m1.decimals),
  };
  if (p.pool) {
    const slot0 = norm(poolRes[cursor]);
    const fg0 = BigInt(norm(poolRes[cursor + 1]) || 0);
    const fg1 = BigInt(norm(poolRes[cursor + 2]) || 0);
    const lo = norm(poolRes[cursor + 3]);
    const hi = norm(poolRes[cursor + 4]);
    cursor += 5;
    if (slot0) {
      const sqrtP = BigInt(slot0[0]);
      const tick = Number(slot0[1]);
      out.currentTick = tick;
      out.inRange = tick >= p.tickLower && tick < p.tickUpper;
      const sp = Number(sqrtP) / Number(Q96n);
      out.currentPrice = sp * sp * Math.pow(10, m0.decimals - m1.decimals);
      const [a0, a1] = amountsForLiquidity(sqrtP, getSqrtRatioAtTick(p.tickLower), getSqrtRatioAtTick(p.tickUpper), p.liquidity);
      out.amount0 = fmtUnits(a0, m0.decimals);
      out.amount1 = fmtUnits(a1, m1.decimals);
      if (lo && hi) {
        const f0 = p.owed0 + feesOwedSide(fg0, BigInt(lo[2]), BigInt(hi[2]), p.fgIn0Last, p.liquidity, tick, p.tickLower, p.tickUpper);
        const f1 = p.owed1 + feesOwedSide(fg1, BigInt(lo[3]), BigInt(hi[3]), p.fgIn1Last, p.liquidity, tick, p.tickLower, p.tickUpper);
        out.feesOwed0 = fmtUnits(f0, m0.decimals);
        out.feesOwed1 = fmtUnits(f1, m1.decimals);
      }
    }
  }
  positions.push(out);
}

return { chain: chainKey, owner, total, positions };
