#!/usr/bin/env node
// Stamp the given version into server.json (top-level + every packages[].version).
// Invoked from cog.toml pre_bump_hooks during a release.
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: stamp-server-json.mjs <version>");
  process.exit(1);
}

const path = "server.json";
const target = "@hostsmith/mcp-server";

const sj = JSON.parse(fs.readFileSync(path, "utf8"));
sj.version = version;
let stampedPkg = false;
for (const p of sj.packages || []) {
  if (p.identifier === target) {
    p.version = version;
    stampedPkg = true;
  }
}
if (!stampedPkg) {
  console.error(`server.json packages[] has no entry with identifier "${target}"`);
  process.exit(1);
}
fs.writeFileSync(path, JSON.stringify(sj, null, 2) + "\n");

console.log(`stamped ${path} -> ${version}`);
