import { panic } from "better-result";

import { stableStringify } from "@stll/stable-stringify";

import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentSource } from "@/api/lib/document-source";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";

const UUID_V8_VARIANTS = ["8", "9", "a", "b"] as const;

type ComparisonVersionIdentity = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  filePropertyId: SafeId<"property">;
  source: Extract<DocumentSource, { kind: "comparison" }>;
};

/** Immutable comparison inputs identify one saved artifact, including on retry. */
export const comparisonVersionId = (identity: ComparisonVersionIdentity) => {
  const digest = new Bun.CryptoHasher("sha256")
    .update(
      stableStringify({
        operation: "documents.compare",
        revisionFormat: "folio-exact",
        ...identity,
      }),
    )
    .digest("hex");
  // UUIDv8 reserves application-defined bits; keep 122 bits of the digest.
  const variant =
    UUID_V8_VARIANTS.at(Number.parseInt(digest.slice(16, 17), 16) % 4) ??
    panic("SHA-256 digest must have a UUID variant nibble");
  return brandPersistedEntityVersionId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
};
