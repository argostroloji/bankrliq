/**
 * BANKRLIQ — Uniswap V3 LP management backend for Bankr Apps.
 *
 * - Read-only on-chain access + calldata preparation. NO private keys, NO signing.
 * - Every /api endpoint is x402-priced (see X402_PRICES). Bankr's platform layer
 *   collects payment; this server enforces the x402 handshake itself as well.
 *
 * Env:
 *   PORT                  (default 3402)
 *   BASE_RPC_URL          (default https://mainnet.base.org)
 *   ROBINHOOD_RPC_URL     (default https://rpc.chain.robinhood.com)
 *   ROBINHOOD_NPM         override NonfungiblePositionManager on Robinhood Chain
 *   ROBINHOOD_FACTORY     override Uniswap V3 Factory on Robinhood Chain
 *   X402_MODE             platform | facilitator | off   (default platform)
 *   X402_PAY_TO           USDC receiver (default: Bankr revenue wallet)
 *   X402_FACILITATOR_URL  facilitator base URL for verify/settle (facilitator mode)
 *   VOLUME_WINDOW_BLOCKS  swap-log sampling window (default 2000)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http as viemHttp,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  getAddress,
  parseUnits,
  formatUnits,
} from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Chain + contract config                                             */
/* ------------------------------------------------------------------ */

const CHAINS = {
  base: {
    key: "base",
    id: 8453,
    name: "Base",
    // publicnode tolerates our burst patterns; mainnet.base.org rate-limits hard
    rpc: process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com",
    // publicnode gates eth_getLogs behind a token; the official RPC serves them
    logsRpc: process.env.BASE_LOGS_RPC_URL || "https://mainnet.base.org",
    // Verified on-chain 2026-07-20: pool.factory() of the live WETH/USDC pool
    // and the NPM emitting IncreaseLiquidity with factory() == this factory.
    // (The commonly cited 0x...21f19fFD / 0x03a520b32B04... have NO code here.)
    npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    stableSymbol: "USDC",
  },
  robinhood: {
    key: "robinhood",
    id: 4663,
    name: "Robinhood Chain",
    rpc: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    // Verified on-chain 2026-07-20: Robinhood Chain is an Arbitrum Orbit L2 —
    // no 0x4200 predeploys, no USDC; the dollar stable is USDG (6 decimals).
    // NPM discovered via IncreaseLiquidity logs; its WETH9() and factory()
    // getters are the source of the addresses below. Env-overridable.
    npm: process.env.ROBINHOOD_NPM || "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    factory: process.env.ROBINHOOD_FACTORY || "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
    stableSymbol: "USDG",
  },
};

const clients = {};
function makeClient(c, rpc) {
  return createPublicClient({
    chain: {
      id: c.id,
      name: c.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
    transport: viemHttp(rpc, { timeout: 20_000, retryCount: 4, retryDelay: 700 }),
  });
}
function client(chainKey) {
  if (!clients[chainKey]) clients[chainKey] = makeClient(CHAINS[chainKey], CHAINS[chainKey].rpc);
  return clients[chainKey];
}
const logsClients = {};
function logsClient(chainKey) {
  const c = CHAINS[chainKey];
  if (!c.logsRpc) return client(chainKey);
  if (!logsClients[chainKey]) logsClients[chainKey] = makeClient(c, c.logsRpc);
  return logsClients[chainKey];
}

/* Contract existence check. Successful verdicts are cached permanently;
   failures (e.g. a transient RPC hiccup) are only cached for 60s so the
   chain doesn't get stuck marked as broken. */
const codeCheckCache = {};
async function verifyChainContracts(chainKey) {
  const hit = codeCheckCache[chainKey];
  if (hit && (hit.v.ok || Date.now() - hit.t < 60_000)) return hit.v;
  const cfg = CHAINS[chainKey];
  const cl = client(chainKey);
  const out = { chain: chainKey, ok: true, contracts: {} };
  for (const [label, addr] of [["npm", cfg.npm], ["factory", cfg.factory]]) {
    try {
      const code = await cl.getCode({ address: addr });
      const has = !!code && code !== "0x";
      out.contracts[label] = { address: addr, deployed: has };
      if (!has) out.ok = false;
    } catch (e) {
      out.contracts[label] = { address: addr, deployed: null, error: String(e.message || e) };
      out.ok = false;
    }
  }
  codeCheckCache[chainKey] = { v: out, t: Date.now() };
  return out;
}

/* ------------------------------------------------------------------ */
/* ABIs                                                                */
/* ------------------------------------------------------------------ */

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const NPM_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);

