import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createUuid } from "@/lib/uuid";

import {
  handleWorkspaceMutationEvent,
  runWorkspaceMutation,
} from "./workspace-mutation";

const controlledMutation = (client: QueryClient) => {
  const registered = Promise.withResolvers<string>();
  const response = Promise.withResolvers<string>();
  const refreshStarted = Promise.withResolvers<string>();
  const refreshFinished = Promise.withResolvers<undefined>();
  const completion = runWorkspaceMutation({
    client,
    request: async (mutationId) => {
      registered.resolve(mutationId);
      return await response.promise;
    },
    refresh: async (data) => {
      refreshStarted.resolve(data);
      await refreshFinished.promise;
    },
  });
  return { registered, response, refreshStarted, refreshFinished, completion };
};

const matchingEvent = (mutationId: string) =>
  resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY, mutationId);

test("events arriving before the response or refresh defer to the successful mutation", async () => {
  const client = new QueryClient();
  const mutation = controlledMutation(client);
  const mutationId = await mutation.registered.promise;
  const applied: string[] = [];
  handleWorkspaceMutationEvent(client, matchingEvent(mutationId), () => {
    applied.push("before response");
  });
  expect(applied).toEqual([]);
  mutation.response.resolve("created");
  expect(await mutation.refreshStarted.promise).toBe("created");
  handleWorkspaceMutationEvent(client, matchingEvent(mutationId), () => {
    applied.push("during refresh");
  });
  expect(applied).toEqual([]);
  mutation.refreshFinished.resolve(undefined);
  expect(await mutation.completion).toBe("created");
  handleWorkspaceMutationEvent(client, matchingEvent(mutationId), () => {
    applied.push("after refresh");
  });
  expect(applied).toEqual([]);
  client.clear();
});

const verifyFailureReplay = async (failureAt: "request" | "refresh") => {
  const client = new QueryClient();
  const mutation = controlledMutation(client);
  const mutationId = await mutation.registered.promise;
  const applied: number[] = [];
  for (const index of [1, 2]) {
    handleWorkspaceMutationEvent(client, matchingEvent(mutationId), () => {
      applied.push(index);
    });
  }
  expect(applied).toEqual([]);
  const error = new TypeError(`${failureAt} failed`);
  const rejection = rejectionOf(mutation.completion);
  if (failureAt === "request") {
    mutation.response.reject(error);
  } else {
    mutation.response.resolve("created");
    await mutation.refreshStarted.promise;
    mutation.refreshFinished.reject(error);
  }
  expect(await rejection).toBe(error);
  expect(applied).toEqual([1, 2]);
  handleWorkspaceMutationEvent(client, matchingEvent(mutationId), () => {
    applied.push(3);
  });
  expect(applied).toEqual([1, 2, 3]);
  client.clear();
};
test("a request failure releases deferred events and preserves the error", async () => {
  await verifyFailureReplay("request");
});
test("a refresh failure releases deferred events and preserves the error", async () => {
  await verifyFailureReplay("refresh");
});

test("only the initiating query client consumes an acknowledged echo", async () => {
  const initiator = new QueryClient();
  const recipient = new QueryClient();
  let mutationId = "";
  await runWorkspaceMutation({
    client: initiator,
    request: async (id) => {
      mutationId = id;
      return "created";
    },
    refresh: async () => undefined,
  });
  const applied: string[] = [];
  handleWorkspaceMutationEvent(initiator, matchingEvent(mutationId), () => {
    applied.push("initiator");
  });
  handleWorkspaceMutationEvent(recipient, matchingEvent(mutationId), () => {
    applied.push("recipient");
  });
  handleWorkspaceMutationEvent(initiator, matchingEvent(createUuid()), () => {
    applied.push("unrelated");
  });
  handleWorkspaceMutationEvent(
    initiator,
    resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
    () => {
      applied.push("uncorrelated");
    },
  );
  expect(applied).toEqual(["recipient", "unrelated", "uncorrelated"]);
  initiator.clear();
  recipient.clear();
});

test("a pending mutation remains registered while old acknowledgements are evicted", async () => {
  const client = new QueryClient();
  const pending = controlledMutation(client);
  const pendingId = await pending.registered.promise;
  const acknowledged: string[] = [];
  for (let index = 0; index < 1001; index += 1) {
    await runWorkspaceMutation({
      client,
      request: async (id) => {
        acknowledged.push(id);
        return "created";
      },
      refresh: async () => undefined,
    });
  }
  const oldest = acknowledged.at(0);
  const newest = acknowledged.at(-1);
  expect(oldest).toBeDefined();
  expect(newest).toBeDefined();
  if (oldest === undefined || newest === undefined) {
    return;
  }
  const applied: string[] = [];
  handleWorkspaceMutationEvent(client, matchingEvent(oldest), () => {
    applied.push("oldest");
  });
  handleWorkspaceMutationEvent(client, matchingEvent(newest), () => {
    applied.push("newest");
  });
  handleWorkspaceMutationEvent(client, matchingEvent(pendingId), () => {
    applied.push("pending");
  });
  expect(applied).toEqual(["oldest"]);
  pending.response.resolve("created");
  pending.refreshFinished.resolve(undefined);
  await pending.completion;
  expect(applied).toEqual(["oldest"]);
  client.clear();
});
