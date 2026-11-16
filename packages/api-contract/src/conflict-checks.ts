import * as v from "valibot";

import { contactBirthDateSchema } from "./contact-date";
import { displayNameSchema } from "./display-name";
import { PARTY_IDENTIFIER_MAX_LENGTH } from "./party-identifiers";

/**
 * An internal conflict-of-interest check: the parties of a prospective matter
 * screened against every contact and matter the firm holds. A check reports
 * what it found and how far it looked; it never declares a matter clear. Only
 * a person records "cleared", as a decision on the check.
 */

/** The party's side in the prospective matter. */
export const CONFLICT_PARTY_ROLES = ["client", "adverse", "related"] as const;
export type ConflictPartyRole = (typeof CONFLICT_PARTY_ROLES)[number];

const CONFLICT_PARTY_TYPES = ["person", "organization"] as const;

export const CONFLICT_CHECK_LIMITS = {
  parties: 20,
  aliasesPerParty: 10,
  titleChars: 256,
  noteChars: 4000,
  consentReferenceChars: 512,
  /** Possible matches reported per party; more are counted, not listed. */
  hitsPerParty: 50,
} as const;

/**
 * How much a relation between a matched contact and an existing matter
 * matters for the prospective one, most severe first.
 */
export const CONFLICT_SEVERITIES = [
  "potential_conflict",
  "needs_review",
  "information",
] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];

/**
 * A check's outcome, most severe first. `incomplete` means part of the firm's
 * records was not searched, so the absence of a match proves nothing there.
 * There is no "clear" outcome.
 */
export const CONFLICT_CHECK_OUTCOMES = [
  "potential_conflict",
  "incomplete",
  "needs_review",
  "information_only",
  "no_matches",
] as const;
export type ConflictCheckOutcome = (typeof CONFLICT_CHECK_OUTCOMES)[number];

/** A person's decision on a check. `pending` until someone records one. */
export const CONFLICT_CHECK_DECISIONS = [
  "pending",
  "cleared",
  "conflict",
  "waived",
] as const;
type ConflictCheckDecision = (typeof CONFLICT_CHECK_DECISIONS)[number];

type RecordedConflictCheckDecision = Exclude<ConflictCheckDecision, "pending">;

/** Why part of the firm's records was not searched. */
export const CONFLICT_COVERAGE_GAPS = {
  /** The firm holds more contacts than one check screens. */
  contactsOverCap: "contacts_over_cap",
  /** A party's screening stopped at its work bound before it finished. */
  partyWorkLimit: "party_work_limit",
  /** A party matched more contacts than one check classifies. */
  partyMatchLimit: "party_match_limit",
} as const;
export type ConflictCoverageGap =
  (typeof CONFLICT_COVERAGE_GAPS)[keyof typeof CONFLICT_COVERAGE_GAPS];

/** How a contact matched a party, strongest first. */
const CONFLICT_MATCH_TIERS = [
  "identifier",
  "exact_name",
  "strong_name",
  "similar_name",
] as const;
export type ConflictMatchTier = (typeof CONFLICT_MATCH_TIERS)[number];

/** A matched contact's link to a matter the reader may open. */
export const CONFLICT_RELATIONS = ["client", "matter_role"] as const;
export type ConflictRelation = (typeof CONFLICT_RELATIONS)[number];

export const CONFLICT_MATTER_STATES = ["open", "closed"] as const;
export type ConflictMatterState = (typeof CONFLICT_MATTER_STATES)[number];

export const CONFLICT_CHECK_REFUSAL_CODE = {
  /** Only a reviewer may clear a potential conflict or an incomplete check, waive one, or replace a recorded decision. */
  reviewRequired: "conflict_check_review_required",
  /** Only the check's runner or a reviewer may change it. */
  writeRequired: "conflict_check_write_required",
  /** The decision changed since the caller read it. */
  decisionChanged: "conflict_check_decision_changed",
} as const;

// Former and trading names; an omitted list is an empty one.
const aliasesSchema = v.optional(
  v.pipe(
    v.array(displayNameSchema({ maxLength: 512 })),
    v.maxLength(CONFLICT_CHECK_LIMITS.aliasesPerParty),
  ),
  [],
);

const identifierSchema = v.exactOptional(
  v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH),
  ),
);

const roleSchema = v.picklist(CONFLICT_PARTY_ROLES);

