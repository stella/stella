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

/** The first decodable HTML character reference left in normalized text. */
export const entityResidueIn = (text: string): EntityResidue | undefined => {
  CHARACTER_REFERENCE.lastIndex = 0;
  let match = CHARACTER_REFERENCE.exec(text);
  while (match) {
    if (decodeHTMLStrict(match[0]) !== match[0]) {
      return { entity: match[0], index: match.index };
    }
    match = CHARACTER_REFERENCE.exec(text);
  }
  return undefined;
};

/** Residues in an explicitly selected set of displayable stored text fields. */
export const entityResiduesInStoredText = (
  fields: readonly StoredTextField[],
): StoredTextEntityResidue[] =>
  fields.flatMap(({ field, value }) => {
    const residue = entityResidueIn(value);
    return residue === undefined ? [] : [{ field, ...residue }];
  });
