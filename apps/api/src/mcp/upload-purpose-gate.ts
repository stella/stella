import { and, eq } from "drizzle-orm";

import type { PermissionInput } from "@stll/permissions";

import { pendingUploads } from "@/api/db/schema";
import { UPLOAD_PURPOSE_PERMISSION } from "@/api/handlers/uploads/permissions";
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

type UploadPurposeGate = {
  /**
   * Where the purpose comes from. `create` declares it in the request; the
   * calls that name a stored upload re-derive it from that row, so relabelling
   * the second call cannot widen what the first reserved.
   */
  source: "body" | "pendingUpload";
  /**
   * Whether the purpose's own consent applies on top of the domain scope.
   * `domain` for a call that finalizes nothing: abandoning staged bytes does
   * not reach the resource the purpose would have produced, so the domain
   * scope is the whole consent. The permission still follows the purpose on
   * every call, which is what the handlers themselves gate on.
   */
  consent: "purpose" | "domain";
};

/**
 * Every `uploads.*` capability whose grant depends on the request rather than
 * on its static config. Exported so the catalog guard can hold the two sides
 * together: a new upload capability that reaches `authorizeUploadPurpose`
 * without an entry here would run its purpose gate on the member role alone.
 */
export const UPLOAD_PURPOSE_GATE_BY_CAPABILITY = new Map<
  string,
  UploadPurposeGate
>([
  ["uploads.create", { source: "body", consent: "purpose" }],
  ["uploads.update", { source: "pendingUpload", consent: "purpose" }],
  ["uploads.delete", { source: "pendingUpload", consent: "domain" }],
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

type UploadPurposeRequirementInput = {
  body: unknown;
  capabilityId: string;
  context: McpRequestContext;
  params: unknown;
};

/** What this invocation's upload purpose requires beyond its static config. */
export type UploadPurposeRequirement = {
  /**
   * The grant the purpose spends. The static config permission for `uploads.*`
   * is `workspace:read` because the resource-appropriate grant is only known
   * once the purpose is, so the dispatch path reads it here and the handler
   * checks the same map (`UPLOAD_PURPOSE_PERMISSION`) again on every surface.
   */
  permission: PermissionInput;
  /** The consent the purpose spends, or `null` when the domain scope covers it. */
  scope: McpOAuthScope | null;
};

/**
 * What this invocation requires beyond its catalog scope and config
 * permission, or `null` when the capability carries no upload purpose (and for
 * a purpose-gated call whose upload row does not exist: the handler answers
 * that with its own 404).
 */
export const resolveUploadPurposeRequirement = async ({
  body,
  capabilityId,
  context,
  params,
}: UploadPurposeRequirementInput): Promise<UploadPurposeRequirement | null> => {
  const gate = UPLOAD_PURPOSE_GATE_BY_CAPABILITY.get(capabilityId);
  if (gate === undefined) {
    return null;
  }

  const purpose =
    gate.source === "body"
      ? readBodyPurpose(body)
      : await readStoredPurpose({ context, params });
  if (purpose === null) {
    return null;
  }

  return {
    permission: UPLOAD_PURPOSE_PERMISSION[purpose],
    scope: gate.consent === "purpose" ? UPLOAD_PURPOSE_SCOPE[purpose] : null,
  };
};
