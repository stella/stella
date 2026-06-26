#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hasPhysicalProperty } from "../../../.oxlint-plugins/physical-properties";

// oxlint cannot parse `.astro` template class attributes, and the
// no-physical-properties oxlint rule is scoped to apps/web / packages/ui /
// packages/folio `.tsx`. This scans the landing's own source for the same
// physical directional classes (so RTL stays correct), reusing the rule's
// patterns from one shared source rather than duplicating them.

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(srcDir, { recursive: true, encoding: "utf-8" })
  .filter((file) => file.endsWith(".astro") || file.endsWith(".tsx"))
  .toSorted();

let violations = 0;
for (const relativePath of files) {
  const lines = readFileSync(`${srcDir}${relativePath}`, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Only class-bearing lines, to avoid matching prose like "left-to-right".
    if (!line.includes("class")) {
      continue;
    }
    if (hasPhysicalProperty(line)) {
      console.log(
        `  src/${relativePath}:${i + 1}  ${line.trim().slice(0, 90)}`,
      );
      violations += 1;
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} physical-direction class(es) in apps/landing. Use logical ` +
      "equivalents: ml->ms, mr->me, pl->ps, pr->pe, left->start, right->end, " +
      "text-left->text-start, text-right->text-end, border-l->border-s, " +
      "border-r->border-e, rounded-l->rounded-s, rounded-r->rounded-e.",
  );
  process.exit(1);
}
console.log("apps/landing: no physical-direction classes.");
