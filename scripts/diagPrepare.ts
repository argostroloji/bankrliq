// BANKRLIQ — diagPrepare: harmless probe that answers ONE question:
// does bankr.tx.prepare work in this app's viewer context now that
// read:wallet + prepare:transaction are granted?
// It only BUILDS a blob (no broadcast, no signing, nothing is sent).

const out = { caller: null, wallet: null, prepare: null, blobShape: null, error: null };

try { out.caller = ctx && ctx.caller ? ctx.caller.walletAddress : null; } catch (e) { out.caller = "ERR " + String(e.message || e); }
try { const me = await bankr.wallet.me(); out.wallet = me && (me.evmAddress || me.address) ? (me.evmAddress || me.address) : JSON.stringify(me); }
catch (e) { out.wallet = "ERR " + String(e && e.message ? e.message : e).slice(0, 160); }

// a no-op transaction to a harmless target: send 0 value, empty calldata, to self
const target = out.caller && String(out.caller).indexOf("0x") === 0 ? out.caller : "0x0000000000000000000000000000000000000001";
try {
  const blob = await bankr.tx.prepare({ chain: "base", to: target, data: "0x", value: "0", label: "BANKRLIQ capability probe (no-op)" });
  out.prepare = "OK";
  out.blobShape = blob && typeof blob === "object" ? Object.keys(blob).join(",") : typeof blob;
} catch (e) {
  out.prepare = "FAILED";
  out.error = String(e && e.message ? e.message : e).slice(0, 300);
}

return out;
