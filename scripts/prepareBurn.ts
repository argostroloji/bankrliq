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

const data = bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: [tokenId] });
const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Burn NFT #" + tokenId });

return { chain: chainKey, tokenId: tokenId.toString(), txBlobs: [{ label: "Burn NFT #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };
