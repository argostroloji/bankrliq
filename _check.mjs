import fs from "node:fs";
const files = fs.readdirSync("scripts").filter((f) => f.endsWith(".ts"));
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync("scripts/" + f, "utf8");
  try {
    // same wrapper the runtime uses: top-level statements + return inside an async fn
    new Function("appKV", "bankr", "http", "secrets", "log", "ctx", "args", `return (async () => { ${src}\n })()`);
    // sanity: gate var must match its declaration
    const m = src.match(/const (callerAddr0?) = ctx[^\n]*\nif \(!(callerAddr0?)\)/);
    const gateOk = !m || m[1] === m[2];
    console.log((gateOk ? "OK   " : "GATE ") + f);
    if (!gateOk) bad++;
  } catch (e) {
    console.log("SYNTAX ERROR " + f + ": " + e.message);
    bad++;
  }
}
console.log(bad === 0 ? "\nALL SCRIPTS VALID" : "\n" + bad + " problems");
process.exit(bad ? 1 : 0);
