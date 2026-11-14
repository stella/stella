import { Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { isCDATA, isTag, isText, Text } from "domhandler";
import type { AnyNode } from "domhandler";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { declareFingerprintFields } from "@stll/errors";
import {
  projectPlainText,
  withProjectedPlainText,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAstSource,
  Inline,
} from "@stll/legal-ast/document-ast";

import {
  ownTableRows,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import { EU_CELLAR_LIMITS } from "./eu-cellar-limits";

const {
  documentBytes: MAX_BYTES,
  domNodes: MAX_NODES,
  xmlDepth: MAX_DEPTH,
} = EU_CELLAR_LIMITS;

export class EuXhtmlError extends TaggedError("EuXhtmlError")<{
  message: string;
  reason: "limits" | "malformed" | "unsupported-layout" | "empty";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const isAsciiLetter = (code: number | undefined) =>
  code !== undefined &&
  ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
const isTagNameCharacter = (code: number | undefined) =>
  code !== undefined &&
  (isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 58 ||
    code === 46 ||
    code === 45);

const PUBLISHER_DECLARATIONS = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
  ["<!DOCTYPE", ">"],
] as const;

/** Consume one token once; failed quoted attributes cannot rescan the suffix. */
const scanPublisherToken = (html: string, start: number) => {
  for (const [prefix, terminator] of PUBLISHER_DECLARATIONS) {
    if (!html.startsWith(prefix, start)) {
      continue;
    }
    const end = html.indexOf(terminator, start + prefix.length);
    return end === -1
      ? null
      : { type: "declaration" as const, end: end + terminator.length };
  }

  const closing = html[start + 1] === "/";
  let cursor = start + (closing ? 2 : 1);
  if (!isAsciiLetter(html.codePointAt(cursor))) {
    return null;
  }
  const nameStart = cursor;
  cursor += 1;
  while (isTagNameCharacter(html.codePointAt(cursor))) {
    cursor += 1;
  }
  const name = html.slice(nameStart, cursor);
  let quote: '"' | "'" | null = null;
  for (; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "<") {
      return null;
    }
    if (character === ">") {
      return {
        type: closing ? ("close" as const) : ("open" as const),
        name,
        end: cursor + 1,
        selfClosing: html[cursor - 1] === "/",
      };
    }
  }
  return null;
};

/** Validate nesting before invoking recursive DOM and inline utilities. */
export const checkEuPublisherMarkup = (html: string): EuXhtmlError | null => {
  if (Buffer.byteLength(html, "utf-8") > MAX_BYTES) {
    return new EuXhtmlError({
      message: "EU XHTML exceeds the byte limit",
      reason: "limits",
    });
  }
  const stack: string[] = [];
  let offset = 0;
  let count = 0;
  for (
    let start = html.indexOf("<", offset);
    start !== -1;
    start = html.indexOf("<", offset)
  ) {
    const token = scanPublisherToken(html, start);
    if (token === null) {
      return new EuXhtmlError({
        message: "Malformed EU XHTML markup",
        reason: "malformed",
      });
    }
    offset = token.end;
    count += 1;
    if (count > MAX_NODES) {
      return new EuXhtmlError({
        message: "EU XHTML exceeds the node limit",
        reason: "limits",
      });
    }
    if (token.type === "declaration") {
      continue;
    }
    if (token.type === "close") {
      if (stack.pop() !== token.name) {
        return new EuXhtmlError({
          message: "EU XHTML has mismatched tags",
          reason: "malformed",
        });
      }
      continue;
    }
    if (!token.selfClosing) {
      stack.push(token.name);
      if (stack.length > MAX_DEPTH) {
        return new EuXhtmlError({
          message: "EU XHTML exceeds the nesting limit",
          reason: "limits",
        });
      }
    }
  }
  if (stack.length > 0) {
    return new EuXhtmlError({
      message: "EU XHTML is truncated",
      reason: "malformed",
    });
  }
  return null;
};

const inlineOptions = {
  parseImgAlt: true,
  emphasisClasses: {
    bold: ["oj-bold", "boldface"],
    italic: ["oj-italic", "italics"],
  },
};

const positiveSpan = (value: string | undefined): number | undefined => {
  if (value === undefined || value.startsWith("0")) {
    return undefined;
  }
  return parseIntegerToken(value, {
    sign: "unsigned",
    min: 1,
    max: 1000,
  }).unwrapOr(undefined);
};

const preparePublisherDom = ($: cheerio.CheerioAPI) => {
  const publisherAnchors = new Set<string>();
  let nodeCount = 1;
  // XML indentation is HTML layout whitespace, not a legal text line break.
  for (const element of $("*").toArray().filter(isTag)) {
    nodeCount += element.children.length;
    if (nodeCount > MAX_NODES) {
      return Result.err(
        new EuXhtmlError({
          message: "EU XHTML exceeds the node limit",
          reason: "limits",
        }),
      );
    }
    const publisherAnchor = $(element).attr("id");
    if (publisherAnchor !== undefined) {
      publisherAnchors.add(publisherAnchor);
    }
    for (const [index, child] of element.children.entries()) {
      if (isCDATA(child)) {
        const text = child.children
          .filter(isText)
          .map((part) => part.data)
          .join("");
        const replacement = new Text(text.replace(/\s+/gu, " "));
        replacement.parent = child.parent;
        replacement.prev = child.prev;
        replacement.next = child.next;
        if (child.prev !== null) {
          child.prev.next = replacement;
        }
        if (child.next !== null) {
          child.next.prev = replacement;
        }
        element.children[index] = replacement;
      }
      if (isText(child)) {
        child.data = child.data.replace(/\s+/gu, " ");
      }
    }
  }
  return Result.ok(publisherAnchors);
};

type ParseEuXhtmlOptions = { html: string; source: DocumentAstSource };

/** Display/text normalization only; publisher dates do not become validity windows. */
export const parseEuXhtml = ({ html, source }: ParseEuXhtmlOptions) => {
  const defect = checkEuPublisherMarkup(html);
  if (defect !== null) {
    return Result.err(defect);
  }
  const $ = cheerio.load(html, { xml: true });
  const prepared = preparePublisherDom($);
  if (prepared.isErr()) {
    return Result.err(prepared.error);
  }
  const publisherAnchors = prepared.value;
  const roots = $(".eli-container").filter(
    (_, element) =>
      $(element).parents(".eli-container, script, style").length === 0,
  );
  if (roots.length === 0) {
    return Result.err(
      new EuXhtmlError({
        message: "EU XHTML has no publisher text container",
        reason: "unsupported-layout",
      }),
    );
  }
  const options = {
    ...inlineOptions,
    sanitizeHref: (href: string) =>
      URL.canParse(href, source.webUrl)
        ? sanitizeUrl(new URL(href, source.webUrl).href)
        : undefined,
  };
  const blocks: Block[] = [];
  const anchors = new Set<string>();
  let sequence = 0;
  const identity = (candidate: string | undefined) => {
    sequence += 1;
    while (publisherAnchors.has(`eu-block-${sequence}`)) {
      sequence += 1;
    }
    const id = `eu-block-${sequence}`;
    const anchorId =
      candidate !== undefined && !anchors.has(candidate) ? candidate : id;
    anchors.add(anchorId);
    return { id, anchorId };
  };
  type EmitBlockOptions = {
    inlines: Inline[];
    anchor: string | undefined;
    type: "heading" | "paragraph";
  };
  const emit = ({ inlines, anchor, type }: EmitBlockOptions) => {
    const plainText = projectPlainText(inlines);
    if (plainText.length === 0) {
      return;
    }
    const common = { ...identity(anchor), inlines, plainText };
    blocks.push(
      type === "heading"
        ? { ...common, type: "heading", level: 2 }
        : { ...common, type: "paragraph" },
    );
  };
  const walk = (node: AnyNode, inheritedAnchor?: string) => {
    if (isText(node)) {
      emit({
        inlines: [{ type: "text", text: node.data }],
        anchor: inheritedAnchor,
        type: "paragraph",
      });
      return;
    }
    if (!isTag(node) || node.name === "script" || node.name === "style") {
      return;
    }
    const element = $(node);
    const anchor = element.attr("id") ?? inheritedAnchor;
    if (node.name === "img") {
      const alt = element.attr("alt");
      if (alt !== undefined) {
        emit({
          inlines: [{ type: "text", text: alt }],
          anchor,
          type: "paragraph",
        });
      }
      return;
    }
    if (node.name === "table") {
      element.children("caption").each((_, caption) => walk(caption));
      const rows = ownTableRows(element)
        .toArray()
        .map((row) =>
          $(row)
            .children("td, th")
            .toArray()
            .map((cell) => {
              const content = $(cell).clone();
              // Block boundaries inside a cell must not weld adjacent legal words.
              content.find("p, div, tr").append("<br/>");
              const inlines = walkInlines($, content, options);
              return {
                inlines,
                plainText: projectPlainText(inlines),
                colSpan: positiveSpan($(cell).attr("colspan")),
                rowSpan: positiveSpan($(cell).attr("rowspan")),
                ...($(cell).is("th") ? { header: true as const } : {}),
              };
            }),
        );
      if (rows.some((row) => row.some((cell) => cell.plainText.length > 0))) {
        blocks.push({
          ...identity(anchor),
          type: "table",
          rows,
          plainText: "",
        });
      }
      return;
    }
    const heading = element.is(
      ".oj-ti-art, .title-article-norm, .oj-sti-art, .stitle-article-norm, .oj-ti-grseq-1, .oj-ti-section-1, .oj-ti-section-2, .title-division-1, .title-division-2, .oj-doc-ti, .title-doc-first, .title-doc-last",
    );
    const terminal =
      node.name === "p" ||
      heading ||
      element.hasClass("norm") ||
      element.hasClass("grid-list");
    if (terminal) {
      const content = element.clone();
      content.find("p, div").append("<br/>");
      emit({
        inlines: walkInlines($, content, options),
        anchor:
          inheritedAnchor !== undefined && !anchors.has(inheritedAnchor)
            ? inheritedAnchor
            : anchor,
        type: heading ? "heading" : "paragraph",
      });
      return;
    }
    for (const child of node.children) {
      walk(child, anchor);
    }
  };
  roots.each((_, root) => walk(root));
  const documentAst = withProjectedPlainText({
    version: 1,
    source,
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks,
  });
  const fulltext = documentAst.blocks
    .map((block) => block.plainText)
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (fulltext.trim().length === 0) {
    return Result.err(
      new EuXhtmlError({
        message: "EU XHTML contains no legal text",
        reason: "empty",
      }),
    );
  }
  return Result.ok({ documentAst, fulltext });
};
