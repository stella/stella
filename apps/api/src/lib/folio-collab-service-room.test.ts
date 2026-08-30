import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_from_database");
const roomId = toSafeId<"folioCollabRoom">("room_from_database");
const workspaceId = toSafeId<"workspace">("workspace_from_database");
let rows: Record<string, unknown>[] = [];
let transactionCalls = 0;
const transactionSentinel = { type: "transaction" };

const query = {
  from: () => query,
  innerJoin: () => query,
  limit: async () => rows,
  where: () => query,
};

const { resolveFolioCollabServiceRoom } =
  await import("./folio-collab-service-room");

const database = asTestRaw<
  NonNullable<Parameters<typeof resolveFolioCollabServiceRoom>[1]>
>({
  select: () => query,
  transaction: async (
    callback: (tx: typeof transactionSentinel) => unknown,
  ) => {
    transactionCalls += 1;
    return await callback(transactionSentinel);
  },
});

describe("collaboration service room resolution", () => {
  test("derives every tenant boundary from the stored room", async () => {
    rows = [{ organizationId, roomId, workspaceId }];
    transactionCalls = 0;

    const result = await resolveFolioCollabServiceRoom(roomId, database);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      organizationId,
      roomId,
      workspaceId,
    });
    expect(await result.value.scopedDb(async () => "scoped-result")).toBe(
      "scoped-result",
    );
    expect(transactionCalls).toBe(1);
  });

  test("does not mint a snapshot target for an unknown room", async () => {
    rows = [];

    const result = await resolveFolioCollabServiceRoom(roomId, database);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.status).toBe(404);
    }
  });
});
