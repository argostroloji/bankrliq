// --- chain bridge helpers (see diagEncode findings) -------------------------
// bankr.chain.* serializes its options to JSON: BigInt args throw, and every
// call returns a Promise. __s() deep-converts BigInt -> decimal string; the
// wrappers always await.
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
async function __read(o) { return await bankr.chain.readContract(__s(o)); }
// ---------------------------------------------------------------------------

// BANKRLIQ — getAllowance
// args: { chain, tokens: ["0x..", ...], spender }
// Lets the app confirm an approval actually landed on-chain before it hands
// over the transaction that depends on it. Broadcasting a multi-step sequence
// as one chat message relies on the agent honouring the order; this does not.

const CHAINS = { base: 1, robinhood: 1 };
const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];
const norm = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);

const callerAddr = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr) return { error: "sign in first" };

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
if (!CHAINS[chainKey]) return { error: "unsupported chain" };
const owner = a.owner || callerAddr;
const spender = a.spender;
if (typeof spender !== "string" || spender.slice(0, 2) !== "0x") return { error: "spender is required" };
const tokens = (Array.isArray(a.tokens) ? a.tokens : []).slice(0, 10)
  .filter((t) => typeof t === "string" && t.slice(0, 2) === "0x");
if (!tokens.length) return { error: "tokens is required" };

const out = [];
for (const token of tokens) {
  try {
    const [allow, bal] = await Promise.all([
      __read({ chain: chainKey, address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }),
      __read({ chain: chainKey, address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    ]);
    out.push({ token, allowance: BigInt(norm(allow) || 0).toString(), balance: BigInt(norm(bal) || 0).toString() });
  } catch (e) {
    out.push({ token, allowance: null, balance: null, error: String(e && e.message ? e.message : e).slice(0, 120) });
  }
}
return { chain: chainKey, owner, spender, tokens: out };
