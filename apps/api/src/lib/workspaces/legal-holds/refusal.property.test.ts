import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  LEGAL_HOLD_ACTIVE,
  LEGAL_HOLD_REASON_ISSUE_CODE,
} from "@stll/api-contract/legal-holds";
import { assertProperty } from "@stll/property-testing";

import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

import {
  LegalHoldActiveError,
  LegalHoldRecord,
  type LegalHoldViewer,
  UNIDENTIFIED_LEGAL_HOLD_VIEWER,
} from "./errors";
import { legalHoldViewerFromContext } from "./projection";
import { legalHoldRefusal, legalHoldRefusalForViewer } from "./refusal";

const userIdArb = fc.constantFrom("user-a", "user-b", "user-c", "user-d");
const roleArb = fc.constantFrom<"owner" | "admin" | "member">(
  "owner",
  "admin",
  "member",
);
const reasonArb = fc
  .string({ minLength: 5, maxLength: 40 })
  .map((s) => `secret-reason-${s}`);

const holdArb = fc
  .record({
    scope: fc.constantFrom<"matter" | "entity">("matter", "entity"),
    hasEntity: fc.boolean(),
    placedAtMs: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
    placedBy: userIdArb,
    reason: reasonArb,
  })
  .map((raw) => {
    const id = createSafeId<"legalHold">();
    const record = new LegalHoldRecord({
      id,
      scope: raw.scope,
      workspaceId: createSafeId<"workspace">(),
      entityId: raw.hasEntity ? createSafeId<"entity">() : null,
      placedAt: new Date(raw.placedAtMs),
      placedBy: raw.placedBy,
      reason: raw.reason,
    });
    return { raw: { ...raw, id }, record };
  });

const viewerArb: fc.Arbitrary<LegalHoldViewer> = fc.oneof(
  fc.constant(UNIDENTIFIED_LEGAL_HOLD_VIEWER),
  fc.record({ userId: userIdArb, role: roleArb }).map(({ userId, role }) =>
    legalHoldViewerFromContext({
      user: { id: userId },
      memberRole: sessionMemberRole(role),
    }),
  ),
);

describe("legal hold refusal projection properties", () => {
  test("unidentified viewers never receive any hold reason issue or reason text", () => {
    assertProperty(
      "unidentified viewers never receive any hold reason issue or reason text",
      fc.property(
        fc.array(holdArb, { minLength: 1, maxLength: 6 }),
        (holds) => {
          const error = new LegalHoldActiveError({
            message: "Blocked by legal hold",
            code: LEGAL_HOLD_ACTIVE,
            holds: holds.map((h) => h.record),
          });
          const refusal = legalHoldRefusal(error);
          expect(refusal.status).toBe(409);
          expect(refusal.code).toBe(LEGAL_HOLD_ACTIVE);
          expect(refusal.issues).toHaveLength(holds.length);
          for (const issue of refusal.issues ?? []) {
            expect(issue.code).not.toBe(LEGAL_HOLD_REASON_ISSUE_CODE);
          }
          const serialized = JSON.stringify(refusal.issues);
          for (const { raw } of holds) {
            expect(serialized).not.toContain(raw.reason);
          }
        },
      ),
    );
  });

  test("member viewer sees reason issues if and only if they manage holds or placed that hold", () => {
    assertProperty(
      "member viewer sees reason issues if and only if they manage holds or placed that hold",
      fc.property(
        fc.array(holdArb, { minLength: 1, maxLength: 6 }),
        viewerArb,
        (holds, viewer) => {
          const error = new LegalHoldActiveError({
            message: "Blocked by legal hold",
            code: LEGAL_HOLD_ACTIVE,
            holds: holds.map((h) => h.record),
          });
          const refusal = legalHoldRefusal(error, viewer);
          const issues = refusal.issues ?? [];

          for (const { raw, record } of holds) {
            const canRead =
              viewer.type === "member" &&
              (viewer.managesHolds || viewer.userId === raw.placedBy);
            expect(record.readableBy(viewer)).toBe(canRead);

            const placedIssue = issues.find((i) => i.path === raw.id);
            expect(placedIssue).toEqual({
              path: raw.id,
              code: raw.scope,
              message: new Date(raw.placedAtMs).toISOString(),
            });

            const reasonIssue = issues.find(
              (i) => i.path === `${raw.id}.reason`,
            );
            if (canRead) {
              expect(reasonIssue).toEqual({
                path: `${raw.id}.reason`,
                code: LEGAL_HOLD_REASON_ISSUE_CODE,
                message: raw.reason,
              });
            } else {
              expect(reasonIssue).toBeUndefined();
            }
          }
        },
      ),
    );
  });

  test("re-projecting a refusal for a different viewer never leaks prior viewer reasons", () => {
    assertProperty(
      "re-projecting a refusal for a different viewer never leaks prior viewer reasons",
      fc.property(
        fc.array(holdArb, { minLength: 1, maxLength: 5 }),
        viewerArb,
        viewerArb,
        (holds, firstViewer, secondViewer) => {
          const error = new LegalHoldActiveError({
            message: "Blocked by legal hold",
            code: LEGAL_HOLD_ACTIVE,
            holds: holds.map((h) => h.record),
          });
          const initial = legalHoldRefusal(error, firstViewer);
          const reprojected = legalHoldRefusalForViewer(initial, secondViewer);
          const direct = legalHoldRefusal(error, secondViewer);
          expect(reprojected.issues).toEqual(direct.issues);
          expect(reprojected.status).toBe(409);
        },
      ),
    );
  });

  test("legalHoldRefusalForViewer leaves non-legal-hold HandlerErrors untouched", () => {
    assertProperty(
      "legalHoldRefusalForViewer leaves non-legal-hold HandlerErrors untouched",
      fc.property(
        fc.constantFrom(
          "not_found",
          "forbidden",
          "validation_error",
          "conflict",
        ),
        fc.string({ minLength: 1, maxLength: 40 }),
        viewerArb,
        (code, message, viewer) => {
          const original = new HandlerError({
            status: 400,
            code,
            message,
          });
          expect(legalHoldRefusalForViewer(original, viewer)).toBe(original);
        },
      ),
    );
  });
});
