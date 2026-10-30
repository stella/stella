import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PARSER_ENTRY_DIRECTORY,
  PARSER_REGISTRY_OUTPUT,
  renderParserRegistry,
} from "./parser-registry";

export const generateParserRegistry = (
  root = new URL("../", import.meta.url),
) => {
  const directory = new URL(PARSER_ENTRY_DIRECTORY, root);
  const files = new Map(
    readdirSync(directory).map((file) => [
      `${PARSER_ENTRY_DIRECTORY}${file}`,
      readFileSync(new URL(file, directory), "utf-8"),
    ]),
  );
  const source = renderParserRegistry(files);
  if (source !== undefined) {
    writeFileSync(fileURLToPath(new URL(PARSER_REGISTRY_OUTPUT, root)), source);
  }
};

if (import.meta.main) {
  generateParserRegistry();
}
