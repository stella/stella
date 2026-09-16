/**
 * How a decision's provision reference reads back to a lawyer.
 *
 * Citation form is jurisdiction-bound and its subdivisions are named in
 * words (`odst.`, `para.`, `ust.`), so the naming is left to the caller's
 * catalog and only the assembly — which subdivision follows which — lives
 * here. The section sign and the numbers themselves are printed verbatim:
 * they are the citation, not a translation of it.
 */

import type {
  ProvisionPartKey,
  ProvisionReference,
} from "@stll/legal-ast/provision-reference";

/** Renders one named subdivision, e.g. `("subsection", "1") => "para. 1"`. */
export type RenderProvisionPart = (
  key: ProvisionPartKey,
  value: string,
) => string;

export const formatProvisionReference = (
  reference: ProvisionReference,
  render: RenderProvisionPart,
): string => {
  const number = `${reference.section}${reference.sectionSuffix ?? ""}`;
  const parts: string[] = [
    // The section sign is a symbol every jurisdiction that uses it prints
    // the same way; an article is a word, so its naming is the catalog's.
    reference.unit === "section" ? `§ ${number}` : render("article", number),
  ];

  const subdivisions = [
    { key: "subsection", value: reference.subsection },
    { key: "letter", value: reference.letter },
    { key: "point", value: reference.point },
    { key: "sentence", value: reference.sentence },
  ] as const satisfies readonly {
    key: ProvisionPartKey;
    value: string | null;
  }[];

  for (const { key, value } of subdivisions) {
    if (value !== null && value.trim().length > 0) {
      parts.push(render(key, value.trim()));
    }
  }

  if (reference.openEnded) {
    parts.push(render("openEnded", number));
  }

  return parts.join(" ");
};
