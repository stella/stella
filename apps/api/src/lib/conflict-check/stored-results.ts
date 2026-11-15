import type {
  ConflictCoverageGap,
  ConflictMatchEvidence,
  ConflictMatchTier,
  ConflictMatterState,
  ConflictRelation,
  ConflictSeverity,
} from "@stll/api-contract/conflict-checks";
import type { SafeId } from "@stll/api-contract/safe-id";

/**
 * A matched contact's link to a matter, as recorded when the check ran. A
 * link to a matter the runner could not open keeps only the matter id and the
 * severity the database computed: the contact's role and the matter's state
 * never left the database, so they cannot be stored or shown.
 */
export type StoredConflictLink =
  | {
      access: "visible";
      workspaceId: SafeId<"workspace">;
      relation: ConflictRelation;
      role: string | null;
      state: ConflictMatterState;
      severity: ConflictSeverity;
    }
  | {
      access: "walled";
      workspaceId: SafeId<"workspace">;
      severity: ConflictSeverity;
    };

export type StoredConflictHit = {
  contactId: SafeId<"contact">;
  contactName: string;
  contactType: "person" | "organization";
  tier: ConflictMatchTier;
  score: number;
  matchedName: string | null;
  evidence: ConflictMatchEvidence;
  links: StoredConflictLink[];
};

export type StoredConflictPartyResult = {
  hits: StoredConflictHit[];
  totalMatches: number;
  truncated: boolean;
  incomplete: boolean;
};

/**
 * The matches of one check, versioned so a later reader can tell a stored
 * shape from a newer one. Holds no matter names and no user ids.
 */
export type StoredConflictResults = {
  version: 1;
  contactsScreened: number;
  gaps: ConflictCoverageGap[];
  parties: StoredConflictPartyResult[];
};
