// BANKRLIQ — prepareCloseAll (OWNER-ONLY free twin of the paid close-all
// endpoint, $1.00 for everyone else). Closes multiple positions in ONE
// signature: each NFT's decreaseLiquidity + collect + burn packed into a
// single NPM.multicall.
// args: { chain, tokenIds: ["1","2",...] (max 25), recipient?, slippageBps? }

const OWNER = "0xa2baa5527e25de10099096a3257d0b1938f095b1";
const callerAddr = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr || callerAddr.toLowerCase() !== OWNER) {
  return { error: "owner-only script — use the paid close-all endpoint ($1.00)" };
}

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" },
};
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
];
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

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
const recipient = a.recipient || callerAddr;
const slipN = Number(a.slippageBps);
const slippageBps = Number.isFinite(slipN) ? Math.min(Math.max(slipN, 0), 5000) : 100;
let ids;
try {
  ids = (Array.isArray(a.tokenIds) ? a.tokenIds : []).slice(0, 25).map((v) => {
    const id = BigInt(v);
    if (id < BigInt(0)) throw new Error();
    return id;
  });
} catch (e) { return { error: "invalid tokenIds" }; }
if (!ids.length) return { error: "tokenIds is required (array of LP NFT ids)" };

const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
const calls = [];
const closed = [];
const skipped = [];
const slot0Cache = {};

for (const tokenId of ids) {
  try {
    const p = norm(await bankr.chain.readContract({
      chain: chainKey, address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId],
    }));
    if (!p) throw new Error("position not found");
    const token0 = p[2], token1 = p[3], fee = Number(p[4]);
    const tickLower = Number(p[5]), tickUpper = Number(p[6]);
    const liq = BigInt(p[7]);
    const owed0 = BigInt(p[10]), owed1 = BigInt(p[11]);
    if (liq === BigInt(0) && owed0 === BigInt(0) && owed1 === BigInt(0)) {
      calls.push(bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] }));
      closed.push({ tokenId: tokenId.toString(), steps: ["burn"] });
      continue;
    }
    const steps = [];
    if (liq > BigInt(0)) {
      let a0Min = BigInt(0), a1Min = BigInt(0);
      try {
        const poolKey = token0 + token1 + fee;
        if (slot0Cache[poolKey] === undefined) {
          const pAddr = norm(await bankr.chain.readContract({
            chain: chainKey, address: cfg.factory, abi: FACTORY_ABI, functionName: "getPool", args: [token0, token1, fee],
          }));
          if (pAddr && pAddr !== ZERO) {
            const s0 = norm(await bankr.chain.readContract({ chain: chainKey, address: pAddr, abi: POOL_ABI, functionName: "slot0", args: [] }));
            slot0Cache[poolKey] = BigInt(s0[0]);
          } else slot0Cache[poolKey] = null;
        }
        if (slot0Cache[poolKey]) {
          const [x0, x1] = amountsForLiquidity(slot0Cache[poolKey], getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), liq);
          const bps = BigInt(10000 - slippageBps);
          a0Min = (x0 * bps) / BigInt(10000);
          a1Min = (x1 * bps) / BigInt(10000);
        }
      } catch (e) { /* keep zero mins */ }
      calls.push(bankr.chain.encodeFunctionData({
        abi: NPM_ABI, functionName: "decreaseLiquidity",
        args: [{ tokenId, liquidity: liq, amount0Min: a0Min, amount1Min: a1Min, deadline }],
      }));
      steps.push("decrease");
    }
    calls.push(bankr.chain.encodeFunctionData({
      abi: NPM_ABI, functionName: "collect",
      args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    }));
    steps.push("collect");
    calls.push(bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] }));
    steps.push("burn");
    closed.push({ tokenId: tokenId.toString(), steps });
  } catch (e) {
    skipped.push({ tokenId: tokenId.toString(), reason: String(e && e.message ? e.message : e).slice(0, 120) });
  }
}
if (!calls.length) return { error: "nothing to close (all token ids were skipped)" };

const data = bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "multicall", args: [[...calls]] });
const label = "Close ALL " + closed.length + " position(s)";
const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label });

return {
  chain: chainKey, recipient, closed, skipped,
  txBlobs: [{ label, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }],
  note: "ONE signature closes " + closed.length + " position(s).",
};
