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
// BANKRLIQ — prepareBurn
// args: { chain, tokenId }
// Burns the (fully emptied) LP NFT. Reverts on-chain if liquidity or owed
// tokens remain — run decrease + collect first.
// Returns { txBlobs: [{label, blob}] }.

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" },
};
const NPM_ABI = [
  { type: "function", name: "burn", stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
];

const callerAddr = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr) return { error: "sign in first" };

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
let tokenId;
try { tokenId = BigInt(a.tokenId); if (tokenId < BigInt(0)) throw new Error(); } catch (e) { return { error: "invalid tokenId" }; }

const data = await __enc({ abi: NPM_ABI, functionName: "burn", args: [tokenId] });
let blob = null;
try { blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Burn NFT #" + tokenId }); } catch (e) { blob = null; }

return { chain: chainKey, tokenId: tokenId.toString(), txBlobs: [{ label: "Burn NFT #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };
