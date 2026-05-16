import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import calendarTasks from "./calendar";

const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
const organizationId = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000002",
);
const userId = toSafeId<"user">("user_calendar");
const taskId = toSafeId<"entity">("00000000-0000-4000-8000-000000000101");
const fieldId = toSafeId<"field">("00000000-0000-4000-8000-000000000201");
const customPropertyId = toSafeId<"property">(
  "00000000-0000-4000-8000-000000000301",
);

const createContext = ({
  body,
  safeDb,
}: {
  body: Parameters<typeof calendarTasks.handler>[0]["body"];
  safeDb: Parameters<typeof calendarTasks.handler>[0]["safeDb"];
}): Parameters<typeof calendarTasks.handler>[0] =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture only provides fields used by the safe handler and calendar task handler
  ({
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body,
    safeDb,
    request: new Request("https://example.test/v1/tasks/calendar"),
    route: "/v1/tasks/:workspaceId/calendar",
  }) as Parameters<typeof calendarTasks.handler>[0];

const baseBody = {
  dateFrom: "2026-05-01T00:00:00.000Z",
  dateTo: "2026-05-31T00:00:00.000Z",
  datePropertyIds: ["_start-date"],
  filters: [],
  sorts: [],
} satisfies Parameters<typeof calendarTasks.handler>[0]["body"];

const taskRows = [
  {
    id: taskId,
    name: "Prepare hearing",
    status: "open",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    dueDate: null,
    startAt: new Date("2026-05-03T09:00:00.000Z"),
    endAt: null,
    occurredAt: null,
  },
];

describe("calendar task handler", () => {
  test("returns bounded task rows and requested custom date fields", async () => {
    const results: unknown[] = [
      [{ id: taskId }],
      [
        taskRows,
        [
          {
            entityId: taskId,
            id: fieldId,
            propertyId: customPropertyId,
            content: {
              type: "date" as const,
              version: 1 as const,
              value: "2026-05-04",
            },
          },
        ],
      ],
    ];
    const safeDb: Parameters<
      typeof calendarTasks.handler
    >[0]["safeDb"] = async <T>() => Result.ok(asTestRaw<T>(results.shift()));

    const result = await calendarTasks.handler(
      createContext({
        body: {
          ...baseBody,
          datePropertyIds: ["_start-date", customPropertyId],
        },
        safeDb,
      }),
    );

    expect("tasks" in result).toBe(true);
    if (!("tasks" in result)) {
      return;
    }

    expect(result.tasks).toEqual([
      {
        taskId,
        name: "Prepare hearing",
        status: "open",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        dueDate: null,
        startAt: "2026-05-03T09:00:00.000Z",
        endAt: null,
        occurredAt: null,
        fields: [
          {
            entityId: taskId,
            id: fieldId,
            propertyId: customPropertyId,
            content: {
              type: "date",
              version: 1,
              value: "2026-05-04T00:00:00.000Z",
            },
          },
        ],
      },
    ]);
  });

  test("rejects inverted date ranges", async () => {
    const safeDb: Parameters<
      typeof calendarTasks.handler
    >[0]["safeDb"] = async () => {
      throw new Error("safeDb should not be called");
    };

    const result = await calendarTasks.handler(
      createContext({
        body: {
          ...baseBody,
          dateFrom: "2026-06-01T00:00:00.000Z",
          dateTo: "2026-05-01T00:00:00.000Z",
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid calendar date range" },
    });
  });
});
