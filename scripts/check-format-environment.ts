import { existsSync } from "node:fs";
import path from "node:path";

import formatterConfig from "../.oxfmtrc.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const tailwindStylesheet = path.resolve(
  REPO_ROOT,
  formatterConfig.sortTailwindcss.stylesheet,
);

if (!existsSync(tailwindStylesheet)) {
  console.error(
    "Formatter dependencies are incomplete. Run `bun install --frozen-lockfile` before formatting.",
  );
  process.exit(1);
}
