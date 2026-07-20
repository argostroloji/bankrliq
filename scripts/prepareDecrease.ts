// BANKRLIQ — prepareDecrease
// args: { chain, tokenId, percent? (1-100, default 100) | liquidity?, slippageBps? }
// Reads the position + pool price, computes slippage-protected minimums with
// pure-JS sqrt math, returns { txBlobs: [{label, blob}] }.

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" },
};
const NPM_ABI = [
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" },
    ] },
  { type: "function", name: "decreaseLiquidity", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
];
const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
    outputs: [{ type: "address" }] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
];

const U256 = (BigInt(1) << BigInt(256)) - BigInt(1);
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
const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const ZERO = "0x0000000000000000000000000000000000000000";

// OWNER-ONLY free path (everyone else: paid liq-action endpoint, $0.50)
const OWNER = "0xa2baa5527e25de10099096a3257d0b1938f095b1";
const callerAddr = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr || callerAddr.toLowerCase() !== OWNER) {
  return { error: "owner-only script — use the paid liq-action endpoint ($0.50)" };
}

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
let tokenId;
try { tokenId = BigInt(a.tokenId); if (tokenId < BigInt(0)) throw new Error(); } catch (e) { return { error: "invalid tokenId" }; }
const slippageBps = Math.min(Math.max(Number(a.slippageBps) || 100, 0), 5000);

const p = norm(await bankr.chain.readContract({
  chain: chainKey, address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId],
}));
if (!p) return { error: "position not found" };
const totalLiq = BigInt(p[7]);
const tickLower = Number(p[5]), tickUpper = Number(p[6]);

let liqToRemove;
if (a.liquidity != null) liqToRemove = BigInt(a.liquidity);
else {
  const percent = Math.min(Math.max(Number(a.percent) || 100, 1), 100);
  liqToRemove = (totalLiq * BigInt(Math.round(percent * 100))) / BigInt(10000);
}
if (liqToRemove <= BigInt(0)) return { error: "nothing to remove (liquidity is 0)" };
if (liqToRemove > totalLiq) liqToRemove = totalLiq;

// slippage-protected minimums from the current price
let amount0Min = BigInt(0), amount1Min = BigInt(0);
const poolAddr = norm(await bankr.chain.readContract({
  chain: chainKey, address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [p[2], p[3], Number(p[4])],
}));
if (poolAddr && poolAddr !== ZERO) {
  const slot0 = norm(await bankr.chain.readContract({ chain: chainKey, address: poolAddr, abi: POOL_ABI, functionName: "slot0", args: [] }));
  const [a0, a1] = amountsForLiquidity(BigInt(slot0[0]), getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), liqToRemove);
  const bps = BigInt(10000 - slippageBps);
  amount0Min = (a0 * bps) / BigInt(10000);
  amount1Min = (a1 * bps) / BigInt(10000);
}

const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
const data = bankr.chain.encodeFunctionData({
  abi: NPM_ABI, functionName: "decreaseLiquidity",
  args: [{ tokenId, liquidity: liqToRemove, amount0Min, amount1Min, deadline }],
});
const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Decrease liquidity #" + tokenId });

return {
  chain: chainKey, tokenId: tokenId.toString(),
  liquidityRemoved: liqToRemove.toString(),
  amount0Min: amount0Min.toString(), amount1Min: amount1Min.toString(),
  txBlobs: [{ label: "Decrease liquidity #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }],
};
