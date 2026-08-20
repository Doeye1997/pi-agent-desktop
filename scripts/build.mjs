#!/usr/bin/env node
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const executable = process.platform === "win32" && cmd === "npx" ? "npx.cmd" : cmd;
  console.log(`> ${executable} ${args.join(" ")}`);
  const r = spawnSync(executable, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(process.execPath, ["scripts/build-main.mjs"]);
run("npx", ["vite", "build", "--config", "vite.config.ts"]);
console.log("[build] done → out/");
