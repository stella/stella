import { describe, expect, test } from "bun:test";

import {
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyWorkObligationValues } from "@/api/lib/work-obligations/legacy-work-obligation";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

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
      createdBy: mintAuthProviderId<"user">(),
      createdAt,
      updatedAt: null,
      assigneeUserIds: [],
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

  test("derives ownership only from one unambiguous assignee", () => {
    const assignee = mintAuthProviderId<"user">();
    const task = {
      id: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      agendaKind: "task",
      agendaSource: null,
      status: "open",
      dueDate: null,
      createdBy: mintAuthProviderId<"user">(),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: null,
      assigneeUserIds: [assignee],
    };

    expect(legacyWorkObligationValues(task)).toMatchObject({
      ownerUserId: assignee,
      status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    });
    expect(
      legacyWorkObligationValues({
        ...task,
        assigneeUserIds: [assignee, mintAuthProviderId<"user">()],
      }),
    ).toMatchObject({
      ownerUserId: null,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
    });
  });
});
