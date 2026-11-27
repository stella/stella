import { decodeHTMLStrict } from "entities";

/** A character reference that would decode in text stored as court wording. */
type EntityResidue = {
  entity: string;
  index: number;
};

type StoredTextField = {
  field: string;
  value: string;
};

type StoredTextEntityResidue = EntityResidue & {
  field: string;
};

// Match the complete HTML5 named-reference space, then let the strict decoder
// distinguish actual references from publisher text that merely looks like one.
const CHARACTER_REFERENCE = /&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/gu;

// parser-output-unchanged: The first-reference API uses the same pattern and strict decoder; the span iterator is consumed by CourtListener validation only.
/**
 * Every decodable reference on the original stored-text axis.
 * @yields Complete recognized entity spans, without decoding publisher wording.
 */
export function* entityResidueMatchesIn(
  text: string,
): Generator<EntityResidue> {
  for (const match of text.matchAll(CHARACTER_REFERENCE)) {
    if (decodeHTMLStrict(match[0]) !== match[0]) {
      yield { entity: match[0], index: match.index };
    }
  }
}

/** The first decodable HTML character reference left in normalized text. */
export const entityResidueIn = (text: string): EntityResidue | undefined => {
  const first = entityResidueMatchesIn(text).next();
  return first.done ? undefined : first.value;
};

/** Residues in an explicitly selected set of displayable stored text fields. */
export const entityResiduesInStoredText = (
  fields: readonly StoredTextField[],
): StoredTextEntityResidue[] =>
  fields.flatMap(({ field, value }) => {
    const residue = entityResidueIn(value);
    return residue === undefined ? [] : [{ field, ...residue }];
  });
