import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { VOCABULARY_LIMITS } from "@/api/lib/workspaces/vocabulary/candidates";
import { readVocabularyHandler } from "@/api/lib/workspaces/vocabulary/read";

const config = {
  contract: "patch",
  description: `Read a matter's names, references, linked contacts, tracked case numbers, locally known court names, and most recently created document titles. Returns up to ${VOCABULARY_LIMITS.perKind} candidates per kind and ${VOCABULARY_LIMITS.total} total; terms longer than ${VOCABULARY_LIMITS.termLength} characters are omitted. Candidates preserve spelling and include a kind weight and available activity timestamp. Requires a matter id; returns not found when unavailable.`,
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;

const readVocabulary = createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readVocabularyHandler({
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
          }),
      ),
    );
    return Result.ok(response);
  },
);

export default readVocabulary;
