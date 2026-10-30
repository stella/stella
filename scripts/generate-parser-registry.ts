import { fail as panic } from "node:assert";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PARSER_ENTRY_DIRECTORY,
  PARSER_REGISTRY_OUTPUT,
  renderParserRegistry,
} from "./parser-registry";

export const generateParserRegistry = (
  root = new URL("../", import.meta.url),
  mode: "write" | "check" = "write",
) => {
  const directory = new URL(PARSER_ENTRY_DIRECTORY, root);
  const files = new Map(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map(({ name }) => [
        `${PARSER_ENTRY_DIRECTORY}${name}`,
        readFileSync(new URL(name, directory), "utf-8"),
      ]),
  );
  const source = renderParserRegistry(files);
  if (source === undefined) {
    panic("No parser registry entries");
  }
  const output = fileURLToPath(new URL(PARSER_REGISTRY_OUTPUT, root));
  if (mode === "check") {
    if (readFileSync(output, "utf-8") !== source) {
      panic(
        "Parser registry index is stale; run bun scripts/generate-parser-registry.ts",
      );
    }
    return;
  }
  writeFileSync(output, source);
};

if (import.meta.main) {
  generateParserRegistry(
    undefined,
    process.argv.includes("--check") ? "check" : "write",
  );
}
