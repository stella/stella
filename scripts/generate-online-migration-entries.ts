import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../apps/api/src/db/online-migration-entries/", import.meta.url),
);
const output = fileURLToPath(
  new URL(
    "../apps/api/src/db/online-migration-entries.gen.ts",
    import.meta.url,
  ),
);
const lines = readdirSync(directory)
  .filter((name) => name.endsWith(".ts"))
  .toSorted()
  .map((name) => {
    const stem = name.slice(0, -3);
    return `export { default as ${stem.replaceAll("-", "_")} } from "./online-migration-entries/${stem}";`;
  });
const expected = `${lines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  const actual = readFileSync(output, "utf-8");
  if (actual !== expected) {
    process.stderr.write(
      "Online migration entry index is stale; run bun scripts/generate-online-migration-entries.ts\n",
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, expected);
}
