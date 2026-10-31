import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import { listMatterMembers, readTask, setTaskAssignee } from "./tasks";

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
});
