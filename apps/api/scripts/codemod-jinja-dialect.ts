#!/usr/bin/env bun
/**
 * One-shot codemod from the old `{{#each}}` / `{{#if}}` / `{{@...}}` marker
 * dialect to the docxtpl dialect of Jinja.
 *
 * The rewrite is the same for every carrier — a `.docx` part, a TypeScript
 * fixture, a JSON seed — because it is one function over marker text
 * ({@link migrateMarkerText}). Only the way the text is reached differs: a
 * document goes through the run-preserving patcher so a marker Word split
 * across runs is rewritten without touching formatting, while a source file is
 * plain text.
 *
 * Loop bodies are the only context-sensitive part: `{{#each deliverables}}`
 * becomes `{% for deliverable in deliverables %}`, so every `{{deliverables.x}}`
 * inside that loop becomes `{{ deliverable.x }}`. The scan therefore carries a
 * loop stack in document order.
 *
 * Usage:
 *   bun apps/api/scripts/codemod-jinja-dialect.ts <path> [<path> …]
 *   bun apps/api/scripts/codemod-jinja-dialect.ts --check <path>
 */

import JSZip from "jszip";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as slimdom from "slimdom";

import {
  legacyLoopAlias,
  markerPattern,
  normalizeMarkerInner,
  translateLegacyExpression,
} from "@stll/template-conditions";

import { templateContentPartPaths, W_NS } from "@/api/lib/docx/ooxml";
import {
  paragraphSpanText,
  replaceParagraphTextRanges,
} from "@/api/lib/docx/rich-patch";

/** One enclosing old-dialect loop and the alias its body now uses. */
type LoopFrame = { alias: string; path: string };

type MarkerRange = { start: number; end: number; value: string };

const LEGACY_BLOCK_RE =
  /^(?<token>#if|#elseif|#else|#each|\/if|\/each)\b(?<expr>[\s\S]*)$/u;
const LEGACY_CLAUSE_RE =
  /^@clause:(?<name>[^:}\s]+)(?::(?<version>[^}\s]+))?$/u;
const LEGACY_NUMBERING_RE = /^@(?<fn>num|ref):(?<key>[\p{L}\p{N}_.-]+)$/u;
const FIELD_PATH_RE = /^[\p{L}\p{N}_.-]+$/u;

/** Rewrite every `path.`-prefixed reference to the loop alias that now owns it,
 *  innermost loop first. */
const aliasPath = (reference: string, stack: readonly LoopFrame[]): string => {
  for (const { alias, path: loopPath } of stack.toReversed()) {
    if (reference === loopPath) {
      return alias;
    }
    if (reference.startsWith(`${loopPath}.`)) {
      return `${alias}.${reference.slice(loopPath.length + 1)}`;
    }
  }
  return reference;
};

/** Translate an old condition expression: the operators change, and item paths
 *  take the loop alias. */
