import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { archiveWorkspaceHandler } from "./archive";

const workspaceId = toSafeId<"workspace">("workspace_test");

describe("archiveWorkspaceHandler", () => {
  test("does not archive while OCR has an active dispatch claim", async () => {
    let selectCount = 0;
    const tx = asTestRaw<Transaction>({
      select: () => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: async () => [{ id: workspaceId, status: "active" }],
                }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ id: "run_test" }],
            }),
          }),
        };
      },
    });
    const safeDb: SafeDb = async (operation) => Result.ok(await operation(tx));
    const recordAuditEvent: AuditRecorder = async () => undefined;

    const result = await Result.gen(() =>
      archiveWorkspaceHandler({ safeDb, workspaceId, recordAuditEvent }),
    );

    expect(Result.isError(result)).toBe(true);
    expect(result).toMatchObject({ error: { status: 409 } });
  });
});
