import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTIONARIES_DIR = join(__dirname, "..", "dictionaries");
const ROOT_ENTRY = join(DICTIONARIES_DIR, "index.ts");
const CITY_LOADERS = join(DICTIONARIES_DIR, "city-loaders.ts");

// Statements that survive type erasure: `import type` and `export type` do
// not, so they cannot pull a chunk into a bundle.
const RUNTIME_IMPORT_RE =
  /\b(?:import|export)\s+(type\s+)?[^"';]*?from\s+"(\.[^"]*)"/g;

const resolveModule = (fromFile: string, specifier: string): string | null => {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * The city loader map holds one literal `import()` per covered country, so a
 * bundler emits all ~237 city chunks for any module graph that reaches it.
 * A names-only consumer of the root entry must not pay for that: the city API
 * stays reachable only through the `./cities` entry.
 */
test("the root entry's static graph never reaches city-loaders", () => {
  const chains = new Map<string, readonly string[]>([[ROOT_ENTRY, []]]);
  const queue: string[] = [ROOT_ENTRY];
  const visited = new Set<string>();

  let file = queue.pop();
  while (file !== undefined) {
    if (!visited.has(file)) {
      visited.add(file);
      const chain = [...(chains.get(file) ?? []), file];
      const source = readFileSync(file, "utf-8");
      for (const [, typeOnly, specifier] of source.matchAll(
        RUNTIME_IMPORT_RE,
      )) {
        if (typeOnly !== undefined || specifier === undefined) {
          continue;
        }
        const target = resolveModule(file, specifier);
        if (target === null || visited.has(target)) {
          continue;
        }
        chains.set(target, chain);
        queue.push(target);
      }
    }
    file = queue.pop();
  }

  expect(chains.get(CITY_LOADERS)).toBeUndefined();
});
