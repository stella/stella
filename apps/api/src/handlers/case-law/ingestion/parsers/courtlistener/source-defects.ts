import { panic } from "better-result";

import { load } from "@stll/html";

import type { ValidationResult } from "@/api/lib/legal-search/parsers/validate-ast";

import { visibleHtmlText } from "../shared-inlines";
import { conservesText } from "./blocks";
import { markupResidueMatchesIn } from "./markup-residue";
import type { ParsedOpinionText } from "./outcome";

/** Literal markup on the publisher's text axis, preserved without another decode. */
export type PublishedTextDefect = {
  readonly type:
    | "entity-reference"
    | "literal-tag"
    | "repeated-glyph"
    | "malformed-identifier";
  readonly anchorId: string;
};

/** Null means parser failure or actual unsupported markup, rather than a faithful literal. */
export const publishedTextDefects = (
  text: ParsedOpinionText,
  validation: ValidationResult,
): PublishedTextDefect[] | null => {
  if (validation.ok) {
    return [];
  }
  if (
    validation.issues.some(
      ({ code, severity }) => severity === "error" && code !== "MARKUP_RESIDUE",
    )
  ) {
    return null;
  }
  // Compare every non-whitespace character in order with the independently
  // projected source. A parser leak cannot qualify as published wording.
  const source = visibleHtmlText(load(text.validationHtml).root());
  if (!conservesText(source, text.units)) {
    return null;
  }
  const storedText = text.units
    .flatMap(({ blocks }) => blocks.map(({ plainText }) => plainText))
    .join("");
  if (source.replace(/\s/gu, "") !== storedText.replace(/\s/gu, "")) {
    return null;
  }
  const defects: PublishedTextDefect[] = [];
  const blocksByAnchor = new Map(
    text.units.flatMap(({ blocks }) =>
      blocks.map((block) => [block.anchorId, block] as const),
    ),
  );
  for (const { anchorId } of validation.stats.markupResidue) {
    const block = blocksByAnchor.get(anchorId);
    if (block === undefined) {
      return panic("Residue anchor is absent from the parsed source");
    }
    // A labelled identifier with an incomplete hexadecimal prefix stays
    // published, with its diagnostic; an unlabelled payload does not qualify.
    const malformedIdentifiers = new Set(
      [
        ...block.plainText.matchAll(
          /\bWallet[ \t]+Owner[ \t]+x[\da-fA-F]{40}(?![\p{L}\p{N}])/gu,
        ),
      ].map((match) => match.index + match[0].length - 40),
    );
    const types = new Set<PublishedTextDefect["type"]>();
    for (const residue of markupResidueMatchesIn(block.plainText)) {
      switch (residue.rule) {
        case "entity":
          types.add("entity-reference");
          break;
        case "html-tag":
          types.add("literal-tag");
          break;
        case "digit-run":
        case "hex-run":
          if (malformedIdentifiers.has(residue.index)) {
            types.add("malformed-identifier");
            break;
          }
          // Inspect the complete context-qualified run, not a bounded excerpt.
          if (new Set(residue.matched).size !== 1) {
            return null;
          }
          types.add("repeated-glyph");
          break;
        case "rtf-control":
        case "xml-marker":
        case "pdf-object":
          return null;
        default:
          residue.rule satisfies never;
          return panic("Unhandled published text residue");
      }
    }
    for (const type of types) {
      defects.push({ type, anchorId });
    }
  }
  return defects;
};
