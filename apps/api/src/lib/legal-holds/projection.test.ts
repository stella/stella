import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  LEGAL_HOLD_ACTIVE,
  LEGAL_HOLD_REASON_ISSUE_CODE,
} from "@stll/api-contract/legal-holds";

import { createSafeId } from "@/api/lib/branded-types";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";

import { LegalHoldActiveError } from "./errors";
import {
  LegalHoldRecord,
  legalHoldViewerFromContext,
  UNIDENTIFIED_LEGAL_HOLD_VIEWER,
} from "./projection";
import type { LegalHoldViewer } from "./projection";
import { legalHoldRefusal, legalHoldRefusalForViewer } from "./refusal";

const REASON = "Preserve the supplier dispute record";
const placerId = "placing-member";

const hold = () =>
  new LegalHoldRecord({
    id: createSafeId<"legalHold">(),
    scope: "matter",
    workspaceId: createSafeId<"workspace">(),
    entityId: null,
    placedAt: new Date("2026-01-01T00:00:00Z"),
    placedBy: placerId,
    reason: REASON,
  });

// The request context a handler receives: the user and the authorized role.
const requestContext = (userId: string, role: "owner" | "admin" | "member") =>
  ({ user: { id: userId }, memberRole: sessionMemberRole(role) }) as const;

const viewers = {
  owner: legalHoldViewerFromContext(requestContext("owner-user", "owner")),
  admin: legalHoldViewerFromContext(requestContext("admin-user", "admin")),
  placer: legalHoldViewerFromContext(requestContext(placerId, "member")),
  member: legalHoldViewerFromContext(requestContext("plain-member", "member")),
} as const satisfies Record<string, LegalHoldViewer>;

const READERS = ["owner", "admin", "placer"] as const;

const refusalFor = (held: LegalHoldRecord) =>
  new LegalHoldActiveError({
    message: "An active legal hold prevents deletion.",
    code: LEGAL_HOLD_ACTIVE,
    holds: [held],
  });

describe("legal hold projection", () => {
  test("owners, admins and the placer read the reason", () => {
    const held = hold();
    for (const name of READERS) {
      expect(held.view(viewers[name]), name).toEqual({
        id: held.id,
        scope: "matter",
        workspaceId: held.workspaceId,
        entityId: null,
        placedAt: "2026-01-01T00:00:00.000Z",
        reasonAccess: "granted",
        reason: REASON,
      });
    }
  });

  test("a plain member sees the hold without its reason", () => {
    const held = hold();
    const view = held.view(viewers.member);
    expect(view).toEqual({
      id: held.id,
      scope: "matter",
      workspaceId: held.workspaceId,
      entityId: null,
      placedAt: "2026-01-01T00:00:00.000Z",
      reasonAccess: "restricted",
    });
    expect(Object.hasOwn(view, "reason")).toBe(false);
    expect(held.view(UNIDENTIFIED_LEGAL_HOLD_VIEWER).reasonAccess).toBe(
      "restricted",
    );
  });

  test("an owner credential that cannot place holds reads no reason", () => {
    const attenuatedOwner = legalHoldViewerFromContext({
      user: { id: "owner-user" },
      memberRole: authorizedMemberRole({
        role: "owner",
        credential: {
          type: "attenuated",
          permissions: { workspace: ["read"] },
        },
      }),
    });
    expect(hold().view(attenuatedOwner).reasonAccess).toBe("restricted");
  });

  test("a context without an authorized member is unidentified", () => {
    expect(legalHoldViewerFromContext({ user: { id: placerId } })).toEqual(
      UNIDENTIFIED_LEGAL_HOLD_VIEWER,
    );
    expect(
      legalHoldViewerFromContext({ memberRole: sessionMemberRole("owner") }),
    ).toEqual(UNIDENTIFIED_LEGAL_HOLD_VIEWER);
  });

  test("no serialized hold or refusal error carries the reason", () => {
    const held = hold();
    const error = refusalFor(held);
    expect(JSON.stringify(held)).not.toContain(REASON);
    expect(JSON.stringify(error)).not.toContain(REASON);
    expect(JSON.stringify(legalHoldRefusal(error))).not.toContain(REASON);
  });
});

describe("legal hold deletion refusal", () => {
  test("every viewer sees the hold; only readers get its reason", () => {
    const held = hold();
    // The refusal a deletion path builds and the central resolver returns
    // names the hold without its reason until the answer knows its viewer.
    const refusal =
      resolveHandlerError(refusalFor(held)) ??
      panic("Expected a legal-hold refusal");
    expect(refusal.issues).toEqual([
      {
        path: held.id,
        code: "matter",
        message: "2026-01-01T00:00:00.000Z",
      },
    ]);

    for (const name of READERS) {
      const answered = legalHoldRefusalForViewer(refusal, viewers[name]);
      expect(answered, name).toMatchObject({
        status: 409,
        code: LEGAL_HOLD_ACTIVE,
      });
      expect(answered.issues, name).toEqual([
        {
          path: held.id,
          code: "matter",
          message: "2026-01-01T00:00:00.000Z",
        },
        {
          path: `${held.id}.reason`,
          code: LEGAL_HOLD_REASON_ISSUE_CODE,
          message: REASON,
        },
      ]);
    }

    const memberAnswer = legalHoldRefusalForViewer(refusal, viewers.member);
    expect(memberAnswer).toMatchObject({
      status: 409,
      code: LEGAL_HOLD_ACTIVE,
    });
    expect(memberAnswer.issues).toEqual([
      {
        path: held.id,
        code: "matter",
        message: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(memberAnswer)).not.toContain(REASON);
  });

  test("other errors pass through unchanged", () => {
    const conflict = new HandlerError({ status: 409, message: "Conflict" });
    expect(legalHoldRefusalForViewer(conflict, viewers.owner)).toBe(conflict);
  });
});
