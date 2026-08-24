// The review topic shape the document-review engine consumes. It is a plain
// type, not an Elysia schema: the engine runs from handlers today and from a
// background worker later, and lib may not import a handler slice. The wire
// schema in `handlers/document-reviews/schemas.ts` is bound to this type, so a
// request-shape change that stops matching the engine fails typecheck there.

type ReviewTopicBase = {
  topicId: string;
  title: string;
  context: string;
  included: boolean;
};

export type DocumentReviewTopic =
  | (ReviewTopicBase & { type: "playbook"; positionId: string })
  | (ReviewTopicBase & { type: "reference" })
  | (ReviewTopicBase & { type: "custom" });

// Reference-comparison outcome vocabulary. It lives here rather than in
// `reference-compare.ts` so the persisted-run schema can derive its CHECK
// constraint from the same const the model's output schema is built from,
// without the database module importing the AI stack.
export const REFERENCE_ASSESSMENTS = [
  "aligned",
  "different",
  "missing-from-target",
  "additional-in-target",
  "deal-specific",
  "not-comparable",
] as const;
export type ReferenceAssessment = (typeof REFERENCE_ASSESSMENTS)[number];

// How consistently the references agreed about a topic. `single` is the
// degenerate one-reference case, normalized after the model answers.
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

/** The role and, when known, the party, as one phrase: "the Purchaser
 *  (Fusion Holdings a.s.)". */
export const perspectivePartyPhrase = (party: ReviewParty): string =>
  party.name === null
    ? `the ${party.role}`
    : `the ${party.role} (${party.name})`;

// Which way a topic's difference cuts for the chosen side.
export const REFERENCE_IMPACTS = [
  "favourable",
  "unfavourable",
  "neutral",
  "unknown",
] as const;
export type ReferenceImpact = (typeof REFERENCE_IMPACTS)[number];

// How much the difference matters commercially or legally for that side.
export const REFERENCE_SEVERITIES = ["high", "medium", "low"] as const;
export type ReferenceSeverity = (typeof REFERENCE_SEVERITIES)[number];
