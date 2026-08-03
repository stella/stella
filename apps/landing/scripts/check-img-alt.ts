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

type MaskRangeOptions = {
  masked: string[];
  source: string;
  start: number;
  end: number;
};

const maskRange = ({ masked, source, start, end }: MaskRangeOptions): void => {
  for (let index = start; index < end; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") {
      masked[index] = " ";
    }
  }
};

/** Comments can legitimately mention a bare `<img>`; mask them before scanning. */
export const maskComments = (source: string): string => {
  const masked = source.split("");
  let index = 0;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === "\n") {
      let commentStart = index;
      while (source[commentStart] === " " || source[commentStart] === "\t") {
        commentStart += 1;
      }
      if (source.startsWith("//", commentStart)) {
        const newline = source.indexOf("\n", commentStart + 2);
        const end = newline === -1 ? source.length : newline;
        maskRange({ masked, source, start: index, end });
        index = end;
        continue;
      }
    }

    if (source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      const end = close === -1 ? source.length : close + 3;
      maskRange({ masked, source, start: index, end });
      index = end;
      continue;
    }

    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      maskRange({ masked, source, start: index, end });
      index = end;
      continue;
    }

    index += 1;
  }
  return masked.join("");
};

const isWhitespace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f";

type ImageTag = { offset: number; tag: string };

export const imageTags = (source: string): ImageTag[] => {
  const tags: ImageTag[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const offset = source.indexOf("<img", searchFrom);
    if (offset === -1) {
      return tags;
    }

    const boundary = source[offset + 4];
    if (!isWhitespace(boundary) && boundary !== "/" && boundary !== ">") {
      searchFrom = offset + 4;
      continue;
    }

    let braceDepth = 0;
    let quote: string | undefined;
    let index = offset + 4;
    while (index < source.length) {
      const character = source[index];
      if (quote !== undefined) {
        if (character === "\\") {
          index += 2;
          continue;
        }
        if (character === quote) {
          quote = undefined;
        }
        index += 1;
        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === "{") {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (character === "}" && braceDepth > 0) {
        braceDepth -= 1;
        index += 1;
        continue;
      }
      if (character === ">" && braceDepth === 0) {
        tags.push({ offset, tag: source.slice(offset, index + 1) });
        searchFrom = index + 1;
        break;
      }
      index += 1;
    }

    if (index === source.length) {
      return tags;
    }
  }
  return tags;
};

export const hasExplicitAlt = (tag: string): boolean => {
  let braceDepth = 0;
  let quote: string | undefined;
  for (let index = 4; index < tag.length; index += 1) {
    const character = tag[index];
    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      continue;
    }
    if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (braceDepth > 0 || !isWhitespace(character)) {
      continue;
    }

    let attributeStart = index + 1;
    while (isWhitespace(tag[attributeStart])) {
      attributeStart += 1;
    }
    if (!tag.startsWith("alt", attributeStart)) {
      continue;
    }
    let equals = attributeStart + 3;
    while (isWhitespace(tag[equals])) {
      equals += 1;
    }
    if (tag[equals] === "=") {
      return true;
    }
  }
  return false;
};

const main = (): void => {
  const failures: string[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf-8");
    const masked = maskComments(source);
    for (const { offset, tag } of imageTags(masked)) {
      // A spread ({...props}) can carry alt; that shape is not statically
      // checkable here, so it is trusted and skipped.
      if (hasExplicitAlt(tag) || tag.includes("{...")) {
        continue;
      }
      const line = source.slice(0, offset).split("\n").length;
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
};

if (import.meta.main) {
  main();
}