const conflictPartySchema = v.variant("type", [
  v.strictObject({
    type: v.literal("person"),
    role: roleSchema,
    firstName: displayNameSchema({ maxLength: 256 }),
    middleName: v.exactOptional(displayNameSchema({ maxLength: 256 })),
    lastName: displayNameSchema({ maxLength: 256 }),
    dateOfBirth: v.exactOptional(contactBirthDateSchema),
    aliases: aliasesSchema,
  }),
  v.strictObject({
    type: v.literal("organization"),
    role: roleSchema,
    name: displayNameSchema({ maxLength: 512 }),
    companyId: identifierSchema,
    taxId: identifierSchema,
    vatId: identifierSchema,
    dataBoxId: identifierSchema,
    aliases: aliasesSchema,
  }),
]);
export type ConflictParty = v.InferOutput<typeof conflictPartySchema>;

export const conflictCheckPartiesSchema = v.pipe(
  v.array(conflictPartySchema),
  v.minLength(1),
  v.maxLength(CONFLICT_CHECK_LIMITS.parties),
);

export const conflictCheckTitleSchema = displayNameSchema({
  maxLength: CONFLICT_CHECK_LIMITS.titleChars,
});

export const conflictCheckDecisionInputSchema = v.strictObject({
  decision: v.picklist(
    CONFLICT_CHECK_DECISIONS.filter(
      (decision): decision is RecordedConflictCheckDecision =>
        decision !== "pending",
    ),
  ),
  /** The decision the caller saw; the change is refused when it moved. */
  expectedDecision: v.picklist(CONFLICT_CHECK_DECISIONS),
  /** The decision revision the caller saw; any later decision advances it. */
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  note: v.exactOptional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(CONFLICT_CHECK_LIMITS.noteChars),
    ),
  ),
  /** The client's written consent a waiver rests on. */
  consentReference: v.exactOptional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(CONFLICT_CHECK_LIMITS.consentReferenceChars),
    ),
  ),
});
export type ConflictCheckDecisionInput = v.InferOutput<
  typeof conflictCheckDecisionInputSchema
>;

/** How a match was established, for the reader to weigh. */
export type ConflictMatchEvidence = {
  /** Name similarity before identity fields, 0..1; 0 when only an identifier matched. */
  nameScore: number;
  identifier: "match" | "mismatch" | "not-compared";
  birthDate: "match" | "mismatch" | "not-compared";
  entityType: "match" | "mismatch" | "not-compared";
};

/** A matter the reader may open, with the matched contact's place in it. */
export type ConflictVisibleMatter = {
  workspaceId: string;
  name: string;
  reference: string;
  relation: ConflictRelation;
  /** The contact's role in the matter; null when it is the matter's client. */
  role: string | null;
  state: ConflictMatterState;
  severity: ConflictSeverity;
};

/**
 * Matters the reader may not open, counted per severity. Nothing else about
 * them is disclosed: not the contact's role, nor whether a matter is open.
 */
export type ConflictWalledMatters = {
  severity: Exclude<ConflictSeverity, "information">;
  count: number;
  /** Whom to ask: the matter lead, else the client's responsible lawyer, else null for an administrator. */
  contacts: { userId: string; name: string }[];
  askAdministrator: boolean;
};

export type ConflictHit = {
  contactId: string;
  /** The contact's name when the check ran. */
  contactName: string;
  contactType: (typeof CONFLICT_PARTY_TYPES)[number];
  tier: ConflictMatchTier;
  score: number;
  matchedName: string | null;
  evidence: ConflictMatchEvidence;
  /** The most severe relation found; `information` for an address-book contact. */
  severity: ConflictSeverity;
  matters: ConflictVisibleMatter[];
  walled: ConflictWalledMatters[];
  /** Matters linked when the check ran that no longer exist. */
  deletedMatters: number;
};

type ConflictPartyResult = {
  party: ConflictParty;
  hits: ConflictHit[];
  /** Every possible match at or above the cutoff, listed or not. */
  totalMatches: number;
  truncated: boolean;
  /** Screening stopped at its work bound before finishing this party. */
  incomplete: boolean;
};

type ConflictCheckCoverage = {
  contactsScreened: number;
  /** Empty only when every contact was screened in full for every party. */
  gaps: ConflictCoverageGap[];
};

export type ConflictCheckView = {
  id: string;
  title: string | null;
  outcome: ConflictCheckOutcome;
  coverage: ConflictCheckCoverage;
  parties: ConflictPartyResult[];
  decision: ConflictCheckDecision;
  /** Advances with every recorded decision; a decision names the one it read. */
  decisionRevision: number;
  decisionNote: string | null;
  consentReference: string | null;
  decidedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
  runBy: { userId: string; name: string } | null;
  workspaceId: string | null;
  createdAt: string;
};

export type ConflictCheckListItem = Pick<
  ConflictCheckView,
  "id" | "title" | "outcome" | "decision" | "workspaceId" | "createdAt"
> & { partyCount: number; runBy: { userId: string; name: string } | null };
