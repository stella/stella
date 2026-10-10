import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { accountAuditLogs } from "@/api/db/schema";
import {
  createAuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const userId = asTestRaw<SafeId<"user">>("account-user");

const captureWrites = () => {
  const writes: {
    table: unknown;
    rows: Record<string, unknown>[];
  }[] = [];
  const tx = asTestRaw<Transaction>({
    insert: (table: unknown) => ({
      values: async (rows: Record<string, unknown>[]) => {
        writes.push({ table, rows });
      },
    }),
  });
  return { tx, writes };
};

describe("account audit scope", () => {
  test("records account ownership and request provenance without event content", async () => {
    const { tx, writes } = captureWrites();
    const recorder = createAuditRecorder({
      account: { userId },
      request: new Request("https://example.test/account", {
        headers: {
          "user-agent": "account-audit-test",
          "x-forwarded-for": "198.51.100.4",
        },
      }),
      server: null,
    });

    await recorder(tx, {
      type: "account.data_export.requested",
      resourceId: "export-1",
    });

    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.table).toBe(accountAuditLogs);
    const rows = writes.at(0)?.rows ?? [];
    expect(rows).toHaveLength(1);
    const row = rows.at(0);
    expect(row).toMatchObject({
      userId,
      eventType: "account.data_export.requested",
      resourceId: "export-1",
      requestMetadata: {
        ipAddress: null,
        forwardedFor: "198.51.100.4",
        userAgent: "account-audit-test",
      },
    });
    expect(Object.keys(row ?? {}).toSorted()).toEqual([
      "eventType",
      "groupId",
      "id",
      "requestMetadata",
      "resourceId",
      "userId",
    ]);
  });

  test("groups each background batch separately and retains no request metadata", async () => {
    const { tx, writes } = captureWrites();
    const recorder = createBackgroundAuditRecorder({ account: { userId } });

    await recorder(tx, [
      { type: "account.data_export.ready", resourceId: "export-1" },
      { type: "account.data_export.downloaded", resourceId: "export-1" },
    ]);
    await recorder(tx, {
      type: "account.data_export.expired",
      resourceId: "export-1",
    });

    expect(writes).toHaveLength(2);
    const firstRows = writes.at(0)?.rows ?? [];
    expect(firstRows).toHaveLength(2);
    expect(firstRows.map((row) => row["eventType"])).toEqual([
      "account.data_export.ready",
      "account.data_export.downloaded",
    ]);
    const firstGroup = firstRows.at(0)?.["groupId"];
    expect(firstGroup).toBeString();
    expect(new Set(firstRows.map((row) => row["groupId"])).size).toBe(1);
    expect(writes.at(1)?.rows.at(0)?.["groupId"]).not.toBe(firstGroup);
    const allRows = writes.flatMap(({ rows }) => rows);
    expect(new Set(allRows.map((row) => row["id"])).size).toBe(3);
    for (const { table, rows } of writes) {
      expect(table).toBe(accountAuditLogs);
      for (const row of rows) {
        expect(row).toMatchObject({
          userId,
          resourceId: "export-1",
          requestMetadata: null,
        });
      }
    }
  });

  test("an empty account batch writes nothing", async () => {
    const { tx, writes } = captureWrites();
    await createBackgroundAuditRecorder({ account: { userId } })(tx, []);
    expect(writes).toEqual([]);
  });
});
