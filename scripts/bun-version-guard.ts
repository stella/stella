import { readFileSync } from "node:fs";
import path from "node:path";

const packageJsonPath = path.resolve(import.meta.dir, "../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const packageManager = packageJson.packageManager;

if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) {
  process.stderr.write(
    `BunVersionMismatch: ${packageJsonPath} must pin Bun as bun@<version>.\n`,
  );
  process.exit(1);
}

const pinnedVersion = packageManager.slice("bun@".length);
if (Bun.version !== pinnedVersion) {
  process.stderr.write(
    `BunVersionMismatch: this checkout pins Bun ${pinnedVersion}; ${process.execPath} is Bun ${Bun.version}. Put the pinned Bun first on PATH (or remove the other one).\n`,
  );
  process.exit(1);
}
