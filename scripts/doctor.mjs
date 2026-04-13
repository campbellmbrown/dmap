#!/usr/bin/env node
import { execSync } from "node:child_process";

function run(command) {
  return execSync(command, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  }).trim();
}

function checkUv() {
  try {
    return run("uv --version");
  } catch {
    return null;
  }
}

const nodeVersion = process.version;
const nodeLts = process.release.lts;
const npmVersion = run("npm --version");
const uvVersion = checkUv();

let hasError = false;

console.log(`Node.js: ${nodeVersion}${nodeLts ? ` (LTS: ${nodeLts})` : " (not LTS)"}`);
console.log(`npm: ${npmVersion}`);
console.log(`uv: ${uvVersion ?? "not found"}`);

if (!nodeLts) {
  hasError = true;
  console.error("\n[doctor] Node.js is not running an LTS release.");
  console.error("Install or upgrade with:");
  console.error("  winget install --id OpenJS.NodeJS.LTS -e");
  console.error("  winget upgrade --id OpenJS.NodeJS.LTS -e");
}

if (!uvVersion) {
  hasError = true;
  console.error("\n[doctor] uv is not installed or not on PATH.");
  console.error("Install with:");
  console.error("  winget install --id astral-sh.uv -e");
}

if (hasError) {
  process.exitCode = 1;
} else {
  console.log("\n[doctor] Environment looks good.");
}
