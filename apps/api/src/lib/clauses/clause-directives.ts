import { Result } from "better-result";
import * as slimdom from "slimdom";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";
import {
  blockDirectiveLinePattern,
  scanMarkers,
} from "@stll/template-conditions";

import {
  parseBlockTree,
  scanBlockDirectives,
} from "@/api/lib/docx/block-directives";
import { parseInlineConditions } from "@/api/lib/docx/inline-conditions";
import { paragraphText, W_NS } from "@/api/lib/docx/ooxml";
import type { TemplateStructureError } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import type { ClauseBody } from "./types";

export const clauseDirectiveContainer = (body: ClauseBody): slimdom.Element => {
  const doc = new slimdom.Document();
  const container = doc.createElementNS(W_NS, "w:body");
  doc.append(container);
  for (const [index, paragraph] of body.entries()) {
    const element = doc.createElementNS(W_NS, "w:p");
    const paragraphProperties = doc.createElementNS(W_NS, "w:pPr");
    paragraphProperties.setAttribute("clause-origin", String(index));
    element.append(paragraphProperties);
    const sourceRuns = paragraph.isDirective
      ? [{ text: paragraph.text }]
      : (paragraph.runs ?? [{ text: paragraph.text }]);
    for (const run of sourceRuns) {
      const r = doc.createElementNS(W_NS, "w:r");
      const properties = doc.createElementNS(W_NS, "w:rPr");
      if (run.bold !== undefined) {
        const bold = doc.createElementNS(W_NS, "w:b");
        bold.setAttributeNS(W_NS, "w:val", run.bold ? "1" : "0");
        properties.append(bold);
      }
      if (run.italic !== undefined) {
        const italic = doc.createElementNS(W_NS, "w:i");
        italic.setAttributeNS(W_NS, "w:val", run.italic ? "1" : "0");
        properties.append(italic);
      }
      r.append(properties);
      const t = doc.createElementNS(W_NS, "w:t");
      t.textContent = run.text;
      r.append(t);
      element.append(r);
    }
    container.append(element);
  }

  return container;
};

/** Validate the complete authored tree before evaluating any branch or loop. */
export const validateClauseBodyDirectives = (
  body: ClauseBody,
): Result<void, HandlerError<422>> => {
  const container = clauseDirectiveContainer(body);
  const directives = scanBlockDirectives(container);
  const { errors } = parseBlockTree(directives);
  const directiveIndices = new Set(
    directives.map(({ paragraphIndex }) => paragraphIndex),
  );
  const issues: TemplateStructureError[] = [...errors];
  for (const [paragraphIndex, element] of [
    ...container.getElementsByTagNameNS(W_NS, "p"),
  ].entries()) {
    const text = paragraphText(element);
    const paragraph = body.at(paragraphIndex);
    if (
      (paragraph?.isDirective || blockDirectiveLinePattern().test(text)) &&
      !directiveIndices.has(paragraphIndex)
    ) {
      issues.push({
        paragraphIndex,
        directive: text,
        message:
          "Directive text must be a literal whole-paragraph {% ... %} tag.",
      });
    }
    if (!blockDirectiveLinePattern().test(text)) {
      const parsed = parseInlineConditions(text);
      if (!parsed.ok) {
        issues.push({
          paragraphIndex,
          directive: parsed.directive,
          message: parsed.message,
        });
      }
    }
    for (const { meta } of scanMarkers(text)) {
      if (
        "filters" in meta &&
        meta.filters.some(
          (filter) =>
            filter.name === "ai" &&
            filter.args.some(
              (arg) =>
                arg.kind === "keyword" &&
                arg.name === "adapt" &&
                arg.value === true,
            ),
        )
      ) {
        issues.push({
          paragraphIndex,
          directive: "ai(adapt=true)",
          message:
            "AI adaptation must be authored in the template body, not inside a clause.",
        });
      }
      if (
        meta.kind === "num" ||
        meta.kind === "ref" ||
        meta.kind === "clause"
      ) {
        issues.push({
          paragraphIndex,
          directive: meta.kind,
          message: `${meta.kind}() must be authored in the template body, not inside a clause.`,
        });
      }
    }
  }
  if (issues.length === 0) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 422,
      code: CLAUSE_DIRECTIVES_INVALID_CODE,
      retryable: false,
      message: `Clause paragraph ${(issues.at(0)?.paragraphIndex ?? 0) + 1} has invalid directives.`,
      hint: "Correct the named paragraphs in the clause editor or call save_clause with balanced literal {% ... %} tags. Put num(), ref(), nested clause(), and ai(adapt=true) markers in the template body.",
      issues: issues.map(({ paragraphIndex, message }) => ({
        path: `body.${paragraphIndex}`,
        message: `Paragraph ${paragraphIndex + 1}: ${message}`,
      })),
    }),
  );
};
