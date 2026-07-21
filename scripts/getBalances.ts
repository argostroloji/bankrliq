// --- chain bridge helpers (see diagEncode findings) -------------------------
// bankr.chain.* serializes its options to JSON: BigInt args throw, and every
// call returns a Promise. __s() deep-converts BigInt -> decimal string; the
// wrappers always await. encodeFunctionData is validated to be real 0x hex so
// a bad encode fails loudly here instead of reaching a wallet.
function __s(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(__s);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = __s(v[k]);
    return o;
  }
  return v;
}
async function __enc(o) {
  const d = await bankr.chain.encodeFunctionData(__s(o));
  if (typeof d !== "string" || d.slice(0, 2) !== "0x" || d.length < 10) {
    throw new Error("encodeFunctionData returned " + (typeof d) + " for " + (o && o.functionName));
  }
  return d;
}
async function __read(o) { return await bankr.chain.readContract(__s(o)); }
async function __multi(o) { return await bankr.chain.multicall(__s(o)); }
// ---------------------------------------------------------------------------
// BANKRLIQ — getBalances (authenticated viewer script, FREE)
// args: { chain: "base"|"robinhood", tokens: [erc20Address, ...] (max 6), owner? }
// Returns the caller's native + token balances so the UI can show what they
// have before opening a position.

const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

// multicall may be restricted in some sandbox contexts — sequential fallback
async function mcall(ck, calls) {
  try {
    return await __multi({ chain: ck, calls });
  } catch (e) {
    const out = [];
    for (const c of calls) {
      try {
        out.push({ status: "success", result: await __read({ chain: ck, address: c.address, abi: c.abi, functionName: c.functionName, args: c.args }) });
      } catch (e2) { out.push({ status: "failure", result: null }); }
    }
    return out;
  }
}
function fmtUnits(v, dec) {
  v = BigInt(v);
  const s = v.toString().padStart(dec + 1, "0");
  const i = s.slice(0, s.length - dec) || "0";
  const f = s.slice(s.length - dec).replace(/0+$/, "");
  return i + (f ? "." + f : "");
}

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const owner = (a.owner && isAddr(a.owner) ? a.owner : null) || (ctx && ctx.caller && ctx.caller.walletAddress);
if (!owner) return { error: "not signed in", tokens: [] };
const tokenList = (Array.isArray(a.tokens) ? a.tokens : []).filter(isAddr).slice(0, 6);

let native = null;
try {
  const wei = await bankr.chain.getBalance({ chain: chainKey, address: owner });
  native = fmtUnits(BigInt(wei || 0), 18);
} catch (e) { native = null; }

const calls = [];
for (const t of tokenList) {
  calls.push({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
  calls.push({ address: t, abi: ERC20_ABI, functionName: "decimals", args: [] });
  calls.push({ address: t, abi: ERC20_ABI, functionName: "symbol", args: [] });
}
const res = calls.length ? await mcall(chainKey, calls) : [];

const tokens = tokenList.map((t, i) => {
  const bal = norm(res[i * 3]);
  const dec = Number(norm(res[i * 3 + 1]) ?? 18);
  const sym = norm(res[i * 3 + 2]) || "???";
  return {
    address: t, symbol: sym, decimals: dec,
    balance: bal != null ? fmtUnits(BigInt(bal), dec) : null,
  };
});

return { chain: chainKey, owner, native, tokens };
