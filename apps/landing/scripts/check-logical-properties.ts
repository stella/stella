#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hasPhysicalProperty } from "../../../.oxlint-plugins/physical-properties";

// oxlint cannot parse `.astro` template class attributes, and the
// no-physical-properties oxlint rule is scoped to apps/web / packages/ui /
// packages/folio `.tsx`. This scans the landing's own source for the same
// physical directional classes (so RTL stays correct), reusing the rule's
// patterns from one shared source rather than duplicating them.

const QUOTES = new Set(['"', "'", "`"]);
const CLASS_ATTRIBUTE_PATTERN = /\bclass(?:Name|:list)?\s*=\s*/gu;

export type Finding = { line: number; text: string };

/**
 * The class attribute value starting at `start`: a quoted string, or a brace
 * expression read to its matching close (string literals inside are skipped so
 * a `}` in a class name cannot end the span early).
 */
const readAttributeValue = (
  source: string,
  start: number,
): string | undefined => {
  const opener = source[start];
  if (QUOTES.has(opener)) {
    const end = source.indexOf(opener, start + 1);
    return end === -1 ? undefined : source.slice(start, end + 1);
  }

  if (opener !== "{") {
    return undefined;
  }

  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (QUOTES.has(char)) {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return undefined;
};

/**
 * Two passes, deduplicated by line. Whole class attributes catch the wrapped
 * form a per-line scan structurally cannot see (`class:list={[` on one line,
 * `"ml-2",` on the next, so neither line carries both the attribute and a
 * utility). Individual lines mentioning `class` still catch utilities that
 * reach a class attribute indirectly, such as an object property or a variable
 * holding a class string.
 */
export const physicalPropertyFindings = (source: string): Finding[] => {
  const byLine = new Map<number, string>();

  for (const [index, line] of source.split("\n").entries()) {
    if (line.includes("class") && hasPhysicalProperty(line)) {
      byLine.set(index + 1, line);
    }
  }

  for (const match of source.matchAll(CLASS_ATTRIBUTE_PATTERN)) {
    const start = match.index + match[0].length;
    const value = readAttributeValue(source, start);
    if (value === undefined || !hasPhysicalProperty(value)) {
      continue;
    }
    const valueLines = value.split("\n");
    const offset = Math.max(
      valueLines.findIndex((line) => hasPhysicalProperty(line)),
      0,
    );
    byLine.set(
      source.slice(0, start).split("\n").length + offset,
      valueLines[offset] ?? value,
    );
  }

  return [...byLine]
    .toSorted(([left], [right]) => left - right)
    .map(([line, text]) => ({ line, text: text.trim().slice(0, 90) }));
};

const main = () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf-8" })
    .filter((file) => file.endsWith(".astro") || file.endsWith(".tsx"))
    .toSorted();

  let violations = 0;
  for (const relativePath of files) {
    const source = readFileSync(`${srcDir}${relativePath}`, "utf-8");
    for (const { line, text } of physicalPropertyFindings(source)) {
      console.log(`  src/${relativePath}:${line}  ${text}`);
      violations += 1;
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
};

if (import.meta.main) {
  main();
}
