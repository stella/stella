import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withMatterAccess } from "@/api/lib/workspaces/matter-access-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("proof_org");
const userId = toSafeId<"user">("proof_user");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);

describe("matter access evidence", () => {
  for (const need of ["read", "write"] as const) {
    for (const allowed of [false, true]) {
      for (const role of ["owner", "external"] as const) {
        test(`${need} evidence with database access ${String(allowed)} and ${role} permission`, async () => {
          let executions = 0;
          const tx = asTestRaw<Transaction>({
            select: () => ({
              from: () => ({
                where: () => ({
                  limit: async () => (allowed ? [{ id: workspaceId }] : []),
                }),
              }),
            }),
          });
          const outcome = await withMatterAccess(
            {
              tx,
              organizationId,
              userId,
              workspaceId,
              need,
              role: sessionMemberRole(role),
            },
            async (context) => {
              executions += 1;
              expect(context.tx.value).toBe(tx);
              expect(context.matter.value).toBe(workspaceId);
              expect(context.actor.value).toBe(userId);
              expect(context.proof.organizationId.value).toBe(organizationId);
              expect(context.proof.kind).toBe(
                need === "write" ? "MatterWritable" : "MatterReadable",
              );
              return Result.ok("executed");
            },
          );
          const authorized = allowed && (need === "read" || role === "owner");
          expect(executions).toBe(authorized ? 1 : 0);
          expect(outcome.isOk()).toBe(authorized);
          if (outcome.isErr()) {
            expect(outcome.error.status).toBe(403);
          }
        });
      }
    }
  }

  test("checks access after successful locks and propagates lock refusals", async () => {
    for (const lockResult of [
      Result.ok(undefined),
      Result.err(new HandlerError({ status: 409, message: "Lock refused" })),
    ]) {
      const events: string[] = [];
      const tx = asTestRaw<Transaction>({
        select: () => {
          events.push("check");
          return {
            from: () => ({
              where: () => ({ limit: async () => [{ id: workspaceId }] }),
            }),
          };
        },
      });
      const outcome = await withMatterAccess(
        {
          tx,
          organizationId,
          userId,
          workspaceId,
          need: "read",
          role: sessionMemberRole("owner"),
          lock: async (transaction) => {
            expect(transaction).toBe(tx);
            events.push("lock");
            return lockResult;
          },
        },
        async () => {
          events.push("execute");
          return Result.ok(undefined);
        },
      );
      expect(events).toEqual(
        lockResult.isOk() ? ["lock", "check", "execute"] : ["lock"],
      );
      if (lockResult.isErr()) {
        expect(outcome).toEqual(lockResult);
      }
    }
  });
});
