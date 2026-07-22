// BANKRLIQ — diagTime: the sandbox clock runs ~24h behind real time, so every
// deadline built from Date.now() is already expired on arrival. This probe
// finds a trustworthy time source. Read-only: nothing prepared or broadcast.
// Uses only documented SDK surface: readContract + http.fetch.

const out = { scriptNow: null, iso: null, sources: {}, error: null };

try {
  const now = Math.floor(Date.now() / 1000);
  out.scriptNow = now;
  out.iso = new Date(now * 1000).toISOString();
} catch (e) { out.error = String(e && e.message ? e.message : e); }

async function attempt(k, fn) {
  try {
    const v = await fn();
    out.sources[k] = v === undefined ? "undefined" : v;
  } catch (e) {
    out.sources[k] = "ERR " + String(e && e.message ? e.message : e).slice(0, 130);
  }
}
const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);

// (1) Multicall3 sits at the same address on most chains and exposes
// getCurrentBlockTimestamp() — this is CHAIN time, exactly what checkDeadline
// compares against, so it is the ideal source if it is deployed.
const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC3_ABI = [
  { type: "function", name: "getCurrentBlockTimestamp", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
for (const ck of ["robinhood", "base"]) {
  await attempt("multicall3." + ck, async () => {
    const v = norm(await bankr.chain.readContract({
      chain: ck, address: MC3, abi: MC3_ABI, functionName: "getCurrentBlockTimestamp", args: [],
    }));
    return String(v) + " (iso " + new Date(Number(v) * 1000).toISOString() + ")";
  });
}

// (2) a Uniswap V3 pool records the timestamp of its most recent observation —
// older than head, but a hard lower bound on real chain time
const POOL = "0xacc66E5ef6641c726c35175c95Eae274b43d682a";
const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] },
  { type: "function", name: "observations", stateMutability: "view", inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ type: "uint32" }, { type: "int56" }, { type: "uint160" }, { type: "bool" }] },
];
await attempt("poolObservation.robinhood", async () => {
  const s0 = norm(await bankr.chain.readContract({ chain: "robinhood", address: POOL, abi: POOL_ABI, functionName: "slot0", args: [] }));
  const idx = Number(s0[2]);
  const ob = norm(await bankr.chain.readContract({ chain: "robinhood", address: POOL, abi: POOL_ABI, functionName: "observations", args: [idx] }));
  return String(ob[0]) + " (iso " + new Date(Number(ob[0]) * 1000).toISOString() + ")";
});

// (3) an outbound HTTP time source
await attempt("http.time", async () => {
  const r = await http.fetch("https://worldtimeapi.org/api/timezone/Etc/UTC");
  const body = r && (r.data || r.body || r);
  const t = typeof body === "string" ? JSON.parse(body) : body;
  return String(t.unixtime) + " " + String(t.utc_datetime);
});

return out;
