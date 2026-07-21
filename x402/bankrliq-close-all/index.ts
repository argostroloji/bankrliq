/**
 * bankrliq-close-all — x402 service handler ($1.00 USDC per call).
 * Closes MULTIPLE Uniswap V3 LP positions in ONE transaction: every position's
 * decreaseLiquidity + collect + burn packed into a single NPM.multicall, so the
 * user signs exactly once. Bun runtime, zero dependencies (raw JSON-RPC +
 * hand-rolled ABI). Nothing is signed server-side.
 *
 * POST JSON body: { chain: "base"|"robinhood", tokenIds: ["1","2",...] (max 25),
 *                   recipient (required), slippageBps? }
 * Returns { txBlobs: [{label, blob, raw}], closed: [...], skipped: [...] }.
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
const ZERO = "0x0000000000000000000000000000000000000000";
const SEL = {
  getPool: "0x1698ee82", slot0: "0x3850c7bd", positions: "0x99fbab88",
  decreaseLiquidity: "0x0c49ccbe", collect: "0xfc6f7865", burn: "0x42966c68", multicall: "0xac9650d8",
};

const strip = (h) => (typeof h === "string" && h.startsWith("0x") ? h.slice(2) : h || "");
const U256MASK = (BigInt(1) << BigInt(256)) - BigInt(1);
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const word = (v) => (BigInt(v) & U256MASK).toString(16).padStart(64, "0");
const padAddr = (a) => strip(a).toLowerCase().padStart(64, "0");
function words(hex) { const h = strip(hex); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64)); return out; }
const toBig = (w) => BigInt("0x" + (w || "0"));
const toInt = (w) => { let v = toBig(w); if (v >= BigInt(1) << BigInt(255)) v -= BigInt(1) << BigInt(256); return v; };
const toAddr = (w) => "0x" + (w || "").slice(24);
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

async function main(a) {
  const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
  const cfg = CHAINS[chainKey];
  if (!isAddr(a.recipient)) throw new Error("recipient is required (your wallet address)");
  const slipN = Number(a.slippageBps);
  const slippageBps = Number.isFinite(slipN) ? Math.min(Math.max(slipN, 0), 5000) : 100;
  const ids = (Array.isArray(a.tokenIds) ? a.tokenIds : []).slice(0, 25).map((v) => {
    const id = BigInt(v);
    if (id < BigInt(0)) throw new Error("invalid tokenId: " + v);
    return id;
  });
  if (!ids.length) throw new Error("tokenIds is required (array of LP NFT ids)");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const calls = [];
  const closed = [];
  const skipped = [];
  const slot0Cache = {};

  for (const tokenId of ids) {
    try {
      const pr = await ethCall(cfg, cfg.npm, SEL.positions + word(tokenId));
      const ws = words(pr);
      if (ws.length < 12) throw new Error("position not found");
      const token0 = toAddr(ws[2]), token1 = toAddr(ws[3]);
      const fee = Number(toBig(ws[4]));
      const tickLower = Number(toInt(ws[5])), tickUpper = Number(toInt(ws[6]));
      const liq = toBig(ws[7]);
      const owed0 = toBig(ws[10]), owed1 = toBig(ws[11]);
      if (liq === BigInt(0) && owed0 === BigInt(0) && owed1 === BigInt(0)) {
        // already empty — just burn it
        calls.push(SEL.burn + word(tokenId));
        closed.push({ tokenId: tokenId.toString(), steps: ["burn"] });
        continue;
      }
      const steps = [];
      if (liq > BigInt(0)) {
        let a0Min = BigInt(0), a1Min = BigInt(0);
        try {
          const poolKey = token0 + token1 + fee;
          if (!slot0Cache[poolKey]) {
            const pAddr = toAddr(words(await ethCall(cfg, cfg.factory, SEL.getPool + padAddr(token0) + padAddr(token1) + word(fee)))[0]);
            slot0Cache[poolKey] = pAddr !== ZERO ? toBig(words(await ethCall(cfg, pAddr, SEL.slot0))[0]) : null;
          }
          if (slot0Cache[poolKey]) {
            const [x0, x1] = amountsForLiquidity(slot0Cache[poolKey], getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), liq);
            const bps = BigInt(10000 - slippageBps);
            a0Min = (x0 * bps) / BigInt(10000);
            a1Min = (x1 * bps) / BigInt(10000);
          }
        } catch (e) { /* keep zero mins */ }
        calls.push(SEL.decreaseLiquidity + word(tokenId) + word(liq) + word(a0Min) + word(a1Min) + word(deadline));
        steps.push("decrease");
      }
      calls.push(SEL.collect + word(tokenId) + padAddr(a.recipient) + word(MAX_UINT128) + word(MAX_UINT128));
      steps.push("collect");
      calls.push(SEL.burn + word(tokenId));
      steps.push("burn");
      closed.push({ tokenId: tokenId.toString(), steps });
    } catch (e) {
      skipped.push({ tokenId: tokenId.toString(), reason: String(e && e.message ? e.message : e).slice(0, 120) });
    }
  }
  if (!calls.length) throw new Error("nothing to close (all token ids were skipped)");

  const data = encMulticall(calls);
  const label = "Close ALL " + closed.length + " position(s)";
  return {
    chain: chainKey, recipient: a.recipient,
    closed, skipped,
    txBlobs: [{
      label,
      blob: { chain: chainKey, to: cfg.npm, data, value: "0x0", label },
      raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" },
    }],
    note: "ONE signature closes " + closed.length + " position(s): decrease + collect + burn per NFT, packed into a single multicall.",
  };
}

export default async function handler(req) {
  try {
    let body = {};
    if (req.method === "GET") body = Object.fromEntries(new URL(req.url).searchParams);
    else body = await req.json().catch(() => ({}));
    const result = await main(body || {});
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
}
