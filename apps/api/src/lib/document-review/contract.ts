// Plain vocabulary shared by the document-review engine and the surfaces that
// read a run. Plain types, not Elysia schemas: the engine runs from handlers
// and from a background worker, and lib may not import a handler slice. The
// wire schemas in `handlers/document-reviews/schemas.ts` are bound to these
// types, so a request-shape change that stops matching the engine fails
// typecheck there.

// How consistently the reference passages agreed about a position. `single` is
// the degenerate one-passage-source case, normalized after the model answers.
export const REFERENCE_CONSENSUS_VALUES = [
  "single",
  "consistent",
  "mixed",
] as const;
export type ReferenceConsensus = (typeof REFERENCE_CONSENSUS_VALUES)[number];

// A party to the target document, as the document itself names the role
// (Purchaser, Seller, Landlord, Licensee) and, when stated, the party.
export type ReviewParty = { role: string; name: string | null };

// Whose interest a reference comparison judges. A difference between two
// drafts has no direction on its own: "the cap is lower" is bad for a buyer
// and good for a seller. The side is one of the target's own parties, not a
// fixed vocabulary: a lease has a landlord, a licence a licensee. `neutral`
// means no side was chosen, and the comparison then reports impact as
// `unknown`.
export type ReviewPerspective =
  | { type: "neutral" }
  | ({ type: "party" } & ReviewParty);

export const NEUTRAL_PERSPECTIVE: ReviewPerspective = { type: "neutral" };

// Bounds on what a client or the model may put in a party. A role is a
// defined term of a few words; a name is one legal entity.
export const REVIEW_PARTY_ROLE_MAX_LENGTH = 80;
export const REVIEW_PARTY_NAME_MAX_LENGTH = 200;
/** Parties the proposal pass reports at most; a contract with more sides
 *  than this is not a two-document comparison. */
export const REVIEW_PARTIES_MAX = 8;

// Something the reference document covers that the proposal pass deliberately
// did not turn into a position — deal mechanics, structural differences
// between a preliminary and a final agreement, party and schedule particulars.
// Reported rather than dropped: a checklist that silently omits half the
// document reads as if the other half were compliant.
export type ReviewSkippedTerm = { subject: string; reason: ReviewSkipReason };

/**
 * Why a subject was read and not compared.
 *
 * Coded, not prose: the two reasons the prompt itself hands the model are
 * decided here and rendered in the reader's language, so a Czech reviewer is
 * not told "deal-specific value" in English. `other` carries the model's own
 * words, which follow the document rather than the interface.
 */
export type ReviewSkipReason =
  | { kind: "deal-specific-value" }
  | { kind: "structural" }
  | { kind: "other"; text: string };

export const REVIEW_SKIP_SUBJECT_MAX_LENGTH = 256;
export const REVIEW_SKIP_REASON_MAX_LENGTH = 300;
/** Skips the proposal pass reports at most. Enough to show the reviewer the
 *  shape of what was left out; it is not an inventory of the document. */
export const REVIEW_SKIPPED_MAX = 40;

/** The role and, when known, the party, as one phrase: "the Purchaser
 *  (Example Holdings a.s.)". */
export const perspectivePartyPhrase = (party: ReviewParty): string =>
  party.name === null
    ? `the ${party.role}`
    : `the ${party.role} (${party.name})`;

// Which way a position's difference cuts for the chosen side.
export const REFERENCE_IMPACTS = [
  "favourable",
  "unfavourable",
  "neutral",
  "unknown",
] as const;
export type ReferenceImpact = (typeof REFERENCE_IMPACTS)[number];

// How much a difference matters is a property of the position, not of the
// comparison: `PositionSeverity` on the position the finding answers is the
// one severity a reader sees.
