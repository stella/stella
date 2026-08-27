import { and, eq } from "drizzle-orm";

import { pendingUploads } from "@/api/db/schema";
import type { UploadPurpose } from "@/api/handlers/uploads/permissions";
import { isUuid } from "@/api/lib/custom-schema";
import { brandPersistedPendingUploadId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";
import type { McpOAuthScope } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * The consent an upload purpose spends.
 *
 * `uploads.*` takes one domain scope in the capability catalog, but its
 * purposes do not finalize into the same resource: `agent_skill` installs a
 * skill, which is what `stella:skills` is the consent for, while the document
 * purposes write workspace content. Without this the domain scope would let a
 * matters-write consent install a skill.
 *
 * Total over the purpose union, so a new purpose cannot be added without
 * deciding which consent covers it.
 */
export const UPLOAD_PURPOSE_SCOPE = {
  entity_create: "stella:matters_write",
  entity_version: "stella:matters_write",
  agent_skill: "stella:skills",
} as const satisfies Record<UploadPurpose, McpOAuthScope>;

/**
 * Where a capability's upload purpose comes from. `create` declares it in the
 * request; `update` (finalize) names a stored upload, and the purpose is
 * re-derived from that row so relabelling the second call cannot widen what the
 * first consented to. `uploads.delete` is absent on purpose: abandoning staged
 * bytes finalizes nothing, so it stays on the domain scope.
 */
const UPLOAD_PURPOSE_SOURCE_BY_CAPABILITY = new Map<
  string,
  "body" | "pendingUpload"
>([
  ["uploads.create", "body"],
  ["uploads.update", "pendingUpload"],
]);

const UPLOAD_PURPOSES = new Set<string>(Object.keys(UPLOAD_PURPOSE_SCOPE));

const isUploadPurpose = (value: unknown): value is UploadPurpose =>
  typeof value === "string" && UPLOAD_PURPOSES.has(value);

const readBodyPurpose = (body: unknown): UploadPurpose | null => {
  if (!isRecord(body)) {
    return null;
  }
  const purpose = body["purpose"];
  return isUploadPurpose(purpose) ? purpose : null;
};

/**
 * The purpose recorded when the upload was reserved. `null` when no row
 * matches: the handler answers that with its own 404, and no scope beyond the
 * domain's is required to be told a nonexistent upload does not exist.
 */
const readStoredPurpose = async ({
  context,
  params,
}: {
  context: McpRequestContext;
  params: unknown;
}): Promise<UploadPurpose | null> => {
  if (!isRecord(params)) {
    return null;
  }
  const uploadId = params["uploadId"];
  if (typeof uploadId !== "string" || !isUuid(uploadId)) {
    return null;
  }

  const rows = await context.scopedDb(
    async (tx) =>
      await tx
        .select({ purpose: pendingUploads.purpose })
        .from(pendingUploads)
        .where(
          and(
            eq(pendingUploads.id, brandPersistedPendingUploadId(uploadId)),
            eq(pendingUploads.userId, context.userId),
          ),
        )
        .limit(1),
  );

  const purpose = rows.at(0)?.purpose;
  return isUploadPurpose(purpose) ? purpose : null;
};

type UploadPurposeScopeInput = {
  body: unknown;
  capabilityId: string;
  context: McpRequestContext;
  params: unknown;
};

/**
 * The extra scope this invocation requires beyond its catalog scope, or `null`
 * when the capability carries no upload purpose.
 */
export const resolveUploadPurposeScope = async ({
  body,
  capabilityId,
  context,
  params,
}: UploadPurposeScopeInput): Promise<McpOAuthScope | null> => {
  const source = UPLOAD_PURPOSE_SOURCE_BY_CAPABILITY.get(capabilityId);
  if (source === undefined) {
    return null;
  }

  const purpose =
    source === "body"
      ? readBodyPurpose(body)
      : await readStoredPurpose({ context, params });

  return purpose === null ? null : UPLOAD_PURPOSE_SCOPE[purpose];
};
