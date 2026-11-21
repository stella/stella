import { panic } from "better-result";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OwnershipEntry } from "./ownership-types.ts";

const require = createRequire(import.meta.url);

// Synchronous loading also works when Node loads oxlint.config.ts.
export const loadOwnershipDeclarations = (directory: URL): OwnershipEntry[] =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".ts"))
    .toSorted()
    .map((file) => {
      const { default: entry }: { default: OwnershipEntry } = require(
        fileURLToPath(new URL(file, directory)),
      );
      if (entry.id !== path.basename(file, ".ts")) {
        panic(`ownership filename must match id: ${file} (${entry.id})`);
      }
      return entry;
    });
