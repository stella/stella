import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceMutationDigest,
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
  const queryKey = ["projection", createUuid()];
  const fetchProjection = async () => {
    refreshStarted.resolve("created");
    await refreshFinished.promise;
    return "refreshed";
  };
  const observer = new QueryObserver(client, {
    queryKey,
    initialData: "initial",
    staleTime: Infinity,
    retry: false,
    queryFn: fetchProjection,
  });
  observer.subscribe(() => undefined);
  const completion = runWorkspaceMutation({
    client,
    request: async (mutationId) => {
      registered.resolve(mutationId);
      return await response.promise;
    },
    queryKeys: [queryKey],
  });
  return { registered, response, refreshStarted, refreshFinished, completion };
};

const matchingEvent = async (mutationId: string) =>
  resourceSetUpdatedRealtimeEvent(
    RESOURCE_TYPE.ENTITY,
    await resourceMutationDigest(mutationId),
  );

test("events arriving before the response or refresh defer to the successful mutation", async () => {
  const client = new QueryClient();
  const mutation = controlledMutation(client);
  const mutationId = await mutation.registered.promise;
  const applied: string[] = [];
  handleWorkspaceMutationEvent(client, await matchingEvent(mutationId), () => {
    applied.push("before response");
  });
  expect(applied).toEqual([]);
  mutation.response.resolve("created");
  expect(await mutation.refreshStarted.promise).toBe("created");
  handleWorkspaceMutationEvent(client, await matchingEvent(mutationId), () => {
    applied.push("during refresh");
  });
  expect(applied).toEqual([]);
  mutation.refreshFinished.resolve(undefined);
  expect(await mutation.completion).toBe("created");
  handleWorkspaceMutationEvent(client, await matchingEvent(mutationId), () => {
    applied.push("after refresh");
  });
  expect(applied).toEqual([]);
  client.clear();
});

test("a request failure releases deferred events and preserves the error", async () => {
  const client = new QueryClient();
  const mutation = controlledMutation(client);
  const mutationId = await mutation.registered.promise;
  const applied: number[] = [];
  for (const index of [1, 2]) {
    handleWorkspaceMutationEvent(
      client,
      await matchingEvent(mutationId),
      () => {
        applied.push(index);
      },
    );
  }
  expect(applied).toEqual([]);
  const error = new TypeError("request failed");
  const rejection = rejectionOf(mutation.completion);
  mutation.response.reject(error);
  expect(await rejection).toBe(error);
  expect(applied).toEqual([1, 2]);
  handleWorkspaceMutationEvent(client, await matchingEvent(mutationId), () => {
    applied.push(3);
  });
  expect(applied).toEqual([1, 2, 3]);
  client.clear();
});

test("a failed active refresh preserves the write and releases deferred and later echoes", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const queryKey = ["projection"];
  let fetches = 0;
  const refreshStarted = Promise.withResolvers<undefined>();
  const refreshFinished = Promise.withResolvers<string>();
  const fetchProjection = async () => {
    fetches += 1;
    if (fetches === 1) {
      refreshStarted.resolve(undefined);
      return await refreshFinished.promise;
    }
    return "recovered";
  };
  const observer = new QueryObserver(client, {
    queryKey,
    initialData: "initial",
    queryFn: fetchProjection,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    const response = Promise.withResolvers<string>();
    const registered = Promise.withResolvers<string>();
    let mutationId = "";
    const completion = runWorkspaceMutation({
      client,
      request: async (id) => {
        mutationId = id;
        registered.resolve(id);
        return await response.promise;
      },
      queryKeys: [queryKey],
    });
    await registered.promise;
    const refreshes: Promise<void>[] = [];
    const apply = () => {
      refreshes.push(client.invalidateQueries({ queryKey }));
    };
    handleWorkspaceMutationEvent(
      client,
      await matchingEvent(mutationId),
      apply,
    );
    expect(fetches).toBe(0);
    response.resolve("created");
    await refreshStarted.promise;
    handleWorkspaceMutationEvent(
      client,
      await matchingEvent(mutationId),
      apply,
    );
    expect(fetches).toBe(1);
    refreshFinished.reject(new TypeError("refresh failed"));
    expect(await completion).toBe("created");
    expect(refreshes).toHaveLength(2);
    await Promise.all(refreshes);
    expect(fetches).toBeGreaterThan(1);
    expect(observer.getCurrentResult().data).toBe("recovered");
    const beforeLaterEcho = fetches;
    handleWorkspaceMutationEvent(
      client,
      await matchingEvent(mutationId),
      apply,
    );
    await Promise.all(refreshes);
    expect(fetches).toBe(beforeLaterEcho + 1);
    handleWorkspaceMutationEvent(
      client,
      await matchingEvent(createUuid()),
      apply,
    );
    await Promise.all(refreshes);
    expect(fetches).toBe(beforeLaterEcho + 2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("only the initiating query client consumes an acknowledged digest; unknown digests apply", async () => {
  const initiator = new QueryClient();
  const recipient = new QueryClient();
  let mutationId = "";
  await runWorkspaceMutation({
    client: initiator,
    request: async (id) => {
      mutationId = id;
      return "created";
    },
    queryKeys: [],
  });
  const applied: string[] = [];
  handleWorkspaceMutationEvent(
    initiator,
    await matchingEvent(mutationId),
    () => {
      applied.push("initiator");
    },
  );
  handleWorkspaceMutationEvent(
    recipient,
    await matchingEvent(mutationId),
    () => {
      applied.push("recipient");
    },
  );
  handleWorkspaceMutationEvent(
    initiator,
    await matchingEvent("019e7000-0000-7000-8000-0000000000b1"),
    () => {
      applied.push("unrelated");
    },
  );
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
      queryKeys: [],
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
  handleWorkspaceMutationEvent(client, await matchingEvent(oldest), () => {
    applied.push("oldest");
  });
  handleWorkspaceMutationEvent(client, await matchingEvent(newest), () => {
    applied.push("newest");
  });
  handleWorkspaceMutationEvent(client, await matchingEvent(pendingId), () => {
    applied.push("pending");
  });
  expect(applied).toEqual(["oldest"]);
  pending.response.resolve("created");
  pending.refreshFinished.resolve(undefined);
  await pending.completion;
  expect(applied).toEqual(["oldest"]);
  client.clear();
});
