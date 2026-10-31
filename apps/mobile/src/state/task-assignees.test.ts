import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import { ApiRequestError } from "./api-request";
import {
  chosenAssignees,
  chosenDueDate,
  createTask,
  listMatterMembers,
  newTaskAssignees,
  readTask,
  setTaskAssignee,
} from "./tasks";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) =>
  createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });

type Sent = { url: string; method: string; body: unknown };

const recording = (answer: unknown) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    sent.push({
      url: input,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(answer);
  };
  return { fetch, sent };
};

describe("task assignees", () => {
  test("a task's assignees are read with their names, and none is an empty list", async () => {
    const withPeople = recording({
      id: "task-1",
      status: "open",
      assignees: [
        { userId: "user-2", user: { id: "user-2", name: "Eva Nováková" } },
        { userId: "user-3", user: null },
      ],
    });
    const read = await readTask({
      fetch: withPeople.fetch,
      matterId: "matter-1",
      source: sourceFor(withPeople.fetch),
      taskId: "task-1",
    });
    expect(read.isOk() ? read.value.assignees : null).toEqual([
      { userId: "user-2", user: { id: "user-2", name: "Eva Nováková" } },
      { userId: "user-3", user: null },
    ]);

    const without = recording({ id: "task-1", status: "open" });
    const bare = await readTask({
      fetch: without.fetch,
      matterId: "matter-1",
      source: sourceFor(without.fetch),
      taskId: "task-1",
    });
    expect(bare.isOk() ? bare.value.assignees : null).toEqual([]);
  });

  test("the matter's members come from its members route", async () => {
    const { fetch, sent } = recording([
      { userId: "user-2", user: { id: "user-2", name: "Eva Nováková" } },
    ]);
    const members = await listMatterMembers({
      fetch,
      matterId: "matter 1",
      source: sourceFor(fetch),
    });
    expect(members.isOk() ? members.value.length : 0).toBe(1);
    expect(sent.at(0)?.url).toBe(
      "https://stella.example.com/v1/workspaces/matter%201/members",
    );
  });

  test("assigning posts and unassigning deletes the same person on the task", async () => {
    const { fetch, sent } = recording({});
    const source = sourceFor(fetch);
    for (const assigned of [true, false]) {
      const result = await setTaskAssignee({
        assigned,
        fetch,
        matterId: "matter-1",
        source,
        taskId: "task-1",
        userId: "user-2",
      });
      expect(result.isOk()).toBe(true);
    }
    expect(
      sent.map(({ method, url, body }) => ({ method, url, body })),
    ).toEqual([
      {
        method: "POST",
        url: "https://stella.example.com/v1/tasks/matter-1/assignees",
        body: { taskId: "task-1", userId: "user-2" },
      },
      {
        method: "DELETE",
        url: "https://stella.example.com/v1/tasks/matter-1/assignees",
        body: { taskId: "task-1", userId: "user-2" },
      },
    ]);
  });

  test("a new task sends its assignees and due day, and leaves out what is unset", async () => {
    const chosen = recording({ entityId: "task-9" });
    const created = await createTask({
      assigneeIds: ["user-2", "user-1"],
      dueDate: "2026-11-06",
      fetch: chosen.fetch,
      matterId: "matter-1",
      name: "Draft the reply",
      source: sourceFor(chosen.fetch),
    });
    expect(created.isOk() ? created.value : null).toBe("task-9");
    expect(chosen.sent.at(-1)?.body).toEqual({
      assigneeIds: ["user-2", "user-1"],
      dueDate: "2026-11-06",
      name: "Draft the reply",
    });

    const nobody = recording({ entityId: "task-10" });
    await createTask({
      assigneeIds: [],
      dueDate: null,
      fetch: nobody.fetch,
      matterId: "matter-1",
      name: "Unassigned",
      source: sourceFor(nobody.fetch),
    });
    expect(nobody.sent.at(-1)?.body).toEqual({
      assigneeIds: [],
      name: "Unassigned",
    });

    const unset = recording({ entityId: "task-11" });
    await createTask({
      dueDate: null,
      fetch: unset.fetch,
      matterId: "matter-1",
      name: "Mine",
      source: sourceFor(unset.fetch),
    });
    expect(unset.sent.at(-1)?.body).toEqual({ name: "Mine" });
  });

  test("only chosen people who are the matter's members get a new task, in the members' order", () => {
    const members = [
      { userId: "user-3", user: { id: "user-3", name: "Šárka Dvořáková" } },
      { userId: "user-1", user: { id: "user-1", name: "Jan" } },
      { userId: "user-2", user: null },
    ];
    expect(
      chosenAssignees(new Set(["user-1", "user-3", "user-9"]), members),
    ).toEqual(["user-3", "user-1"]);
    expect(chosenAssignees(new Set(), members)).toEqual([]);
    expect(chosenAssignees(new Set(["user-1"]), [])).toEqual([]);
  });

  test("a new task leaves its assignees to the server only when there is no member list", () => {
    const members = [
      { userId: "user-1", user: { id: "user-1", name: "Jan" } },
      { userId: "user-2", user: null },
    ];
    const chosen = new Set(["user-2"]);
    expect(newTaskAssignees(chosen, Result.ok(members))).toEqual(["user-2"]);
    expect(newTaskAssignees(new Set(), Result.ok(members))).toEqual([]);
    expect(newTaskAssignees(chosen, null)).toBeUndefined();
    expect(
      newTaskAssignees(
        chosen,
        Result.err(
          new ApiRequestError({ message: "Bad gateway", status: 502 }),
        ),
      ),
    ).toBeUndefined();
  });

  test("a new task's due day is the picked day, else the preset, else none", () => {
    const today = Temporal.PlainDate.from("2026-12-31");
    expect(chosenDueDate({ days: null, picked: "2027-02-14" }, today)).toBe(
      "2027-02-14",
    );
    expect(chosenDueDate({ days: 1, picked: null }, today)).toBe("2027-01-01");
    expect(chosenDueDate({ days: 0, picked: null }, today)).toBe("2026-12-31");
    expect(chosenDueDate({ days: null, picked: null }, today)).toBeNull();
  });
});
