import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import {
  deleteTask,
  dueChoiceOf,
  readTask,
  taskChangeBody,
  taskLinks,
  updateTask,
} from "./tasks";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

/** A server answering every call with `answer` and `status`, recording each. */
const server = (answer: unknown, status = 200) => {
  const sent: { route: string; body: unknown }[] = [];
  const fetch: Fetch = async (input, init) => {
    sent.push({
      route: `${init?.method ?? "GET"} ${input.replace(SESSION.serverUrl, "")}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(answer, { status });
  };
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const source = createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    generation: store.generation(),
    store,
  });
  return { request: { fetch, matterId: "matter/1", source }, sent };
};

describe("changing a task", () => {
  test("each change sends only its own field, a cleared due date as null", () => {
    expect(taskChangeBody({ type: "name", value: "File the reply" })).toEqual({
      name: "File the reply",
    });
    expect(taskChangeBody({ type: "status", value: "in_review" })).toEqual({
      status: "in_review",
    });
    expect(taskChangeBody({ type: "priority", value: "urgent" })).toEqual({
      priority: "urgent",
    });
    expect(taskChangeBody({ type: "dueDate", value: null })).toEqual({
      dueDate: null,
    });
  });

  test("goes to the matter's task update with the task named in the body", async () => {
    const { request, sent } = server({});
    const saved = await updateTask({
      ...request,
      change: { type: "dueDate", value: "2026-11-20" },
      taskId: "task-1",
    });
    expect(saved.isOk()).toBe(true);
    expect(sent).toEqual([
      {
        route: "PATCH /v1/tasks/matter%2F1",
        body: { taskId: "task-1", dueDate: "2026-11-20" },
      },
    ]);
  });

  test("a refusal keeps the server's reason", async () => {
    const { request } = server({ message: "Task is read-only" }, 409);
    const saved = await updateTask({
      ...request,
      change: { type: "name", value: "Renamed" },
      taskId: "task-1",
    });
    expect(
      saved.isErr() && saved.error._tag === "ApiRequestError"
        ? { status: saved.error.status, detail: saved.error.detail }
        : "saved",
    ).toEqual({ status: 409, detail: "Task is read-only" });
  });
});

describe("deleting a task", () => {
  test("goes to the task's own delete route, never the matter's entity delete", async () => {
    const { request, sent } = server({});
    const deleted = await deleteTask({ ...request, taskId: "task/1" });
    expect(deleted.isOk()).toBe(true);
    expect(sent.map(({ route }) => route)).toEqual([
      "DELETE /v1/tasks/matter%2F1/task%2F1",
    ]);
  });
});

describe("reading a task to edit", () => {
  test("keeps its fields, subtasks and links, deleted links left out", async () => {
    const { request } = server({
      id: "task-1",
      name: "Draft the lease",
      status: "in_progress",
      priority: "high",
      dueDate: "2026-11-20",
      readOnly: false,
      assignees: [],
      children: [{ id: "sub-1", name: "Check the annex", status: "done" }],
      linksAsSource: [
        { targetEntity: { id: "doc-1", name: "Lease.docx", kind: "document" } },
        { targetEntity: null },
      ],
      linksAsTarget: [
        { sourceEntity: { id: "doc-1", name: "Lease.docx", kind: "document" } },
        { sourceEntity: { id: "task-9", name: null, kind: "task" } },
      ],
    });
    const read = await readTask({ ...request, taskId: "task-1" });
    if (read.isErr()) {
      throw read.error;
    }
    expect(read.value).toMatchObject({
      name: "Draft the lease",
      status: "in_progress",
      priority: "high",
      dueDate: "2026-11-20",
      children: [{ id: "sub-1", name: "Check the annex", status: "done" }],
    });
    // An item linked both ways shows once.
    expect(taskLinks(read.value)).toEqual([
      { id: "doc-1", name: "Lease.docx", kind: "document" },
      { id: "task-9", name: null, kind: "task" },
    ]);
  });
});

describe("a task's due choice", () => {
  const TODAY = Temporal.PlainDate.from("2026-10-28");

  test("shows as the preset that gives its day, else as a picked day", () => {
    expect(dueChoiceOf(null, TODAY)).toBe("none");
    expect(dueChoiceOf("2026-10-28", TODAY)).toBe("today");
    expect(dueChoiceOf("2026-10-29", TODAY)).toBe("tomorrow");
    expect(dueChoiceOf("2026-11-04", TODAY)).toBe("nextWeek");
    expect(dueChoiceOf("2026-11-05", TODAY)).toBe("pick");
    expect(dueChoiceOf("2026-10-01", TODAY)).toBe("pick");
  });
});