const migrateExpression = (expr: string, stack: readonly LoopFrame[]): string =>
  translateLegacyExpression(expr).replace(
    /(?<!["\p{L}\p{N}_.-])(?<path>[\p{L}_][\p{L}\p{N}_.-]*)/gu,
    (_match, reference: string) => aliasPath(reference, stack),
  );

/** The Jinja replacement for one marker's inner text, given the loops it sits
 *  inside. Returns `null` when the marker is already current. */
const migrateMarker = (innerRaw: string, stack: LoopFrame[]): string | null => {
  const inner = normalizeMarkerInner(innerRaw).trim();

  const block = LEGACY_BLOCK_RE.exec(inner);
  if (block) {
    const token = block.groups?.["token"] ?? "";
    const expr = (block.groups?.["expr"] ?? "").trim();
    switch (token) {
      // An empty expression is prose naming the marker pair ("{{#if}} and
      // {{/if}}"), not a directive over a path: rename it and open no frame.
      case "#if":
        return expr === ""
          ? "{% if %}"
          : `{% if ${migrateExpression(expr, stack)} %}`;
      case "#elseif":
        return expr === ""
          ? "{% elif %}"
          : `{% elif ${migrateExpression(expr, stack)} %}`;
      case "#else":
        return "{% else %}";
      case "/if":
        return "{% endif %}";
      case "#each": {
        if (expr === "") {
          return "{% for %}";
        }
        // A source file is not a document: its loops need not balance across
        // the whole file (a test naming `{{#each x}}` without its closer leaves
        // a frame open). A loop can never nest inside a loop over the same
        // path, so re-entering one closes it rather than aliasing against it.
        const reopened = stack.findIndex((frame) => frame.path === expr);
        if (reopened !== -1) {
          stack.length = reopened;
        }
        const loopPath = aliasPath(expr, stack);
        const alias = legacyLoopAlias(expr);
        stack.push({ alias, path: expr });
        return `{% for ${alias} in ${loopPath} %}`;
      }
      case "/each":
        stack.pop();
        return "{% endfor %}";
      default:
        return null;
    }
  }

  const clause = LEGACY_CLAUSE_RE.exec(inner);
  if (clause) {
    const name = clause.groups?.["name"] ?? "";
    const version = clause.groups?.["version"];
    return version === undefined
      ? `{{ clause("${name}") }}`
      : `{{ clause("${name}", "${version}") }}`;
  }

  const numbering = LEGACY_NUMBERING_RE.exec(inner);
  if (numbering) {
    const fn = numbering.groups?.["fn"] ?? "";
    return `{{ ${fn}("${numbering.groups?.["key"] ?? ""}") }}`;
  }

  if (inner === "@index") {
    return "{{ loop.index }}";
  }
  if (inner === "@count") {
    return "{{ loop.length }}";
  }

  if (FIELD_PATH_RE.test(inner) && stack.length > 0) {
    const aliased = aliasPath(inner, stack);
    return aliased === inner ? null : `{{ ${aliased} }}`;
  }

  return null;
};

/**
 * The ranges of `text` that change, given the loops open before it. Mutates
 * `stack` so a caller scanning paragraph by paragraph keeps loop context
 * across paragraph boundaries.
 */
export const migrateMarkerRanges = (
  text: string,
  stack: LoopFrame[],
): MarkerRange[] => {
  const ranges: MarkerRange[] = [];
  const re = markerPattern();
  let match = re.exec(text);
  while (match !== null) {
    const inner = match.groups?.["output"];
    if (inner !== undefined) {
      const value = migrateMarker(inner, stack);
      if (value !== null) {
        ranges.push({
          start: match.index,
          end: match.index + match[0].length,
          value,
        });
      }
    }
    match = re.exec(text);
  }
  return ranges;
};

/**
 * The string-literal quote a source line has open at `offset`, or `null`
 * outside a literal. A marker in a source file is written inside one, and the
 * dialect accepts either quote around a function argument, so the rewrite picks
 * the one the carrier is not already using rather than emitting an escape the
 * surrounding syntax may not allow (JSON has no `\'`, a template literal has no
 * enclosing quote at all).
 */
const enclosingQuote = (text: string, offset: number): string | null => {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let quote: string | null = null;
  for (let i = lineStart; i < offset; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      continue;
    }
    if (quote === null) {
      quote = ch;
    } else if (quote === ch) {
      quote = null;
    }
  }
  return quote;
};

/**
 * Whether a marker span can be rewritten where it sits in a source file. A
 * test that proves split-run handling deliberately writes half a marker in one
 * string literal and half in the next; the file text joins them, but the file
 * is not a document, and rewriting across that seam would corrupt the source.
 * A span that crosses a line or re-opens its own enclosing quote is left for a
 * human.
 */
const isRewritableInSource = (
  text: string,
  start: number,
  end: number,
  quote: string | null,
): boolean => {
  const withinSpan = (needle: string): boolean => {
    const at = text.indexOf(needle, start);
    return at !== -1 && at < end;
  };
  if (withinSpan("\n")) {
    return false;
  }
  return quote === null || quote === "`" || !withinSpan(quote);
};

/** Apply {@link migrateMarkerRanges} to a plain string. */
export const migrateMarkerText = (
  text: string,
  stack: LoopFrame[] = [],
): string => {
  const ranges = migrateMarkerRanges(text, stack);
  let out = "";
  let cursor = 0;
  for (const { end, start, value } of ranges) {
    const quote = enclosingQuote(text, start);
    if (!isRewritableInSource(text, start, end, quote)) {
      continue;
    }
    out +=
      text.slice(cursor, start) +
      (quote === '"' ? value.replaceAll('"', "'") : value);
    cursor = end;
  }
  return out + text.slice(cursor);
};

/** Rewrite every content part of a `.docx`, preserving runs. */
export const migrateDocx = async (bytes: Buffer): Promise<Buffer | null> => {
  const zip = await JSZip.loadAsync(bytes);
  let changed = false;

  for (const partName of templateContentPartPaths(Object.keys(zip.files))) {
    const entry = zip.file(partName);
    if (!entry) {
      continue;
    }
    const xml = await entry.async("string");
    if (!xml.includes("{{")) {
      continue;
    }
    const doc = slimdom.parseXmlDocument(xml);
    const stack: LoopFrame[] = [];
    let partChanged = false;
    for (const paragraph of doc.getElementsByTagNameNS(W_NS, "p")) {
      const ranges = migrateMarkerRanges(paragraphSpanText(paragraph), stack);
      if (ranges.length === 0) {
        continue;
      }
      replaceParagraphTextRanges(paragraph, ranges);
      partChanged = true;
    }
    if (partChanged) {
      zip.file(partName, slimdom.serializeToWellFormedString(doc));
      changed = true;
    }
  }

  return changed
    ? Buffer.from(await zip.generateAsync({ type: "nodebuffer" }))
    : null;
};

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".txt",
  ".xml",
]);

const isTextFile = (file: string): boolean =>
  TEXT_EXTENSIONS.has(path.extname(file));

const walk = async (dir: string): Promise<string[]> => {
  const info = await stat(dir);
  if (!info.isDirectory()) {
    return [dir];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    files.push(...(await walk(path.join(dir, entry.name))));
  }
  return files;
};

const migrateFile = async (file: string, check: boolean): Promise<boolean> => {
  if (file.endsWith(".docx")) {
    const migrated = await migrateDocx(await readFile(file));
    if (migrated === null) {
      return false;
    }
    if (!check) {
      await writeFile(file, migrated);
    }
    return true;
  }
  if (!isTextFile(file)) {
    return false;
  }
  const text = await readFile(file, "utf-8");
  if (!text.includes("{{")) {
    return false;
  }
  const migrated = migrateMarkerText(text);
  if (migrated === text) {
    return false;
  }
  if (!check) {
    await writeFile(file, migrated, "utf-8");
  }
  return true;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const paths = args.filter((arg) => arg !== "--check");
  if (paths.length === 0) {
    process.stderr.write(
      "usage: codemod-jinja-dialect.ts [--check] <path> [<path> …]\n",
    );
    process.exitCode = 1;
    return;
  }

  const touched: string[] = [];
  for (const target of paths) {
    for (const file of await walk(target)) {
      if (await migrateFile(file, check)) {
        touched.push(file);
      }
    }
  }

  for (const file of touched) {
    process.stdout.write(`${check ? "would rewrite" : "rewrote"} ${file}\n`);
  }
  process.stdout.write(`${touched.length} file(s)\n`);
  if (check && touched.length > 0) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
