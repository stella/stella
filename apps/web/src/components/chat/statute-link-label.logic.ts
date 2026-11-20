import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";

// Its own module: the citation grammars load when a statute link is clicked,
// not with every chat answer that renders one.

/** The reference cut back to the levels `outer` names. */
const truncatedTo = (
  reference: ProvisionReference,
  outer: ProvisionReference,
): ProvisionReference => {
  const keepsPoint = outer.point !== null;
  const keepsLetter = keepsPoint || outer.letter !== null;
  const keepsSubsection = keepsLetter || outer.subsection !== null;
  return {
    ...reference,
    subsection: keepsSubsection ? reference.subsection : null,
    letter: keepsLetter ? reference.letter : null,
    point: keepsPoint ? reference.point : null,
  };
};

/**
 * The anchors of the subdivisions a statute link's label names inside the
 * provision its address lands on. A model links a citation to the provision
 * it read (`#par_240`) and labels it with the paragraph it means
 * (`§ 240 odst. 3 OSŘ`); the label is the narrower claim, so the reader marks
 * what it names. A label naming another provision, or nothing deeper than the
 * address, narrows nothing.
 */
export const labelledStatuteAnchorIds = ({
  anchor,
  country,
  label,
}: {
  anchor: string | null;
  country: string;
  label: string;
}): string[] => {
  const jurisdiction = country.trim().toUpperCase();
  if (anchor === null || !isCaseLawJurisdiction(jurisdiction)) {
    return [];
  }
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (grammar.status !== "supported") {
    return [];
  }
  const landed = grammar.parseAnchor(anchor);
  if (landed === null) {
    return [];
  }
  const landedAnchor = grammar.anchor(landed);
  const narrowed = grammar
    .readLabelProvisions(label)
    .filter(
      (reference) =>
        grammar.anchor(truncatedTo(reference, landed)) === landedAnchor,
    )
    .map((reference) => grammar.anchor(reference))
    .filter((cited) => cited !== landedAnchor);
  return [...new Set(narrowed)];
};
