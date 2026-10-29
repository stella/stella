import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const widgetsRoot = path.dirname(require.resolve("expo-widgets/package.json"));
const output = path.join(widgetsRoot, "bundle/build/ExpoWidgets.bundle");
rmSync(output, { force: true });
mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    require.resolve("expo/bin/cli"),
    "export:embed",
    "--platform",
    "ios",
    "--bundle-output",
    output,
    "--entry-file",
    path.join(widgetsRoot, "bundle/index.ts"),
    "--dev",
    "false",
    "--skip-server",
    "--max-workers",
    "1",
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      EXPO_OVERRIDE_METRO_CONFIG: path.join(
        projectRoot,
        "widgets.metro.config.cjs",
      ),
    },
    stdio: "inherit",
  },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
