import type { Transaction } from "@/api/db";
import { documentTypes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DefaultDocumentType = {
  key: string;
  label: string;
  sortOrder: number;
};

// The starter taxonomy an org gets seeded with. `key` is the stable slug
// playbook scopes reference; `label` is the human-facing name surfaced in the
// workspace "Document Type" classifier and resolved at run time for gating.
// "other" sorts last as the catch-all.
export const DEFAULT_DOCUMENT_TYPES: readonly DefaultDocumentType[] = [
  { key: "nda", label: "Non-Disclosure Agreement", sortOrder: 0 },
  { key: "spa", label: "Share Purchase Agreement", sortOrder: 1 },
  { key: "apa", label: "Asset Purchase Agreement", sortOrder: 2 },
  { key: "shareholders", label: "Shareholders' Agreement", sortOrder: 3 },
  { key: "msa", label: "Master Services Agreement", sortOrder: 4 },
  { key: "sla", label: "Service Level Agreement", sortOrder: 5 },
  { key: "dpa", label: "Data Processing Agreement", sortOrder: 6 },
  { key: "saas", label: "SaaS Agreement", sortOrder: 7 },
  { key: "employment", label: "Employment Agreement", sortOrder: 8 },
  { key: "consultancy", label: "Consultancy Agreement", sortOrder: 9 },
  { key: "lease", label: "Lease Agreement", sortOrder: 10 },
  { key: "loan", label: "Loan / Facility Agreement", sortOrder: 11 },
  { key: "guarantee", label: "Guarantee", sortOrder: 12 },
  { key: "poa", label: "Power of Attorney", sortOrder: 13 },
  { key: "license", label: "Licence Agreement", sortOrder: 14 },
  { key: "distribution", label: "Distribution Agreement", sortOrder: 15 },
  { key: "supply", label: "Supply Agreement", sortOrder: 16 },
  { key: "settlement", label: "Settlement Agreement", sortOrder: 17 },
  { key: "termsheet", label: "Term Sheet / LOI", sortOrder: 18 },
  { key: "other", label: "Other", sortOrder: 19 },
] as const;

// Accept any handle exposing `insert` so callers can pass the root db
// (seed scripts) or a scoped transaction without importing a test-only type.
type DocumentTypeWriter = Pick<Transaction, "insert">;

/**
 * Idempotently seeds the default taxonomy for an org. Existing rows are left
 * untouched (conflict on the (organization_id, key) unique), so re-running
 * never overwrites edits or duplicates entries.
 */
export const ensureDefaultDocumentTypes = async (
  organizationId: SafeId<"organization">,
  db: DocumentTypeWriter,
): Promise<void> => {
  // audit: skip — system bootstrap that idempotently seeds the org's default
  // taxonomy (called from seed/provisioning), not a user-initiated mutation.
  await db
    .insert(documentTypes)
    .values(
      DEFAULT_DOCUMENT_TYPES.map((documentType) => ({
        organizationId,
        key: documentType.key,
        label: documentType.label,
        sortOrder: documentType.sortOrder,
      })),
    )
    .onConflictDoNothing({
      target: [documentTypes.organizationId, documentTypes.key],
    });
};
