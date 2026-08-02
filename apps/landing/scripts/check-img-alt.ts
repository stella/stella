#!/usr/bin/env bun
// Every <img> in the landing source must carry an explicit alt attribute.
// An empty alt (alt="") is valid and deliberate for decorative images — the
// dark-theme poster duplicates and frame chrome — but an ABSENT attribute is
// not: screen readers fall back to the file name and image search indexes
// nothing. This lives here rather than in the linter because most landing
// templates are .astro files, which the linter does not parse; .tsx islands
// are scanned by the same rule for one consistent gate.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.join(import.meta.dir, "..", "src");
const EXTENSIONS = [".astro", ".tsx"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext))
      ? [entryPath]
      : [];
  });

/** Comments can legitimately mention a bare `<img>`; strip them before scanning. */
const stripComments = (source: string): string =>
  source
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");

const failures: string[] = [];
for (const file of sourceFiles(SRC_ROOT)) {
  const source = readFileSync(file, "utf-8");
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(/<img\b[^>]*>/gu)) {
    const tag = match[0];
    // A spread ({...props}) can carry alt; that shape is not statically
    // checkable here, so it is trusted and skipped.
    if (/\balt=/u.test(tag) || tag.includes("{...")) {
      continue;
    }
    const offset = source.indexOf(tag);
    const line =
      offset === -1 ? "?" : source.slice(0, offset).split("\n").length;
    failures.push(
      `${file.slice(SRC_ROOT.length + 1)}:${line}: <img> without an alt attribute`,
    );
  }
}

if (failures.length > 0) {
  console.error(`img alt: ${failures.length} violation(s)`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log("img alt: all <img> elements carry an explicit alt attribute");
