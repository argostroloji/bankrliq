// BANKRLIQ — x402 paid endpoint: liq-action ($0.50 USDC per call)
// Deployed separately on x402.bankr.bot; the app iframe calls it with
// bankr.x402.fetch (POST). Prepares tx blobs — never touches a private key.
//
// args (POST body): { action: "mint"|"decrease"|"collect"|"burn"|"close", chain, ...params }
//   mint:     token0, token1, fee, amount0, amount1, rangeMode|tickLower/Upper, slippageBps?, recipient?
//   decrease: tokenId, percent? (default 100), slippageBps?
//   collect:  tokenId, recipient?
//   burn:     tokenId
//   close:    tokenId, percent? (default 100), burn? (default true at 100%),
//             recipient?, slippageBps?  → ONE NPM.multicall blob
//             (decreaseLiquidity + collect [+ burn]) = one signature.
// Returns { txBlobs: [{label, blob}], ...preview } or { error }.

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" },
};
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const MIN_TICK = -887272, MAX_TICK = 887272;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

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
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" },
    ] },
  { type: "function", name: "mint", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "amount0Desired", type: "uint256" }, { name: "amount1Desired", type: "uint256" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "decreaseLiquidity", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "liquidity", type: "uint128" },
      { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "collect", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "burn", stateMutability: "payable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
];

/* ---- pure-JS Uniswap V3 math ---- */
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
const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };

/* ---- main ---- */
const a = (args && args.body && typeof args.body === "object" ? args.body : args) || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const caller = (ctx && ctx.caller && ctx.caller.walletAddress) || null;
const action = a.action;

async function readPosition(tokenId) {
  const p = norm(await bankr.chain.readContract({
    chain: chainKey, address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId],
  }));
  if (!p) throw new Error("position not found");
  return p;
}
function parseTokenId(v) {
  const id = BigInt(v);
  if (id < BigInt(0)) throw new Error("invalid tokenId");
  return id;
}
async function decreaseMins(p, liqToRemove, slippageBps) {
  let amount0Min = BigInt(0), amount1Min = BigInt(0);
  const poolAddr = norm(await bankr.chain.readContract({
    chain: chainKey, address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [p[2], p[3], Number(p[4])],
  }));
  if (poolAddr && poolAddr !== ZERO && liqToRemove > BigInt(0)) {
    const slot0 = norm(await bankr.chain.readContract({ chain: chainKey, address: poolAddr, abi: POOL_ABI, functionName: "slot0", args: [] }));
    const [a0, a1] = amountsForLiquidity(BigInt(slot0[0]), getSqrtRatioAtTick(Number(p[5])), getSqrtRatioAtTick(Number(p[6])), liqToRemove);
    const bps = BigInt(10000 - slippageBps);
    amount0Min = (a0 * bps) / BigInt(10000);
    amount1Min = (a1 * bps) / BigInt(10000);
  }
  return [amount0Min, amount1Min];
}

