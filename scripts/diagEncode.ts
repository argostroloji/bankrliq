// BANKRLIQ — diagEncode v2. Round 1 proved encodeFunctionData rejects BigInt
// args ("JSON.stringify cannot serialize BigInt") — its arguments cross a
// serialization bridge. Round 2 answers the two follow-ups:
//   (a) with STRING args, what does it return — hex, object, or a thenable?
//   (b) does it need to be AWAITED?
// Pure inspection: nothing is prepared, signed or broadcast.

const NPM_ABI = [
  { type: "function", name: "burn", stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "collect", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenId", type: "uint256" }, { name: "recipient", type: "address" },
      { name: "amount0Max", type: "uint128" }, { name: "amount1Max", type: "uint128" },
    ] }],
    outputs: [{ type: "uint256" }, { type: "uint256" }] },
];

const out = { syncShape: null, awaitedShape: null, tupleAwaited: null, isThenable: null, error: null };

function shape(v) {
  const t = typeof v;
  if (t === "string") return { type: "string", len: v.length, head: v.slice(0, 20), isHex: v.slice(0, 2) === "0x" };
  if (v === null) return { type: "null" };
  if (t !== "object") return { type: t, value: String(v) };
  const keys = Object.keys(v);
  const vals = {};
  for (const k of keys.slice(0, 8)) {
    const val = v[k];
    vals[k] = typeof val === "string" ? val.slice(0, 24) : typeof val;
  }
  return { type: "object", keys: keys.join(","), values: vals,
    thenable: typeof v.then === "function", str: String(v).slice(0, 40) };
}

try {
  // (a) call WITHOUT await, string args
  const r1 = bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: ["267073"] });
  out.syncShape = shape(r1);
  out.isThenable = !!(r1 && typeof r1.then === "function");

  // (b) same call WITH await
  const r2 = await bankr.chain.encodeFunctionData({ abi: NPM_ABI, functionName: "burn", args: ["267073"] });
  out.awaitedShape = shape(r2);

  // tuple/struct arg, all numerics as decimal strings
  const r3 = await bankr.chain.encodeFunctionData({
    abi: NPM_ABI, functionName: "collect",
    args: [{
      tokenId: "267073",
      recipient: "0xa2baa5527e25de10099096a3257d0b1938f095b1",
      amount0Max: "340282366920938463463374607431768211455",
      amount1Max: "340282366920938463463374607431768211455",
    }],
  });
  out.tupleAwaited = shape(r3);
} catch (e) {
  out.error = String(e && e.message ? e.message : e).slice(0, 300);
}

return out;
