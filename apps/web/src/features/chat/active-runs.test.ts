import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const { activeChatRunsOptions } = await import("./active-runs");

afterEach(() => {
  mock.restore();
});

test("reads every page, so working chats behind the waiting ones still count", async () => {
  const cursors: (string | null)[] = [];
  const respond = async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    return Response.json(
      cursor === null
        ? { items: [{ threadId: "waiting" }], nextCursor: "second-page" }
        : { items: [{ threadId: "working" }], nextCursor: null },
    );
  };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: () => {} }),
  );

  const runs = await new QueryClient().fetchQuery(
    activeChatRunsOptions({ activeOrganizationId: "firm", userId: "reader" }),
  );

  expect(cursors).toEqual([null, "second-page"]);
  expect(runs.map((run) => run.threadId)).toEqual(["waiting", "working"]);
});
