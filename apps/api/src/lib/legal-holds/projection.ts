import { panic } from "better-result";

import type { LegalHoldView } from "@stll/api-contract/legal-holds";

import type { SafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  hasManagementPermission,
  readAuthorizedMemberRole,
} from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Who a hold is shown to. A request without a member identity (a token
 * route, a transport that does not carry the caller) is `unidentified` and
 * never reads a reason.
 */
export type LegalHoldViewer =
  | { type: "member"; userId: string; memberRole: AuthorizedMemberRole }
  | { type: "unidentified" };

export const UNIDENTIFIED_LEGAL_HOLD_VIEWER = {
  type: "unidentified",
} as const satisfies LegalHoldViewer;

/** The viewer of a handler request, read from its authorized context. */
export const legalHoldViewerFromContext = (ctx: object): LegalHoldViewer => {
  const memberRole = readAuthorizedMemberRole(ctx);
  const user: unknown = Object.hasOwn(ctx, "user")
    ? Reflect.get(ctx, "user")
    : undefined;
  const userId: unknown = isRecord(user) ? user["id"] : undefined;
  if (memberRole === null || typeof userId !== "string") {
    return UNIDENTIFIED_LEGAL_HOLD_VIEWER;
  }
  return { type: "member", userId, memberRole };
};

type LegalHoldRecordFields = {
  id: SafeId<"legalHold">;
  scope: "matter" | "entity";
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity"> | null;
  placedAt: Date;
  placedBy: string;
  reason: string;
};

/**
 * An active hold as the server read it. The reason and the placer are private
 * fields: no serializer, log or error report reaches them, and the only way
 * out is `view`, which decides who may read the reason.
 */
export class LegalHoldRecord {
  readonly id: SafeId<"legalHold">;
  readonly scope: "matter" | "entity";
  readonly workspaceId: SafeId<"workspace">;
  readonly entityId: SafeId<"entity"> | null;
  readonly placedAt: Date;
  readonly #placedBy: string;
  readonly #reason: string;

  constructor(fields: LegalHoldRecordFields) {
    this.id = fields.id;
    this.scope = fields.scope;
    this.workspaceId = fields.workspaceId;
    this.entityId = fields.entityId;
    this.placedAt = fields.placedAt;
    this.#placedBy = fields.placedBy;
    this.#reason = fields.reason;
  }

  /**
   * Organization owners and administrators, and the member who placed the
   * hold, read its reason. Every other viewer sees the hold without it.
   */
  readableBy(viewer: LegalHoldViewer): boolean {
    switch (viewer.type) {
      case "unidentified":
        return false;
      case "member":
        return (
          viewer.userId === this.#placedBy ||
          hasManagementPermission(viewer.memberRole, { legalHold: ["place"] })
        );
      default:
        viewer satisfies never;
        return panic("Unknown legal hold viewer");
    }
  }

  /** The one projection of a hold to a client. */
  view(viewer: LegalHoldViewer): LegalHoldView {
    const base = {
      id: this.id,
      scope: this.scope,
      workspaceId: this.workspaceId,
      entityId: this.entityId,
      placedAt: this.placedAt.toISOString(),
    };
    return this.readableBy(viewer)
      ? { ...base, reasonAccess: "granted", reason: this.#reason }
      : { ...base, reasonAccess: "restricted" };
  }
}
