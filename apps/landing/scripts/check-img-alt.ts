#!/usr/bin/env bun
import { panic } from "better-result";
// Every <img> in the landing source must carry an explicit alt attribute.
// An empty alt (alt="") is valid and deliberate for decorative images — the
// dark-theme poster duplicates and frame chrome — but an ABSENT attribute is
// not: screen readers fall back to the file name and image search indexes
// nothing. This lives here rather than in the linter because most landing
// templates are .astro files, which the linter does not parse; .tsx islands
// and published Markdown are scanned by the same rule for one consistent gate.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.join(import.meta.dir, "..", "src");
const BLOG_ROOT = path.join(SRC_ROOT, "content", "blog");
const COMPONENT_EXTENSIONS = [".astro", ".tsx"];
const MARKDOWN_EXTENSIONS = [".md"];

const sourceFiles = (dir: string, extensions: readonly string[]): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension))
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

export type SourceSyntax = "astro" | "markdown" | "tsx";

const frontmatterEnd = (source: string): number | undefined => {
  if (!source.startsWith("---\n")) {
    return undefined;
  }
  const close = source.indexOf("\n---\n", 4);
  return close === -1 ? source.length : close + 5;
};

const maskMarkupComments = (
  source: string,
  masked: string[],
  start: number,
  includeAstroComments: boolean,
): void => {
  let inTag = false;
  let quote: string | undefined;
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (masked[index] !== character) {
      index += 1;
      continue;
    }
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
    if (inTag) {
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === ">") {
        inTag = false;
      }
      index += 1;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      const end = close === -1 ? source.length : close + 3;
      maskRange({ masked, source, start: index, end });
      index = end;
      continue;
    }
    if (includeAstroComments && source.startsWith("{/*", index)) {
      const close = source.indexOf("*/}", index + 3);
      const end = close === -1 ? source.length : close + 3;
      maskRange({ masked, source, start: index, end });
      index = end;
      continue;
    }
    if (character === "<") {
      inTag = true;
    }
    index += 1;
  }
};

const maskAstroComments = (source: string, masked: string[]): void => {
  const end = frontmatterEnd(source);
  if (end !== undefined) {
    maskRange({ masked, source, start: 0, end });
  }
  for (const name of ["script", "style"]) {
    const content = source.slice(end ?? 0);
    let coveredUntil = end ?? 0;
    for (const { offset, tag } of openingTags(content, name)) {
      const start = (end ?? 0) + offset;
      if (start < coveredUntil) {
        continue;
      }
      const close = source.indexOf(`</${name}>`, start + tag.length);
      const elementEnd = close === -1 ? source.length : close + name.length + 3;
      maskRange({ masked, source, start, end: elementEnd });
      coveredUntil = elementEnd;
    }
  }
  maskMarkupComments(source, masked, end ?? 0, true);
};

const maskMarkdownCode = (
  source: string,
  masked: string[],
  start: number,
): void => {
  let fenceCharacter: string | undefined;
  let fenceLength = 0;
  let index = start;
  while (index < source.length) {
    const lineEnd = source.indexOf("\n", index);
    const end = lineEnd === -1 ? source.length : lineEnd + 1;
    let markerStart = index;
    while (
      markerStart < index + 4 &&
      (source[markerStart] === " " || source[markerStart] === "\t")
    ) {
      markerStart += 1;
    }
    const marker = source[markerStart];
    if (marker === "`" || marker === "~") {
      let markerEnd = markerStart;
      while (source[markerEnd] === marker) {
        markerEnd += 1;
      }
      const markerLength = markerEnd - markerStart;
      if (fenceCharacter === undefined && markerLength >= 3) {
        fenceCharacter = marker;
        fenceLength = markerLength;
        maskRange({ masked, source, start: index, end });
        index = end;
        continue;
      }
      if (fenceCharacter === marker && markerLength >= fenceLength) {
        maskRange({ masked, source, start: index, end });
        fenceCharacter = undefined;
        fenceLength = 0;
        index = end;
        continue;
      }
    }
    if (fenceCharacter !== undefined) {
      maskRange({ masked, source, start: index, end });
    }
    index = end;
  }

  const pendingDelimiters = new Map<number, number>();
  index = start;
  while (index < source.length) {
    if (masked[index] === " ") {
      index += 1;
      continue;
    }
    if (source[index] !== "`") {
      index += 1;
      continue;
    }
    let delimiterEnd = index;
    while (source[delimiterEnd] === "`") {
      delimiterEnd += 1;
    }
    const delimiterLength = delimiterEnd - index;
    const opening = pendingDelimiters.get(delimiterLength);
    if (opening === undefined) {
      pendingDelimiters.set(delimiterLength, index);
    } else {
      maskRange({ masked, source, start: opening, end: delimiterEnd });
      pendingDelimiters.clear();
    }
    index = delimiterEnd;
  }
};

const maskMarkdownComments = (source: string, masked: string[]): void => {
  const end = frontmatterEnd(source);
  if (end !== undefined) {
    maskRange({ masked, source, start: 0, end });
  }
  const contentStart = end ?? 0;
  maskMarkdownCode(source, masked, contentStart);
  maskMarkupComments(source, masked, contentStart, false);
};

