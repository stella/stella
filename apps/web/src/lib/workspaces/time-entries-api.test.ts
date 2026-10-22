import { expect, spyOn, test } from "bun:test";

import { sendTimeEntryMutation } from "./time-entries-api";

type Mutation = Parameters<typeof sendTimeEntryMutation>[0]["mutation"];
type MutationCase<Type extends Mutation["type"]> = {
  mutation: Extract<Mutation, { type: Type }>;
  method: string;
  path: string;
  response: unknown;
};

const cases = {
  create: {
    mutation: { type: "create", body: {} },
    method: "PUT",
    path: "/",
    response: { id: "created" },
  },
  update: {
    mutation: { type: "update", body: {} },
    method: "PATCH",
    path: "/",
    response: { id: "updated" },
  },
  delete: {
    mutation: { type: "delete", body: {} },
    method: "DELETE",
    path: "/",
    response: { deleted: true },
  },
  batch_update: {
    mutation: { type: "batch_update", body: {} },
    method: "POST",
    path: "/batch",
    response: { updated: 1 },
  },
  batch_delete: {
    mutation: { type: "batch_delete", body: {} },
    method: "DELETE",
    path: "/batch",
    response: { updated: 1 },
  },
  split: {
    mutation: { type: "split", body: {} },
    method: "POST",
    path: "/split",
    response: { entryIds: ["split"], splitGroupId: "group" },
  },
  suggestion_decision: {
    mutation: { type: "suggestion_decision", body: {} },
    method: "POST",
    path: "/suggestions/decisions",
    response: {
      fingerprint: "intent",
      status: "accepted",
      timeEntryId: "created",
    },
  },
} as const satisfies { [Type in Mutation["type"]]: MutationCase<Type> };

for (const { mutation, method, path, response } of Object.values(cases)) {
  test(`${mutation.type} sends its transport request without optional headers`, async () => {
    const requests: {
      url: string;
      headers: Headers;
      method: string | undefined;
    }[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
          requests.push({
            url: input instanceof Request ? input.url : String(input),
            headers: new Headers(init?.headers),
            method: init?.method,
          });
          return Response.json(response);
        },
        { preconnect: () => undefined },
      ),
    );
    try {
      await sendTimeEntryMutation({ mutation, workspaceId: "matter" });
      expect(requests).toHaveLength(1);
      const request = requests.at(0);
      expect(request?.url).toEndWith(`/time-entries/matter${path}`);
      expect(request?.method).toBe(method);
      expect(request?.headers.has("Idempotency-Key")).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });
}

test("time-entry creates forward an explicitly supplied intent key", async () => {
  const headers: Headers[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...[_input, init]: Parameters<typeof globalThis.fetch>) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ id: "created" });
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    await sendTimeEntryMutation({
      workspaceId: "matter",
      mutation: { type: "create", body: {} },
      headers: { "Idempotency-Key": "intent" },
    });
    expect(headers).toHaveLength(1);
    expect(headers.at(0)?.get("Idempotency-Key")).toBe("intent");
  } finally {
    fetch.mockRestore();
  }
});
