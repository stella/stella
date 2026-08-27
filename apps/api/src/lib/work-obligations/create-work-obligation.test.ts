import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import {
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { createWorkObligation } from "@/api/lib/work-obligations/create-work-obligation";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("createWorkObligation", () => {
  test("creates unassigned work without ownership or acknowledgement events", async () => {
    const inserts: unknown[] = [];
    const tx = asTestRaw<Transaction>({
      insert: () => ({
        values: async (values: unknown) => {
          inserts.push(values);
        },
      }),
    });

    await createWorkObligation({
      tx,
      entityId: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      actorUserId: mintAuthProviderId<"user">(),
      ownerUserId: null,
      agendaKind: "task",
      taskStatus: "open",
      workingTargetDate: null,
      hardDeadlineDate: null,
    });

    expect(inserts.at(0)).toMatchObject({
      ownerUserId: null,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
      acknowledgedAt: null,
      acknowledgedByUserId: null,
    });
    expect(inserts.at(1)).toEqual([
      expect.objectContaining({ type: WORK_OBLIGATION_EVENT_TYPE.CREATED }),
    ]);
  });
});
