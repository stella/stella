import { describe, expect, test } from "bun:test";

import {
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyWorkObligationValues } from "@/api/lib/work-obligations/legacy-work-obligation";

describe("legacy work obligation mapping", () => {
  test("replay maps the same legacy deadline to the same governed state", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const task = {
      id: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      agendaKind: "deadline",
      agendaSource: "calendar",
      status: "done",
      dueDate: "2026-02-01",
      createdBy: createSafeId<"user">(),
      createdAt,
      updatedAt: null,
    };

    const first = legacyWorkObligationValues(task);
    const replay = legacyWorkObligationValues(task);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      type: WORK_OBLIGATION_TYPE.DEADLINE,
      status: WORK_OBLIGATION_STATUS.COMPLETED,
      sourceType: WORK_OBLIGATION_SOURCE.CALENDAR,
      workingTargetDate: "2026-02-01",
      hardDeadlineDate: "2026-02-01",
      updatedAt: createdAt,
    });
  });
});
