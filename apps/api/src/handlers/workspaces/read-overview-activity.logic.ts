import { createHash } from "node:crypto";

import type { MatterActivityFilters } from "@stll/api-contract/matter-activity";

import {
  type AuditAction,
  AUDIT_RESOURCE_TYPE,
  type AuditActivityCategory,
} from "@/api/lib/audit-log";
import { isUuid } from "@/api/lib/custom-schema";
import type { TimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

export type FieldAuditResource =
  | { type: "field"; fieldId: ReturnType<typeof brandPersistedFieldId> }
  | {
      type: "cell";
      entityVersionId: ReturnType<typeof brandPersistedEntityVersionId>;
    };

export const matterActivityFilterKey = ({
  action,
  actorId,
  category,
  from,
  toExclusive,
}: MatterActivityFilters): string =>
  createHash("sha256")
    .update(JSON.stringify([category, action, actorId, from, toExclusive]))
    .digest("base64url");

export const timestampMicroseconds = (value: string): bigint | null => {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const fraction = /\.(\d+)(?=Z|[+-]\d\d:\d\d$)/iu.exec(value)?.[1] ?? "";
  if (fraction.length > 6) {
    return null;
  }
  const microseconds = BigInt(fraction.padEnd(6, "0") || "0");
  return BigInt(Math.floor(milliseconds / 1000)) * 1_000_000n + microseconds;
};

export const bindActivityCursorToFilters = <Id>({
  codec,
  filters,
}: {
  codec: TimestampIdCursorCodec<Id>;
  filters: MatterActivityFilters;
}): TimestampIdCursorCodec<Id> => {
  const filterKey = matterActivityFilterKey(filters);
  return {
    cursorValue: codec.cursorValue,
    keysetAfter: codec.keysetAfter,
    encode: (timestampValue, id) =>
      encodePaginationCursor([codec.encode(timestampValue, id), filterKey]),
    decode: (cursor) => {
      const parts = decodePaginationCursor(cursor);
      const innerCursor = parts?.at(0);
      const cursorFilterKey = parts?.at(1);
      if (
        parts?.length !== 2 ||
        typeof innerCursor !== "string" ||
        cursorFilterKey !== filterKey
      ) {
        return null;
      }
      return codec.decode(innerCursor);
    },
  };
};

export const parseFieldAuditResourceId = (
  resourceId: string,
): FieldAuditResource | null => {
  if (isUuid(resourceId)) {
    return { fieldId: brandPersistedFieldId(resourceId), type: "field" };
  }

  const parts = resourceId.split(":");
  const entityVersionId = parts.at(0);
  const propertyId = parts.at(1);
  if (
    parts.length !== 2 ||
    entityVersionId === undefined ||
    propertyId === undefined ||
    !isUuid(entityVersionId) ||
    !isUuid(propertyId)
  ) {
    return null;
  }

  return {
    entityVersionId: brandPersistedEntityVersionId(entityVersionId),
    type: "cell",
  };
};

export type LegacyActivityCategory =
  | "automation"
  | "court"
  | "documents"
  | "matter"
  | "tasks"
  | "team";

export const legacyActivityCategory = (
  resourceType: string,
  kind: string | null,
  workspaceTeamEvent: boolean,
): LegacyActivityCategory => {
  if (
    kind === "task" &&
    (resourceType === AUDIT_RESOURCE_TYPE.ENTITY ||
      resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION ||
      resourceType === AUDIT_RESOURCE_TYPE.FIELD)
  ) {
    return "tasks";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY ||
    resourceType === AUDIT_RESOURCE_TYPE.ENTITY_VERSION ||
    resourceType === AUDIT_RESOURCE_TYPE.FIELD ||
    resourceType === AUDIT_RESOURCE_TYPE.USER_FILE
  ) {
    return "documents";
  }
  if (
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER ||
    resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT
  ) {
    return "team";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK) {
    return "court";
  }
  if (resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE) {
    return workspaceTeamEvent ? "team" : "matter";
  }
  return "automation";
};

type ResolveActivityCategoryOptions = {
  kind: string | null;
  persistedCategory: AuditActivityCategory | null;
  resourceType: string;
  workspaceTeamEvent: boolean;
};

export const resolveActivityCategory = ({
  kind,
  persistedCategory,
  resourceType,
  workspaceTeamEvent,
}: ResolveActivityCategoryOptions): LegacyActivityCategory => {
  const derivedCategory = legacyActivityCategory(
    resourceType,
    kind,
    workspaceTeamEvent,
  );
  if (derivedCategory === "tasks") {
    return derivedCategory;
  }
  if (persistedCategory && persistedCategory !== "other") {
    return persistedCategory;
  }
  return derivedCategory;
};

type ResolveActivityRunIdOptions = {
  resourceId: string;
  resourceType: string;
  runId: string | null;
};

export const resolveActivityRunId = ({
  resourceId,
  resourceType,
  runId,
}: ResolveActivityRunIdOptions): string | null =>
  runId ?? (resourceType === AUDIT_RESOURCE_TYPE.FLOW_RUN ? resourceId : null);

type ResolveActivityActionOptions<TAction extends AuditAction> = {
  action: TAction;
  relationshipChange: "add" | "remove" | null;
};

export const resolveActivityAction = <TAction extends AuditAction>({
  action,
  relationshipChange,
}: ResolveActivityActionOptions<TAction>): TAction | "add" | "remove" =>
  relationshipChange ?? action;