/* ------------------------------------------------------------------ */
/* Uniswap V3 math (BigInt)                                            */
/* ------------------------------------------------------------------ */

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const U256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const FEE_TIERS = [100, 500, 3000, 10000];
const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > 887272n) throw new Error("tick out of range");
  let ratio =
    (absTick & 1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const steps = [
    [2n, 0xfff97272373d413259a46990580e213an],
    [4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [16n, 0xffcb9843d60f6159c9db58835c926644n],
    [32n, 0xff973b41fa98c081472e6896dfb254c0n],
    [64n, 0xff2ea16466c96a3843ec78b326b52861n],
    [128n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [256n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [512n, 0xf987a7253ac413176f2b074cf7815e54n],
    [1024n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [2048n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [4096n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [8192n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [16384n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [32768n, 0x31be135f97d08fd981231505542fcfa6n],
    [65536n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [131072n, 0x5d6af8dedb81196699c329225ee604n],
    [262144n, 0x2216e584f5fa1ea926041bedfe98n],
    [524288n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) {
    if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  }
  if (tick > 0) ratio = U256 / ratio;
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

/** token1-per-token0 price (human units) from sqrtPriceX96 */
function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const p = Number(sqrtPriceX96) / Number(Q96);
  return p * p * Math.pow(10, dec0 - dec1);
}

function priceToTick(price, dec0, dec1) {
  // price = token1 per token0 in human units
  const raw = price * Math.pow(10, dec1 - dec0);
  return Math.floor(Math.log(raw) / Math.log(1.0001));
}

function alignTick(tick, spacing, roundUp) {
  const t = roundUp ? Math.ceil(tick / spacing) : Math.floor(tick / spacing);
  return Math.min(Math.max(t * spacing, Math.ceil(MIN_TICK / spacing) * spacing), Math.floor(MAX_TICK / spacing) * spacing);
}

/** Amounts locked in a position of liquidity L for given price bounds */
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtP <= sqrtA) {
    amount0 = (L * Q96 * (sqrtB - sqrtA)) / sqrtB / sqrtA;
  } else if (sqrtP >= sqrtB) {
    amount1 = (L * (sqrtB - sqrtA)) / Q96;
  } else {
    amount0 = (L * Q96 * (sqrtB - sqrtP)) / sqrtB / sqrtP;
    amount1 = (L * (sqrtP - sqrtA)) / Q96;
  }
  return { amount0, amount1 };
}

const subU256 = (a, b) => (a - b) & U256;

/** Uncollected fees for one side (0 or 1) */
function feesOwedSide(feeGrowthGlobal, lowerOutside, upperOutside, feeGrowthInsideLast, liquidity, tickCurrent, tickLower, tickUpper) {
  const below = tickCurrent >= tickLower ? lowerOutside : subU256(feeGrowthGlobal, lowerOutside);
  const above = tickCurrent < tickUpper ? upperOutside : subU256(feeGrowthGlobal, upperOutside);
  const inside = subU256(subU256(feeGrowthGlobal, below), above);
  const delta = subU256(inside, feeGrowthInsideLast);
  return (liquidity * delta) / Q128;
}

/* ------------------------------------------------------------------ */
/* Token metadata + USD pricing helpers                                */
/* ------------------------------------------------------------------ */

const tokenMetaCache = new Map(); // `${chain}:${addr}` -> {symbol, decimals}
async function tokenMeta(chainKey, address) {
  const key = `${chainKey}:${address.toLowerCase()}`;
  if (tokenMetaCache.has(key)) return tokenMetaCache.get(key);
  const cl = client(chainKey);
  let symbol = "???";
  let decimals = 18;
  try {
    [symbol, decimals] = await Promise.all([
      cl.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
      cl.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
  } catch { /* non-standard token; keep fallbacks */ }
  const meta = { address: getAddress(address), symbol, decimals: Number(decimals) };
  tokenMetaCache.set(key, meta);
  return meta;
}

async function getPoolAddress(chainKey, tokenA, tokenB, fee) {
  const cfg = CHAINS[chainKey];
  const addr = await client(chainKey).readContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [tokenA, tokenB, fee],
  });
  return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
}

const priceCache = new Map(); // `${chain}:${addr}` -> {v, t}
async function tokenUsdPrice(chainKey, token) {
  const cfg = CHAINS[chainKey];
  const lower = token.toLowerCase();
  if (lower === cfg.usdc.toLowerCase()) return 1;
  const ck = `${chainKey}:${lower}`;
  const hit = priceCache.get(ck);
  if (hit && Date.now() - hit.t < 60_000) return hit.v;

  const cl = client(chainKey);
  async function priceVia(base, quote, quoteUsd) {
    for (const fee of [500, 3000, 10000, 100]) {
      const pool = await getPoolAddress(chainKey, base, quote, fee);
      if (!pool) continue;
      try {
        const [slot0, [mBase, mQuote]] = await Promise.all([
          cl.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
          Promise.all([tokenMeta(chainKey, base), tokenMeta(chainKey, quote)]),
        ]);
        const t0 = await cl.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" });
        const baseIs0 = t0.toLowerCase() === base.toLowerCase();
        const dec0 = baseIs0 ? mBase.decimals : mQuote.decimals;
        const dec1 = baseIs0 ? mQuote.decimals : mBase.decimals;
        const p01 = priceFromSqrt(slot0[0], dec0, dec1); // token1 per token0
        const baseInQuote = baseIs0 ? p01 : 1 / p01;
        if (baseInQuote > 0 && isFinite(baseInQuote)) return baseInQuote * quoteUsd;
      } catch { /* try next tier */ }
    }
    return null;
  }

  let usd = await priceVia(token, cfg.usdc, 1);
  if (usd == null && lower !== cfg.weth.toLowerCase()) {
    const wethUsd = await tokenUsdPrice(chainKey, cfg.weth);
    if (wethUsd) usd = await priceVia(token, cfg.weth, wethUsd);
  }
  if (usd != null) priceCache.set(ck, { v: usd, t: Date.now() });
  return usd;
}

/* ------------------------------------------------------------------ */
/* 24h volume estimate from recent Swap logs (extrapolated)            */
/* ------------------------------------------------------------------ */

const volCache = new Map(); // pool -> {v, t}
async function estimate24hVolumeUsd(chainKey, pool, meta0, meta1) {
  const hit = volCache.get(pool);
  if (hit && Date.now() - hit.t < 120_000) return hit.v;
  const cl = logsClient(chainKey);
  // Orbit chains (robinhood) produce blocks ~10x faster than Base — widen the
  // sample window so the 24h extrapolation isn't a 3-minute snapshot.
  const defaultWindow = chainKey === "robinhood" ? 9000 : 2000;
  const windowBlocks = BigInt(process.env.VOLUME_WINDOW_BLOCKS || defaultWindow);
  try {
    const latest = await cl.getBlockNumber();
    const fromBlock = latest > windowBlocks ? latest - windowBlocks : 0n;
    const CHUNK = 900n;
    const logs = [];
    for (let start = fromBlock; start <= latest; start += CHUNK + 1n) {
      const end = start + CHUNK > latest ? latest : start + CHUNK;
      const part = await cl.getLogs({ address: pool, event: SWAP_EVENT, fromBlock: start, toBlock: end });
      logs.push(...part);
    }
    const [bFrom, bTo] = await Promise.all([
      cl.getBlock({ blockNumber: fromBlock }),
      cl.getBlock({ blockNumber: latest }),
    ]);
    const windowSec = Number(bTo.timestamp - bFrom.timestamp) || 1;

    const cfg = CHAINS[chainKey];
    let sideIdx = null; // which side to price: prefer USDC, else token with known USD price
    let sideUsd = 1;
    if (meta0.address.toLowerCase() === cfg.usdc.toLowerCase()) { sideIdx = 0; sideUsd = 1; }
    else if (meta1.address.toLowerCase() === cfg.usdc.toLowerCase()) { sideIdx = 1; sideUsd = 1; }
    else {
      const p0 = await tokenUsdPrice(chainKey, meta0.address);
      if (p0) { sideIdx = 0; sideUsd = p0; }
      else {
        const p1 = await tokenUsdPrice(chainKey, meta1.address);
        if (p1) { sideIdx = 1; sideUsd = p1; }
      }
    }
    if (sideIdx == null) return { vol24hUsd: null, sampled: logs.length, windowSec };

    const dec = sideIdx === 0 ? meta0.decimals : meta1.decimals;
    let sum = 0;
    for (const lg of logs) {
      const amt = sideIdx === 0 ? lg.args.amount0 : lg.args.amount1;
      const abs = amt < 0n ? -amt : amt;
      sum += Number(formatUnits(abs, dec));
    }
    const vol24hUsd = sum * sideUsd * (86_400 / windowSec);
    const out = { vol24hUsd, sampled: logs.length, windowSec };
    volCache.set(pool, { v: out, t: Date.now() });
    return out;
  } catch (e) {
    return { vol24hUsd: null, error: String(e.message || e) };
  }
}

/* ------------------------------------------------------------------ */
/* x402 payment layer                                                  */
/* ------------------------------------------------------------------ */

const X402_MODE = process.env.X402_MODE || "platform";
const X402_PAY_TO = process.env.X402_PAY_TO || "0xa2baa5527e25de10099096a3257d0b1938f095b1";
const X402_FACILITATOR = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
const BASE_USDC = CHAINS.base.usdc;

// USDC atomic units (6 decimals).
// GET /api/positions is intentionally NOT priced — position tracking is free;
// unpriced routes pass enforceX402 untouched.
const X402_PRICES = {
  "GET /api/pools": { usd: "0.05", atomic: "50000" },
  "POST /api/position": { usd: "0.50", atomic: "500000" },
};

function x402Requirements(routeKey, resourceUrl) {
  const price = X402_PRICES[routeKey];
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: price.atomic,
    resource: resourceUrl,
    description: `BANKRLIQ ${routeKey} — $${price.usd} USDC`,
    mimeType: "application/json",
    payTo: X402_PAY_TO,
    maxTimeoutSeconds: 120,
    asset: BASE_USDC,
    extra: { name: "USD Coin", version: "2" },
  };
}

/**
 * Returns null when payment is satisfied, otherwise an object describing
 * the 402 response to send.
 */
async function enforceX402(req, routeKey, resourceUrl) {
  if (!X402_PRICES[routeKey]) return null; // unpriced route (e.g. /api/health)
  if (X402_MODE === "off") return null;

  const paymentHeader =
    req.headers["x-payment"] ||
    req.headers["x-402-payment"] ||
    req.headers["x-bankr-payment"];

  if (!paymentHeader) {
    return {
      status: 402,
      body: {
        x402Version: 1,
        error: "X-PAYMENT header is required",
        accepts: [x402Requirements(routeKey, resourceUrl)],
      },
    };
  }

  if (X402_MODE === "facilitator") {
    try {
      const res = await fetch(`${X402_FACILITATOR}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 1,
          paymentHeader,
          paymentRequirements: x402Requirements(routeKey, resourceUrl),
        }),
      });
      const verdict = await res.json();
      if (!verdict.isValid) {
        return {
          status: 402,
          body: {
            x402Version: 1,
            error: verdict.invalidReason || "payment verification failed",
            accepts: [x402Requirements(routeKey, resourceUrl)],
          },
        };
      }
    } catch (e) {
      return {
        status: 402,
        body: {
          x402Version: 1,
          error: `facilitator unreachable: ${String(e.message || e)}`,
          accepts: [x402Requirements(routeKey, resourceUrl)],
        },
      };
    }
  }
  // platform mode: Bankr's x402 gateway settles payment upstream and forwards
  // the proof header; presence of the header is our contract with the platform.
  return null;
}

/* ------------------------------------------------------------------ */
/* API handlers                                                        */
/* ------------------------------------------------------------------ */

function requireChain(q) {
  const chainKey = (q.get("chain") || "base").toLowerCase();
  if (!CHAINS[chainKey]) throw httpError(400, "chain must be 'base' or 'robinhood'");
  return chainKey;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Run mapper over items with at most `limit` in flight (public-RPC friendly). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const poolsRespCache = new Map(); // key -> {v, t}

/** NaN-safe numeric clamp with fallback. */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** parseUnits chokes on scientific notation ("1e-7") and garbage — normalize
    and turn failures into 400s instead of 500s. */
function parseAmount(value, decimals, label) {
  let s = String(value ?? "0").trim();
  if (s === "") s = "0";
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `${label}: invalid amount`);
    s = n.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw httpError(400, `${label}: invalid amount`);
  try {
    return parseUnits(s, decimals);
  } catch {
    throw httpError(400, `${label}: invalid amount`);
  }
}

function sanitizeAddress(v, label) {
  try {
    return getAddress(v);
  } catch {
    throw httpError(400, `${label}: invalid address`);
  }
}

/** GET /api/pools?chain=&token0=&token1=&fee= */
async function handlePools(q) {
  const chainKey = requireChain(q);
  const cfg = CHAINS[chainKey];
  const check = await verifyChainContracts(chainKey);
  if (!check.ok) return { chain: chainKey, warning: "contracts not verified on this chain", check, pools: [] };

  const feeParam = q.get("fee");
  const tiers = feeParam ? [Number(feeParam)] : FEE_TIERS;
  for (const f of tiers) if (!TICK_SPACING[f]) throw httpError(400, `unsupported fee tier ${f}`);

  // token0+token1 → that exact pair. Only token0 → "CA search": pair the token
  // against the chain's anchors (WETH + dollar stable).
  let pairList;
  if (q.get("token0") && !q.get("token1")) {
    const token = sanitizeAddress(q.get("token0"), "token0");
    const anchors = [cfg.weth, cfg.usdc].filter((a) => a.toLowerCase() !== token.toLowerCase());
    pairList = anchors.length ? anchors.map((a) => [token, a]) : [[cfg.weth, cfg.usdc]];
  } else {
    const tokenA = sanitizeAddress(q.get("token0") || cfg.weth, "token0");
    const tokenB = sanitizeAddress(q.get("token1") || cfg.usdc, "token1");
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) throw httpError(400, "token0 and token1 are the same");
    pairList = [[tokenA, tokenB]];
  }

  const cacheKey = `${chainKey}:${pairList.map((p) => p.join("/")).join("|")}:${tiers.join(",")}`;
  const cached = poolsRespCache.get(cacheKey);
  if (cached && Date.now() - cached.t < 45_000) return cached.v;

  const cl = client(chainKey);

  const pools = [];
  let firstMetaA = null;
  let firstMetaB = null;
  for (const [tokenA, tokenB] of pairList) {
  const [metaA, metaB] = await Promise.all([tokenMeta(chainKey, tokenA), tokenMeta(chainKey, tokenB)]);
  if (!firstMetaA) { firstMetaA = metaA; firstMetaB = metaB; }
  for (const fee of tiers) {
    let poolAddr = null;
    try {
      poolAddr = await getPoolAddress(chainKey, tokenA, tokenB, fee);
      if (!poolAddr) {
        pools.push({ fee, exists: false, pair: `${metaA.symbol}/${metaB.symbol}` });
        continue;
      }
      const [slot0, liq, t0addr, bal0raw, bal1raw] = await Promise.all([
        cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "slot0" }),
        cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "liquidity" }),
        cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "token0" }),
        cl.readContract({ address: tokenA, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddr] }),
        cl.readContract({ address: tokenB, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddr] }),
      ]);
      const aIs0 = t0addr.toLowerCase() === tokenA.toLowerCase();
      const meta0 = aIs0 ? metaA : metaB;
      const meta1 = aIs0 ? metaB : metaA;
      const bal0 = aIs0 ? bal0raw : bal1raw;
      const bal1 = aIs0 ? bal1raw : bal0raw;

      const sqrtPriceX96 = slot0[0];
      const tick = Number(slot0[1]);
      const price0In1 = priceFromSqrt(sqrtPriceX96, meta0.decimals, meta1.decimals);

      const [usd0, usd1] = await Promise.all([
        tokenUsdPrice(chainKey, meta0.address),
        tokenUsdPrice(chainKey, meta1.address),
      ]);
      const tvl0 = usd0 != null ? Number(formatUnits(bal0, meta0.decimals)) * usd0 : null;
      const tvl1 = usd1 != null ? Number(formatUnits(bal1, meta1.decimals)) * usd1 : null;
      const tvlUsd = tvl0 != null && tvl1 != null ? tvl0 + tvl1 : null;

      const vol = await estimate24hVolumeUsd(chainKey, poolAddr, meta0, meta1);
      const fees24hUsd = vol.vol24hUsd != null ? vol.vol24hUsd * (fee / 1_000_000) : null;
      const aprEst =
        fees24hUsd != null && tvlUsd ? (fees24hUsd / tvlUsd) * 365 * 100 : null;

      pools.push({
        fee,
        exists: true,
        address: poolAddr,
        tickSpacing: TICK_SPACING[fee],
        token0: meta0,
        token1: meta1,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        liquidity: liq.toString(),
        price0In1,
        price1In0: price0In1 ? 1 / price0In1 : null,
        tvlUsd,
        vol24hUsd: vol.vol24hUsd,
        vol24hNote: vol.windowSec
          ? `scaled to 24h from a ${Math.round(vol.windowSec / 60)}-min sample (${vol.sampled} swaps)`
          : vol.error || null,
        fees24hUsd,
        aprEst,
      });
    } catch (e) {
      pools.push({ fee, exists: poolAddr ? true : null, address: poolAddr, error: String(e.message || e) });
    }
  }
  }
  const result = { chain: chainKey, tokenA: firstMetaA, tokenB: firstMetaB, pools };
  poolsRespCache.set(cacheKey, { v: result, t: Date.now() });
  return result;
}

/** GET /api/positions?chain=&owner= */
async function handlePositions(q) {
  const chainKey = requireChain(q);
  const cfg = CHAINS[chainKey];
  const check = await verifyChainContracts(chainKey);
  if (!check.ok) return { chain: chainKey, warning: "contracts not verified on this chain", check, positions: [] };

  const owner = sanitizeAddress(q.get("owner") || "", "owner");
  const tokenFilter = q.get("token")
    ? sanitizeAddress(q.get("token"), "token").toLowerCase()
    : null;
  const cl = client(chainKey);

  const balance = Number(
    await cl.readContract({ address: cfg.npm, abi: NPM_ABI, functionName: "balanceOf", args: [owner] })
  );
  const count = Math.min(balance, 50);

  // scan from the newest indexes — recent positions are the live ones
  const tokenIds = await mapLimit(
    Array.from({ length: count }, (_, i) => balance - 1 - i),
    6,
    (i) =>
      cl.readContract({
        address: cfg.npm,
        abi: NPM_ABI,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(i)],
      })
  );

  const positions = [];
  for (const tokenId of tokenIds) {
    try {
      const p = await cl.readContract({
        address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId],
      });
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity, fgIn0Last, fgIn1Last, owed0, owed1] = p;
      if (liquidity === 0n && owed0 === 0n && owed1 === 0n) continue;
      if (tokenFilter && token0.toLowerCase() !== tokenFilter && token1.toLowerCase() !== tokenFilter) continue;

      const [meta0, meta1] = await Promise.all([tokenMeta(chainKey, token0), tokenMeta(chainKey, token1)]);
      const poolAddr = await getPoolAddress(chainKey, token0, token1, Number(fee));

      let tick = null, sqrtPriceX96 = null, fees0 = owed0, fees1 = owed1, inRange = null;
      let amount0 = 0n, amount1 = 0n, price0In1 = null;
      if (poolAddr) {
        const [slot0, fg0, fg1, lowerInfo, upperInfo] = await Promise.all([
          cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "slot0" }),
          cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
          cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
          cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "ticks", args: [tickLower] }),
          cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "ticks", args: [tickUpper] }),
        ]);
        sqrtPriceX96 = slot0[0];
        tick = Number(slot0[1]);
        inRange = tick >= Number(tickLower) && tick < Number(tickUpper);
        price0In1 = priceFromSqrt(sqrtPriceX96, meta0.decimals, meta1.decimals);

        fees0 = owed0 + feesOwedSide(fg0, lowerInfo[2], upperInfo[2], fgIn0Last, liquidity, tick, Number(tickLower), Number(tickUpper));
        fees1 = owed1 + feesOwedSide(fg1, lowerInfo[3], upperInfo[3], fgIn1Last, liquidity, tick, Number(tickLower), Number(tickUpper));

        const res = amountsForLiquidity(
          sqrtPriceX96,
          getSqrtRatioAtTick(Number(tickLower)),
          getSqrtRatioAtTick(Number(tickUpper)),
          liquidity
        );
        amount0 = res.amount0;
        amount1 = res.amount1;
      }

      positions.push({
        tokenId: tokenId.toString(),
        token0: meta0,
        token1: meta1,
        fee: Number(fee),
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        priceLower0In1: Math.pow(1.0001, Number(tickLower)) * Math.pow(10, meta0.decimals - meta1.decimals),
        priceUpper0In1: Math.pow(1.0001, Number(tickUpper)) * Math.pow(10, meta0.decimals - meta1.decimals),
        liquidity: liquidity.toString(),
        amount0: formatUnits(amount0, meta0.decimals),
        amount1: formatUnits(amount1, meta1.decimals),
        pool: poolAddr,
        currentTick: tick,
        currentPrice0In1: price0In1,
        inRange,
        feesOwed0: formatUnits(fees0, meta0.decimals),
        feesOwed1: formatUnits(fees1, meta1.decimals),
      });
    } catch (e) {
      positions.push({ tokenId: tokenId.toString(), error: String(e.message || e) });
    }
  }
  return { chain: chainKey, owner, tokenFilter, totalNfts: balance, shown: count, positions };
}

/** POST /api/position  body: { action: "open" | "close", ... } */
async function handlePosition(body) {
  const action = body.action;
  if (action === "open") return buildOpen(body);
  if (action === "close") return buildClose(body);
  throw httpError(400, "action must be 'open' or 'close'");
}

async function buildOpen(body) {
  const chainKey = (body.chain || "base").toLowerCase();
  if (!CHAINS[chainKey]) throw httpError(400, "chain must be 'base' or 'robinhood'");
  const cfg = CHAINS[chainKey];
  const check = await verifyChainContracts(chainKey);
  if (!check.ok) throw httpError(502, `contracts not verified on ${chainKey}: set ROBINHOOD_NPM/ROBINHOOD_FACTORY`);

  const fee = Number(body.fee);
  if (!TICK_SPACING[fee]) throw httpError(400, "unsupported fee tier");
  const spacing = TICK_SPACING[fee];

  const tokenAIn = sanitizeAddress(body.token0, "token0");
  const tokenBIn = sanitizeAddress(body.token1, "token1");
  if (tokenAIn.toLowerCase() === tokenBIn.toLowerCase()) throw httpError(400, "token0 and token1 are the same");
  const recipient = sanitizeAddress(body.recipient, "recipient");
  const slippageBps = clampNum(body.slippageBps, 0, 5000, 100);

  const poolAddr = await getPoolAddress(chainKey, tokenAIn, tokenBIn, fee);
  if (!poolAddr) throw httpError(404, "pool does not exist for this pair/fee");

  const cl = client(chainKey);
  const [slot0, t0addr] = await Promise.all([
    cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "slot0" }),
    cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "token0" }),
  ]);
  const tick = Number(slot0[1]);
  const aIs0 = t0addr.toLowerCase() === tokenAIn.toLowerCase();

  // canonical ordering: token0 < token1 as the pool defines it
  const token0 = aIs0 ? tokenAIn : tokenBIn;
  const token1 = aIs0 ? tokenBIn : tokenAIn;
  const [meta0, meta1] = await Promise.all([tokenMeta(chainKey, token0), tokenMeta(chainKey, token1)]);

  const amtA = body.amount0 ?? "0";
  const amtB = body.amount1 ?? "0";
  const amount0Desired = parseAmount(aIs0 ? amtA : amtB, meta0.decimals, "amount0");
  const amount1Desired = parseAmount(aIs0 ? amtB : amtA, meta1.decimals, "amount1");
  if (amount0Desired === 0n && amount1Desired === 0n) throw httpError(400, "both amounts are zero");

  // range
  let tickLower, tickUpper;
  const mode = body.rangeMode || "manual";
  if (mode === "auto10" || mode === "auto20") {
    const pct = mode === "auto10" ? 0.10 : 0.20;
    const deltaTicks = Math.round(Math.log(1 + pct) / Math.log(1.0001));
    tickLower = alignTick(tick - deltaTicks, spacing, false);
    tickUpper = alignTick(tick + deltaTicks, spacing, true);
  } else if (mode === "full") {
    tickLower = Math.ceil(MIN_TICK / spacing) * spacing;
    tickUpper = Math.floor(MAX_TICK / spacing) * spacing;
  } else {
    tickLower = Number(body.tickLower);
    tickUpper = Number(body.tickUpper);
    if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) {
      throw httpError(400, "manual mode requires tickLower & tickUpper");
    }
    tickLower = alignTick(tickLower, spacing, false);
    tickUpper = alignTick(tickUpper, spacing, true);
  }
  if (tickLower >= tickUpper) throw httpError(400, "tickLower must be < tickUpper");

  const bpsFactor = BigInt(10_000 - slippageBps);
  const amount0Min = (amount0Desired * bpsFactor) / 10_000n;
  const amount1Min = (amount1Desired * bpsFactor) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  const mintData = encodeFunctionData({
    abi: NPM_ABI,
    functionName: "mint",
    args: [{
      token0, token1, fee,
      tickLower, tickUpper,
      amount0Desired, amount1Desired,
      amount0Min, amount1Min,
      recipient, deadline,
    }],
  });

  const transactions = [];
  if (amount0Desired > 0n) {
    transactions.push({
      label: `Approve ${meta0.symbol}`,
      to: token0,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount0Desired] }),
      value: "0x0",
    });
  }
  if (amount1Desired > 0n) {
    transactions.push({
      label: `Approve ${meta1.symbol}`,
      to: token1,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.npm, amount1Desired] }),
      value: "0x0",
    });
  }
  transactions.push({ label: "Mint LP Position", to: cfg.npm, data: mintData, value: "0x0" });

  return {
    chain: chainKey,
    chainId: cfg.id,
    pool: poolAddr,
    fee,
    currentTick: tick,
    currentPrice0In1: priceFromSqrt(slot0[0], meta0.decimals, meta1.decimals),
    token0: meta0,
    token1: meta1,
    tickLower,
    tickUpper,
    priceLower0In1: Math.pow(1.0001, tickLower) * Math.pow(10, meta0.decimals - meta1.decimals),
    priceUpper0In1: Math.pow(1.0001, tickUpper) * Math.pow(10, meta0.decimals - meta1.decimals),
    amount0Desired: amount0Desired.toString(),
    amount1Desired: amount1Desired.toString(),
    amount0Min: amount0Min.toString(),
    amount1Min: amount1Min.toString(),
    deadline: deadline.toString(),
    transactions,
    note: "Sign the transactions in order: approvals first, then mint. The app never holds keys.",
  };
}

async function buildClose(body) {
  const chainKey = (body.chain || "base").toLowerCase();
  if (!CHAINS[chainKey]) throw httpError(400, "chain must be 'base' or 'robinhood'");
  const cfg = CHAINS[chainKey];
  const check = await verifyChainContracts(chainKey);
  if (!check.ok) throw httpError(502, `contracts not verified on ${chainKey}`);

  let tokenId;
  try {
    tokenId = BigInt(body.tokenId);
    if (tokenId < 0n) throw new Error();
  } catch {
    throw httpError(400, "tokenId: invalid NFT id");
  }
  const percent = clampNum(body.percent, 1, 100, 100);
  const recipient = sanitizeAddress(body.recipient, "recipient");
  const slippageBps = clampNum(body.slippageBps, 0, 5000, 100);
  const doBurn = body.burn !== false && percent === 100;

  const cl = client(chainKey);
  let p;
  try {
    p = await cl.readContract({ address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId] });
  } catch {
    throw httpError(404, `position #${tokenId} not found on ${cfg.name}`);
  }
  const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p;
  const [meta0, meta1] = await Promise.all([tokenMeta(chainKey, token0), tokenMeta(chainKey, token1)]);

  const liqToRemove = (liquidity * BigInt(Math.round(percent * 100))) / 10_000n;

  // expected amounts out → slippage-protected minimums
  let amount0Min = 0n, amount1Min = 0n;
  const poolAddr = await getPoolAddress(chainKey, token0, token1, Number(fee));
  if (poolAddr && liqToRemove > 0n) {
    const slot0 = await cl.readContract({ address: poolAddr, abi: POOL_ABI, functionName: "slot0" });
    const { amount0, amount1 } = amountsForLiquidity(
      slot0[0],
      getSqrtRatioAtTick(Number(tickLower)),
      getSqrtRatioAtTick(Number(tickUpper)),
      liqToRemove
    );
    const bpsFactor = BigInt(10_000 - slippageBps);
    amount0Min = (amount0 * bpsFactor) / 10_000n;
    amount1Min = (amount1 * bpsFactor) / 10_000n;
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const calls = [];
  if (liqToRemove > 0n) {
    calls.push(encodeFunctionData({
      abi: NPM_ABI,
      functionName: "decreaseLiquidity",
      args: [{ tokenId, liquidity: liqToRemove, amount0Min, amount1Min, deadline }],
    }));
  }
  calls.push(encodeFunctionData({
    abi: NPM_ABI,
    functionName: "collect",
    args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  }));
  if (doBurn) {
    calls.push(encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] }));
  }

  const data = encodeFunctionData({ abi: NPM_ABI, functionName: "multicall", args: [calls] });

  return {
    chain: chainKey,
    chainId: cfg.id,
    tokenId: tokenId.toString(),
    token0: meta0,
    token1: meta1,
    fee: Number(fee),
    percent,
    liquidityRemoved: liqToRemove.toString(),
    amount0Min: amount0Min.toString(),
    amount1Min: amount1Min.toString(),
    burn: doBurn,
    steps: [
      ...(liqToRemove > 0n ? ["decreaseLiquidity"] : []),
      "collect",
      ...(doBurn ? ["burn"] : []),
    ],
    transactions: [
      {
        label: `Close Position #${tokenId} (${percent}%)`,
        to: cfg.npm,
        data,
        value: "0x0",
      },
    ],
    note: "Single signature: multicall of decreaseLiquidity + collect" + (doBurn ? " + burn" : "") + ".",
  };
}

/** GET /api/health — free */
async function handleHealth() {
  const [base, robinhood] = await Promise.all([
    verifyChainContracts("base").catch((e) => ({ ok: false, error: String(e) })),
    verifyChainContracts("robinhood").catch((e) => ({ ok: false, error: String(e) })),
  ]);
  return {
    app: "BANKRLIQ",
    x402: { mode: X402_MODE, payTo: X402_PAY_TO, prices: X402_PRICES },
    chains: { base, robinhood },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 3402);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-payment, x-402-payment, x-bankr-payment",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 100_000) {
        reject(httpError(413, "body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const routeKey = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-payment, x-402-payment, x-bankr-payment",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  try {
    // static frontend
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (routeKey === "GET /api/health") {
      return sendJson(res, 200, await handleHealth());
    }

    // x402 gate for priced endpoints
    const denial = await enforceX402(req, routeKey, url.toString());
    if (denial) return sendJson(res, denial.status, denial.body);

    if (routeKey === "GET /api/pools") {
      return sendJson(res, 200, await handlePools(url.searchParams));
    }
    if (routeKey === "GET /api/positions") {
      return sendJson(res, 200, await handlePositions(url.searchParams));
    }
    if (routeKey === "POST /api/position") {
      const body = await readBody(req);
      return sendJson(res, 200, await handlePosition(body));
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(`[bankrliq] ${routeKey}:`, e);
    return sendJson(res, status, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`BANKRLIQ listening on :${PORT} (x402 mode: ${X402_MODE})`);
});
