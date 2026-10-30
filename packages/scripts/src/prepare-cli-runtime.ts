import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "./child-exit-status";
import { hasPreparedGeneratedSources } from "./prepared-generated-sources";

const root = new URL("../../../", import.meta.url).pathname;
const featureBindings = path.join(
  root,
  "apps/api/src/mcp/generated/capability-feature-bindings.ts",
);
const capabilityDirectory = path.join(root, "packages/cli/capabilities");
const needsCapabilityBootstrap =
  !existsSync(featureBindings) || !existsSync(capabilityDirectory);
if (needsCapabilityBootstrap) {
  mkdirSync(path.dirname(featureBindings), { recursive: true });
  writeFileSync(
    featureBindings,
    "// Temporary bootstrap for capability catalog generation.\nexport const CAPABILITY_FEATURE_BINDINGS = new Map<string, string>();\n",
  );
}
const apps = Bun.spawnSync(["bun", "scripts/prepare-mcp-apps.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (childExitStatus(apps) !== 0) {
  process.exit(childExitStatus(apps));
}
const catalog = Bun.spawnSync(
  ["bun", "apps/api/scripts/export-capability-catalog.ts", "--catalog-only"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (childExitStatus(catalog) !== 0) {
  process.exit(childExitStatus(catalog));
}
if (needsCapabilityBootstrap) {
  const runtime = Bun.spawnSync(
    ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (childExitStatus(runtime) !== 0) {
    process.exit(childExitStatus(runtime));
  }
  const regeneratedCatalog = Bun.spawnSync(
    ["bun", "apps/api/scripts/export-capability-catalog.ts", "--catalog-only"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (childExitStatus(regeneratedCatalog) !== 0) {
    process.exit(childExitStatus(regeneratedCatalog));
  }
}
if (!hasPreparedGeneratedSources(root)) {
  const result = Bun.spawnSync(
    ["bun", "packages/cli/src/codegen.ts", "--runtime-only"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(childExitStatus(result));
}
