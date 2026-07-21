// BANKRLIQ — prepareCollect (FREE for every visitor)
// frontendIdentity is "viewer", so tx.prepare builds a blob that THE CALLER's
// own wallet signs. Collects ALL owed tokens to the recipient; the position
// stays open.
// args: { chain, tokenId, recipient? } → { txBlobs: [{ label, blob }] }

const callerAddr = ctx && ctx.caller && ctx.caller.walletAddress;
if (!callerAddr) return { error: "sign in first" };

const CHAINS = {
  base: { npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" },
  robinhood: { npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" },
};
const NPM_ABI = [
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint24" },
      { type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" },
    ] },
  { type: "function", name: "collect", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
];
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

const a = args || {};
const chainKey = a.chain === "robinhood" ? "robinhood" : "base";
const cfg = CHAINS[chainKey];
let tokenId;
try { tokenId = BigInt(a.tokenId); if (tokenId < BigInt(0)) throw new Error(); } catch (e) { return { error: "invalid tokenId" }; }
const recipient = a.recipient || callerAddr;

// confirm the position exists (clear error instead of an opaque revert later)
try {
  await bankr.chain.readContract({ chain: chainKey, address: cfg.npm, abi: NPM_ABI, functionName: "positions", args: [tokenId] });
} catch (e) {
  return { error: "position #" + tokenId + " not found on " + chainKey };
}

const data = bankr.chain.encodeFunctionData({
  abi: NPM_ABI, functionName: "collect",
  args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
});
const blob = await bankr.tx.prepare({ chain: chainKey, to: cfg.npm, data, label: "Collect fees #" + tokenId });

return {
  chain: chainKey, tokenId: tokenId.toString(), recipient,
  txBlobs: [{ label: "Collect fees #" + tokenId, blob }],
};
