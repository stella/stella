import path from "node:path";

import { requireFormatterEnvironment } from "./check-format-environment";

const FORMATTER_CONFIG = path.resolve(import.meta.dir, "../.oxfmtrc.json");

requireFormatterEnvironment();

const result = Bun.spawnSync(
  [
    process.execPath,
    "--bun",
    "oxfmt",
    "-c",
    FORMATTER_CONFIG,
    ...process.argv.slice(2),
  ],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (result.signalCode !== undefined) {
  console.error(`Oxfmt terminated by ${result.signalCode}.`);
  process.exit(1);
}

process.exit(result.exitCode);
