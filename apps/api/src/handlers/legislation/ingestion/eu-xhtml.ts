import { Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { isTag, isText, Text } from "domhandler";
import type { AnyNode } from "domhandler";

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
}> {}

/** Validate nesting before invoking recursive DOM and inline utilities. */
export const checkEuPublisherMarkup = (html: string): EuXhtmlError | null => {
  if (Buffer.byteLength(html, "utf-8") > MAX_BYTES) {
    return new EuXhtmlError({
      message: "EU XHTML exceeds the byte limit",
      reason: "limits",
    });
  }
  const stack: string[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/gu;
  let offset = 0;
  let count = 0;
  for (const token of html.matchAll(tokens)) {
    if (html.slice(offset, token.index).includes("<")) {
      return new EuXhtmlError({
        message: "Malformed EU XHTML markup",
        reason: "malformed",
      });
    }
    offset = token.index + token[0].length;
    count += 1;
    if (count > MAX_NODES) {
      return new EuXhtmlError({
        message: "EU XHTML exceeds the node limit",
        reason: "limits",
      });
    }
    const tag = token[0];
    if (tag.startsWith("<!") || tag.startsWith("<?")) {
      continue;
    }
    const name = /^<\/?([\w:.-]+)/u.exec(tag)?.at(1);
    if (tag.startsWith("</")) {
      if (stack.pop() !== name) {
        return new EuXhtmlError({
          message: "EU XHTML has mismatched tags",
          reason: "malformed",
        });
      }
      continue;
    }
    if (!tag.endsWith("/>")) {
      stack.push(name ?? "");
      if (stack.length > MAX_DEPTH) {
        return new EuXhtmlError({
          message: "EU XHTML exceeds the nesting limit",
          reason: "limits",
        });
      }
    }
  }
  if (stack.length > 0 || html.slice(offset).includes("<")) {
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
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const span = Number(value);
  return Number.isSafeInteger(span) && span <= 1000 ? span : undefined;
};

const preparePublisherDom = ($: cheerio.CheerioAPI) => {
  const publisherAnchors = new Set<string>();
  let nodeCount = 1;
  // XML indentation is HTML layout whitespace, not a legal text line break.
  for (const element of $("*").toArray()) {
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
      if (child.type === "cdata") {
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