let result;
try {
  if (action === "mint") {
    const fee = Number(a.fee);
    const spacing = TICK_SPACING[fee];
    if (!spacing) throw new Error("unsupported fee tier");
    if (!a.token0 || !a.token1) throw new Error("token0 and token1 are required");
    const recipient = a.recipient || caller;
    if (!recipient) throw new Error("no recipient");
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);

    const poolAddr = norm(await bankr.chain.readContract({
      chain: chainKey, address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [a.token0, a.token1, fee],
    }));
    if (!poolAddr || poolAddr === ZERO) throw new Error("pool does not exist for this pair/fee");

    const info = (await bankr.chain.multicall({
      chain: chainKey,
      calls: [
        { address: poolAddr, abi: POOL_ABI, functionName: "slot0", args: [] },
        { address: poolAddr, abi: POOL_ABI, functionName: "token0", args: [] },
        { address: a.token0, abi: ERC20_ABI, functionName: "decimals", args: [] },
        { address: a.token1, abi: ERC20_ABI, functionName: "decimals", args: [] },
        { address: a.token0, abi: ERC20_ABI, functionName: "symbol", args: [] },
        { address: a.token1, abi: ERC20_ABI, functionName: "symbol", args: [] },
      ],
    })).map(norm);
    const slot0 = info[0];
    const tick = Number(slot0[1]);
    const aIs0 = String(info[1]).toLowerCase() === String(a.token0).toLowerCase();
    const token0 = aIs0 ? a.token0 : a.token1, token1 = aIs0 ? a.token1 : a.token0;
    const dec0 = Number(aIs0 ? info[2] : info[3]) || 18, dec1 = Number(aIs0 ? info[3] : info[2]) || 18;
    const sym0 = (aIs0 ? info[4] : info[5]) || "T0", sym1 = (aIs0 ? info[5] : info[4]) || "T1";
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
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const txBlobs = [];
    if (amount0Desired > BigInt(0)) {
      const data = bankr.chain.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount0Desired] });
      txBlobs.push({ label: "Approve " + sym0, blob: await bankr.tx.prepare({ chain: chainKey, to: token0, data, label: "Approve " + sym0 }), raw: { chain: chainKey, to: token0, data, value: "0x0" } });
    }
    if (amount1Desired > BigInt(0)) {
      const data = bankr.chain.encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount1Desired] });
      txBlobs.push({ label: "Approve " + sym1, blob: await bankr.tx.prepare({ chain: chainKey, to: token1, data, label: "Approve " + sym1 }), raw: { chain: chainKey, to: token1, data, value: "0x0" } });
    }
    const mintData = bankr.chain.encodeFunctionData({
      abi: NPM_ABI, functionName: "mint",
      args: [{
        token0, token1, fee, tickLower, tickUpper,
        amount0Desired, amount1Desired,
        amount0Min: (amount0Desired * bps) / BigInt(10000),
        amount1Min: (amount1Desired * bps) / BigInt(10000),
        recipient, deadline,
      }],
    });
    txBlobs.push({ label: "Mint " + sym0 + "/" + sym1 + " LP", blob: await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data: mintData, label: "Mint LP position" }), raw: { chain: chainKey, to: cfg.npm, data: mintData, value: "0x0" } });

    const sp = Number(BigInt(slot0[0])) / Math.pow(2, 96);
    result = {
      action, chain: chainKey, pool: poolAddr, fee, tickLower, tickUpper, currentTick: tick,
      currentPrice: sp * sp * Math.pow(10, dec0 - dec1),
      priceLower: Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - dec1),
      priceUpper: Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - dec1),
      token0: { address: token0, symbol: sym0 }, token1: { address: token1, symbol: sym1 },
      txBlobs, note: "Sign in order: approvals first, then mint.",
    };

  } else if (action === "decrease") {
    const tokenId = parseTokenId(a.tokenId);
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);
    const percent = clamp(a.percent, 1, 100, 100);
    const p = await readPosition(tokenId);
    let liq = (BigInt(p[7]) * BigInt(Math.round(percent * 100))) / BigInt(10000);
    if (liq <= BigInt(0)) throw new Error("nothing to remove");
    const [amount0Min, amount1Min] = await decreaseMins(p, liq, slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const data = bankr.chain.encodeFunctionData({
      abi: NPM_ABI, functionName: "decreaseLiquidity",
      args: [{ tokenId, liquidity: liq, amount0Min, amount1Min, deadline }],
    });
    const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Decrease #" + tokenId + " (" + percent + "%)" });
    result = { action, chain: chainKey, tokenId: tokenId.toString(), percent, liquidityRemoved: liq.toString(), txBlobs: [{ label: "Decrease liquidity #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };

  } else if (action === "collect") {
    const tokenId = parseTokenId(a.tokenId);
    const recipient = a.recipient || caller;
    if (!recipient) throw new Error("no recipient");
    const data = bankr.chain.encodeFunctionData({
      abi: NPM_ABI, functionName: "collect",
      args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    });
    const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Collect fees #" + tokenId });
    result = { action, chain: chainKey, tokenId: tokenId.toString(), recipient, txBlobs: [{ label: "Collect fees #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };

  } else if (action === "burn") {
    const tokenId = parseTokenId(a.tokenId);
    const data = bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] });
    const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Burn NFT #" + tokenId });
    result = { action, chain: chainKey, tokenId: tokenId.toString(), txBlobs: [{ label: "Burn NFT #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };

  } else if (action === "close") {
    // ONE signature: NPM.multicall(decreaseLiquidity + collect [+ burn])
    const tokenId = parseTokenId(a.tokenId);
    const slippageBps = clamp(a.slippageBps, 0, 5000, 100);
    const percent = clamp(a.percent, 1, 100, 100);
    const recipient = a.recipient || caller;
    if (!recipient) throw new Error("no recipient");
    const p = await readPosition(tokenId);
    const totalLiq = BigInt(p[7]);
    const liq = (totalLiq * BigInt(Math.round(percent * 100))) / BigInt(10000);
    const doBurn = a.burn !== false && percent === 100;

    const calls = [];
    const steps = [];
    if (liq > BigInt(0)) {
      const [amount0Min, amount1Min] = await decreaseMins(p, liq, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
      calls.push(bankr.chain.encodeFunctionData({
        abi: NPM_ABI, functionName: "decreaseLiquidity",
        args: [{ tokenId, liquidity: liq, amount0Min, amount1Min, deadline }],
      }));
      steps.push("decreaseLiquidity");
    }
    calls.push(bankr.chain.encodeFunctionData({
      abi: NPM_ABI, functionName: "collect",
      args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    }));
    steps.push("collect");
    if (doBurn) {
      calls.push(bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] }));
      steps.push("burn");
    }
    const data = bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "multicall", args: [[...calls]] });
    const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Close position #" + tokenId + " (" + percent + "%)" });
    result = {
      action, chain: chainKey, tokenId: tokenId.toString(), percent, burn: doBurn, steps,
      liquidityRemoved: liq.toString(),
      txBlobs: [{ label: "Close #" + tokenId + " (" + percent + "%)", blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }],
      note: "Single signature: " + steps.join(" + ") + ".",
    };

  } else {
    result = { error: "action must be mint | decrease | collect | burn | close" };
  }
} catch (e) {
  result = { error: String(e && e.message ? e.message : e) };
}

return result;