const maskTsxComments = (source: string, masked: string[]): void => {
  let mode: "code" | "double" | "single" | "template" = "code";
  const templateExpressionDepths: number[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (mode === "single" || mode === "double") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (
        (mode === "single" && character === "'") ||
        (mode === "double" && character === '"')
      ) {
        mode = "code";
      }
      index += 1;
      continue;
    }
    if (mode === "template") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "`") {
        mode = "code";
        index += 1;
        continue;
      }
      if (character === "$" && source[index + 1] === "{") {
        templateExpressionDepths.push(1);
        mode = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "'") {
      mode = "single";
      index += 1;
      continue;
    }
    if (character === '"') {
      mode = "double";
      index += 1;
      continue;
    }
    if (character === "`") {
      mode = "template";
      index += 1;
      continue;
    }
    if (templateExpressionDepths.length > 0) {
      const depthIndex = templateExpressionDepths.length - 1;
      if (character === "{") {
        templateExpressionDepths[depthIndex] += 1;
      } else if (character === "}") {
        templateExpressionDepths[depthIndex] -= 1;
        if (templateExpressionDepths[depthIndex] === 0) {
          templateExpressionDepths.pop();
          mode = "template";
          index += 1;
          continue;
        }
      }
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      const end = newline === -1 ? source.length : newline;
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
};

/** Non-rendered source can mention a bare `<img>`; mask it before scanning. */
export const maskComments = (
  source: string,
  syntax: SourceSyntax = "astro",
): string => {
  const masked = source.split("");
  switch (syntax) {
    case "astro":
      maskAstroComments(source, masked);
      break;
    case "markdown":
      maskMarkdownComments(source, masked);
      break;
    case "tsx":
      maskTsxComments(source, masked);
      break;
    default: {
      syntax satisfies never;
      return panic(`Unhandled syntax: ${String(syntax)}`);
    }
  }
  return masked.join("");
};

const isWhitespace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f";

type OpeningTag = { offset: number; tag: string };

export const openingTags = (source: string, name: string): OpeningTag[] => {
  const tags: OpeningTag[] = [];
  const opening = `<${name}`;
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const offset = source.indexOf(opening, searchFrom);
    if (offset === -1) {
      return tags;
    }

    const boundary = source[offset + opening.length];
    if (!isWhitespace(boundary) && boundary !== "/" && boundary !== ">") {
      searchFrom = offset + opening.length;
      continue;
    }

    let braceDepth = 0;
    let quote: string | undefined;
    let index = offset + opening.length;
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

export const imageTags = (source: string): OpeningTag[] =>
  openingTags(source, "img");

const expressionEnd = (tag: string, start: number): number => {
  let depth = 0;
  let quote: string | undefined;
  let index = start;
  while (index < tag.length) {
    const character = tag[index];
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
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return index;
};

export const literalAttribute = (
  tag: string,
  attributeName: string,
): string | undefined => {
  let index = 1;
  while (
    index < tag.length &&
    !isWhitespace(tag[index]) &&
    tag[index] !== "/" &&
    tag[index] !== ">"
  ) {
    index += 1;
  }
  while (index < tag.length) {
    while (isWhitespace(tag[index])) {
      index += 1;
    }
    if (tag[index] === "/" || tag[index] === ">") {
      return undefined;
    }
    const nameStart = index;
    while (
      index < tag.length &&
      !isWhitespace(tag[index]) &&
      tag[index] !== "=" &&
      tag[index] !== "/" &&
      tag[index] !== ">"
    ) {
      index += 1;
    }
    const name = tag.slice(nameStart, index);
    while (isWhitespace(tag[index])) {
      index += 1;
    }
    if (tag[index] !== "=") {
      continue;
    }
    index += 1;
    while (isWhitespace(tag[index])) {
      index += 1;
    }
    const quote = tag[index];
    if (quote !== '"' && quote !== "'") {
      if (name === attributeName) {
        return undefined;
      }
      if (quote === "{") {
        index = expressionEnd(tag, index);
      } else {
        while (
          index < tag.length &&
          !isWhitespace(tag[index]) &&
          tag[index] !== ">"
        ) {
          index += 1;
        }
      }
      continue;
    }
    const valueStart = index + 1;
    index = valueStart;
    while (index < tag.length && tag[index] !== quote) {
      if (tag[index] === "\\") {
        index += 2;
      } else {
        index += 1;
      }
    }
    if (name === attributeName) {
      return tag.slice(valueStart, index);
    }
    index += 1;
  }
  return undefined;
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

const sourceSyntaxFor = (file: string): SourceSyntax => {
  const extension = path.extname(file);
  if (extension === ".md") {
    return "markdown";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  return "astro";
};

const main = (): void => {
  const failures: string[] = [];
  const files = [
    ...sourceFiles(SRC_ROOT, COMPONENT_EXTENSIONS),
    ...sourceFiles(BLOG_ROOT, MARKDOWN_EXTENSIONS),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const masked = maskComments(source, sourceSyntaxFor(file));
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
