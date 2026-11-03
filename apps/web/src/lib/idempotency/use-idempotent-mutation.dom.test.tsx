import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { useIdempotentMutation } = await import("./use-idempotent-mutation");
const { useObservedMutationState } =
  await import("./use-observed-mutation-state");

const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

test("create mutation retries retain the key and success starts a new intent", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
  });
  const sent: string[] = [];
  let fail = true;
  const { result } = renderHook(
    () =>
      useIdempotentMutation({
        mutationFn: async (_name: string, request) => {
          sent.push(request.headers["Idempotency-Key"]);
          if (fail) {
            fail = false;
            throw new TypeError("transport failed");
          }
          return "created";
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    await result.current.mutateAsync("Matter");
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(sent).toHaveLength(2);
  expect(sent.at(0)).toBe(sent.at(1));
  await act(async () => {
    await result.current.mutateAsync("Matter");
  });
  expect(sent.at(2)).not.toBe(sent.at(1));

  client.clear();
});

test("overlapping submissions and a later automatic retry keep the captured key", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
  });
  const releaseFirst = Promise.withResolvers<undefined>();
  const keys: string[] = [];
  const callbackVariables: string[] = [];
  const { result } = renderHook(
    () =>
      useIdempotentMutation({
        mutationFn: async (_name: string, request) => {
          keys.push(request.headers["Idempotency-Key"]);
          if (keys.length === 1) {
            await releaseFirst.promise;
            throw new TypeError("first transport failed");
          }
          return "created";
        },
        onSuccess: (_data, variables) => {
          callbackVariables.push(variables);
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const first = result.current.mutateAsync("Matter");
  const second = result.current.mutateAsync("Matter");
  await waitFor(() => expect(keys).toHaveLength(1));
  await act(async () => {
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
  });
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(callbackVariables).toEqual(["Matter", "Matter"]);
  expect(result.current.variables).toBe("Matter");
  await act(async () => {
    await result.current.mutateAsync("Matter");
  });
  expect(keys.at(-1)).not.toBe(keys.at(0));
  client.clear();
});

test("failed submit keys belong to the hook's resource scope", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const keys: string[] = [];
  const { result, rerender } = renderHook(
    ({ scope }: { scope: string }) =>
      useIdempotentMutation({
        idempotencyScope: scope,
        mutationFn: async (_name: string, request) => {
          keys.push(request.headers["Idempotency-Key"]);
          throw new TypeError("transport failed");
        },
      }),
    {
      initialProps: { scope: "matter-a" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    expect(await rejectionOf(result.current.mutateAsync("Task"))).toMatchObject(
      { name: "TypeError", message: "transport failed" },
    );
  });
  rerender({ scope: "matter-b" });
  await act(async () => {
    expect(await rejectionOf(result.current.mutateAsync("Task"))).toMatchObject(
      { name: "TypeError", message: "transport failed" },
    );
  });
  rerender({ scope: "matter-a" });
  await act(async () => {
    expect(await rejectionOf(result.current.mutateAsync("Task"))).toMatchObject(
      { name: "TypeError", message: "transport failed" },
    );
  });
  expect(keys.at(0)).not.toBe(keys.at(1));
  expect(keys.at(0)).toBe(keys.at(2));
  const failedKey = keys.at(-1);
  act(() => result.current.reset());
  await act(async () => {
    expect(await rejectionOf(result.current.mutateAsync("Task"))).toMatchObject(
      { name: "TypeError", message: "transport failed" },
    );
  });
  expect(keys.at(-1)).not.toBe(failedKey);
  client.clear();
});

test("mutation state observers see original submitted variables through pending and completed creates", async () => {
  const client = new QueryClient();
  const response = Promise.withResolvers<string>();
  const variables = { targetIds: ["claim-1"] };
  const { result } = renderHook(
    () => ({
      create: useIdempotentMutation({
        mutationKey: ["observed-create"],
        mutationFn: async (_variables: typeof variables) =>
          await response.promise,
      }),
      states: useObservedMutationState({
        filters: { mutationKey: ["observed-create"] },
        select: (state) => ({
          variables: state.variables,
          status: state.status,
        }),
      }),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const pending = result.current.create.mutateAsync(variables);
  await waitFor(() =>
    expect(result.current.states.at(0)?.status).toBe("pending"),
  );
  expect(result.current.states.at(0)?.variables).toBe(variables);
  await act(async () => {
    response.resolve("created");
    await pending;
  });
  await waitFor(() =>
    expect(result.current.states.at(0)?.status).toBe("success"),
  );
  expect(result.current.states.at(0)?.variables).toBe(variables);
  client.clear();
});

test("failed submit intents stay with their authenticated principal and organization", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  let organization = "organization-a";
  const keys: string[] = [];
  const { result, rerender } = renderHook(
    () =>
      useIdempotentMutation({
        mutationFn: async (_name: string, request) => {
          keys.push(request.headers["Idempotency-Key"]);
          throw new TypeError("transport failed");
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <AuthenticatedUserProvider
            user={{
              id: "user",
              activeOrganizationId: organization,
              email: "user@example.com",
              image: null,
              name: "User",
              preferredName: null,
              timezoneId: "Europe/Prague",
              wordEditShortcut: null,
            }}
          >
            {children}
          </AuthenticatedUserProvider>
        </QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    expect(
      await rejectionOf(result.current.mutateAsync("Matter")),
    ).toMatchObject({ name: "TypeError", message: "transport failed" });
  });
  organization = "organization-b";
  rerender();
  await act(async () => {
    expect(
      await rejectionOf(result.current.mutateAsync("Matter")),
    ).toMatchObject({ name: "TypeError", message: "transport failed" });
  });
  organization = "organization-a";
  rerender();
  await act(async () => {
    expect(
      await rejectionOf(result.current.mutateAsync("Matter")),
    ).toMatchObject({ name: "TypeError", message: "transport failed" });
  });
  expect(keys.at(0)).not.toBe(keys.at(1));
  expect(keys.at(0)).toBe(keys.at(2));
  client.clear();
});

test("identical intents capture their shared key before asynchronous onMutate work", async () => {
  const client = new QueryClient();
  const releaseFirst = Promise.withResolvers<undefined>();
  let preparationCount = 0;
  const keys: string[] = [];
  const { result } = renderHook(
    () =>
      useIdempotentMutation({
        onMutate: async () => {
          preparationCount += 1;
          if (preparationCount === 1) {
            await releaseFirst.promise;
          }
        },
        mutationFn: async (_name: string, request) => {
          keys.push(request.headers["Idempotency-Key"]);
          return "created";
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const first = result.current.mutateAsync("Matter");
  await act(async () => {
    await result.current.mutateAsync("Matter");
  });
  expect(keys).toHaveLength(1);
  await act(async () => {
    releaseFirst.resolve(undefined);
    await first;
  });
  expect(keys).toHaveLength(2);
  expect(keys.at(0)).toBe(keys.at(1));
  client.clear();
});
