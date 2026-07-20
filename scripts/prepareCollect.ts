// BANKRLIQ — prepareCollect
// args: { chain, tokenId, recipient? }
// Collects ALL owed tokens (max uint128 on both sides) to the recipient.
// Returns { txBlobs: [{label, blob}] }.

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" },
};
const NPM_ABI = [
  { type: "function", name: "collect", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
];
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

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
const recipient = a.recipient || (ctx && ctx.caller && ctx.caller.walletAddress);
if (!recipient) return { error: "no recipient (sign in first)" };

const data = bankr.chain.encodeFunctionData({
  abi: NPM_ABI, functionName: "collect",
  args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
});
const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Collect fees #" + tokenId });

return { chain: chainKey, tokenId: tokenId.toString(), recipient, txBlobs: [{ label: "Collect fees #" + tokenId, blob, raw: { chain: chainKey, to: cfg.npm, data, value: "0x0" } }] };
