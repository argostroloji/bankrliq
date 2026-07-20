// BANKRLIQ — prepareMint
// args: { chain, token0, token1, fee, amount0, amount1 (decimal strings),
//         rangeMode: "auto10"|"auto20"|"full"|"manual", tickLower?, tickUpper?,
//         slippageBps?, recipient? }
// Returns { txBlobs: [{label, blob}], ...preview }. The iframe passes each blob
// to bankr.confirmTransaction — the app never touches a private key.

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" },
};
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const MIN_TICK = -887272, MAX_TICK = 887272;

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "f", type: "uint24" }],
    outputs: [{ type: "address" }] },
];
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const NPM_ABI = [
  { type: "function", name: "mint", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }] },
];

const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const ZERO = "0x0000000000000000000000000000000000000000";

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

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const fee = Number(a.fee);
const spacing = TICK_SPACING[fee];
if (!spacing) return { error: "unsupported fee tier" };
if (!a.token0 || !a.token1) return { error: "token0 and token1 are required" };
const recipient = a.recipient || (ctx && ctx.caller && ctx.caller.walletAddress);
if (!recipient) return { error: "no recipient (sign in first)" };
const slippageBps = Math.min(Math.max(Number(a.slippageBps) || 100, 0), 5000);

const poolAddr = norm(await bankr.chain.readContract({
  chain: chainKey, address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [a.token0, a.token1, fee],
}));
if (!poolAddr || poolAddr === ZERO) return { error: "pool does not exist for this pair/fee" };

const info = await bankr.chain.multicall({
  chain: chainKey,
  calls: [
    { address: poolAddr, abi: POOL_ABI, functionName: "slot0", args: [] },
    { address: poolAddr, abi: POOL_ABI, functionName: "token0", args: [] },
    { address: a.token0, abi: ERC20_ABI, functionName: "decimals", args: [] },
    { address: a.token1, abi: ERC20_ABI, functionName: "decimals", args: [] },
    { address: a.token0, abi: ERC20_ABI, functionName: "symbol", args: [] },
    { address: a.token1, abi: ERC20_ABI, functionName: "symbol", args: [] },
  ],
});
const slot0 = norm(info[0]);
const poolT0 = String(norm(info[1])).toLowerCase();
const decA = Number(norm(info[2]) ?? 18);
const decB = Number(norm(info[3]) ?? 18);
const symA = norm(info[4]) || "T0";
const symB = norm(info[5]) || "T1";
const tick = Number(slot0[1]);

// canonical pool ordering
const aIs0 = poolT0 === String(a.token0).toLowerCase();
const token0 = aIs0 ? a.token0 : a.token1;
const token1 = aIs0 ? a.token1 : a.token0;
const dec0 = aIs0 ? decA : decB;
const dec1 = aIs0 ? decB : decA;
const sym0 = aIs0 ? symA : symB;
const sym1 = aIs0 ? symB : symA;
const amount0Desired = parseUnits(aIs0 ? a.amount0 : a.amount1, dec0);
const amount1Desired = parseUnits(aIs0 ? a.amount1 : a.amount0, dec1);
if (amount0Desired === BigInt(0) && amount1Desired === BigInt(0)) return { error: "both amounts are zero" };

let tickLower, tickUpper;
const mode = a.rangeMode || "manual";
if (mode === "auto10" || mode === "auto20") {
  const pct = mode === "auto10" ? 0.10 : 0.20;
  const d = Math.round(Math.log(1 + pct) / Math.log(1.0001));
  tickLower = alignTick(tick - d, spacing, false);
  tickUpper = alignTick(tick + d, spacing, true);
} else if (mode === "full") {
  tickLower = Math.ceil(MIN_TICK / spacing) * spacing;
  tickUpper = Math.floor(MAX_TICK / spacing) * spacing;
} else {
  tickLower = alignTick(Number(a.tickLower), spacing, false);
  tickUpper = alignTick(Number(a.tickUpper), spacing, true);
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) return { error: "manual mode requires tickLower and tickUpper" };
}
if (tickLower >= tickUpper) return { error: "tickLower must be < tickUpper" };

const bps = BigInt(10000 - slippageBps);
const amount0Min = (amount0Desired * bps) / BigInt(10000);
const amount1Min = (amount1Desired * bps) / BigInt(10000);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

const txBlobs = [];
if (amount0Desired > BigInt(0)) {
  const data = bankr.chain.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount0Desired] });
  txBlobs.push({ label: "Approve " + sym0, blob: await bankr.tx.prepare({ chain: chainKey, to: token0, data, label: "Approve " + sym0 }) });
}
if (amount1Desired > BigInt(0)) {
  const data = bankr.chain.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount1Desired] });
  txBlobs.push({ label: "Approve " + sym1, blob: await bankr.tx.prepare({ chain: chainKey, to: token1, data, label: "Approve " + sym1 }) });
}
const mintData = bankr.chain.encodeFunctionData({
  abi: NPM_ABI, functionName: "mint",
  args: [{ token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline }],
});
txBlobs.push({
  label: "Mint " + sym0 + "/" + sym1 + " LP",
  blob: await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data: mintData, label: "Mint LP position" }),
});

const sp = Number(BigInt(slot0[0])) / Math.pow(2, 96);
return {
  chain: chainKey, pool: poolAddr, fee, tickLower, tickUpper,
  currentTick: tick,
  currentPrice: sp * sp * Math.pow(10, dec0 - dec1),
  priceLower: Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1),
  priceUpper: Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1),
  token0: { address: token0, symbol: sym0, decimals: dec0 },
  token1: { address: token1, symbol: sym1, decimals: dec1 },
  amount0Desired: amount0Desired.toString(),
  amount1Desired: amount1Desired.toString(),
  txBlobs,
  note: "Sign in order: approvals first, then mint.",
};
