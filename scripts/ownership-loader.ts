import { panic } from "better-result";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// One declaration per `<id>.ts` default export, in filename order. Ids are
// unique because filenames are. Synchronous loading also works when Node
// loads oxlint.config.ts.
export const loadDeclarationDirectory = <T extends { readonly id: string }>(
  directory: URL,
  kind: string,
): readonly T[] =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".ts"))
    .toSorted()
    .map((file) => {
      const { default: entry }: { default: T } = require(
        fileURLToPath(new URL(file, directory)),
      );
      if (entry.id !== path.basename(file, ".ts")) {
        panic(`${kind} filename must match id: ${file} (${entry.id})`);
      }
      return entry;
    });
