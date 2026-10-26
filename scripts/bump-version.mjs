import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(rootDir, "package.json");

/** 读取 package.json，patch 位 +1 后写回 */
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prev = String(pkg.version ?? "");
const parts = prev.split(".").map((n) => Number(n));

if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
  console.error(`[bump-version] 无效 version: ${prev}`);
  process.exit(1);
}

parts[2] += 1;
const next = parts.join(".");
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.info(`[bump-version] ${prev} → ${next}`);
