import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { RESOURCE_TYPE, type ResourceType } from "@stll/api-contract";
import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { WebApiRoutes } from "@/lib/api";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const messages = (await import("@/i18n/langs/en.json")).default;
const { toSafeId } = await import("@/lib/safe-id");
const { resourceQueryOptions } = await import("@/lib/workspace-realtime");
const { legalListKeys } = await import("@/lib/workspaces/queries/legal-lists");
const { makeClaim, makeRun, noCover } = await import("./avt.test-fixtures");
const { EMPTY_CLAIM_REVIEW } = await import("./claim-review.logic");
const { avtKeys } = await import("./queries");
const { addFactProgressKey, useAddFactProgress } =
  await import("./add-fact-progress-store");
const { useClaimGapActions } = await import("./use-claim-gap-actions");

const workspaceId = "019a0000-0000-7000-8000-000000000001";
const otherWorkspaceId = "019a0000-0000-7000-8000-000000000002";
const documentId = toSafeId<"entity">("019a0000-0000-7000-8000-000000000003");
const versionId = toSafeId<"entityVersion">(
  "019a0000-0000-7000-8000-000000000004",
);
const entityId = toSafeId<"entity">("019a0000-0000-7000-8000-000000000005");
const sourceId = toSafeId<"legalListItemSource">(
  "019a0000-0000-7000-8000-000000000006",
);
const claim = makeClaim({ suffix: 1, verdict: noCover });
const run = makeRun([claim]);
const scope = {
  workspaceId,
  runId: run.id,
  listId: run.evidence.listId,
  claimId: claim.id,
};
const input = {
  statement: "The notice was delivered.",
  source: { documentId, pageNumber: 2, quote: "Delivered" },
};
const progressKey = addFactProgressKey(scope);
const clients: InstanceType<typeof QueryClient>[] = [];
const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  for (const spy of spies.splice(0).toReversed()) {
    spy.mockRestore();
  }
  useAddFactProgress.getState().record(progressKey, null);
});
afterAll(unregisterDomEnvironment);

const mountActions = (existingClient?: InstanceType<typeof QueryClient>) => {
  spies.push(spyOn(stellaToast, "add").mockReturnValue("claim-gap-toast"));
  const client =
    existingClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: 0 },
      },
    });
  if (existingClient === undefined) {
    clients.push(client);
  }
  const hook = renderHook(() => useClaimGapActions(scope), {
    wrapper: ({ children }) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </IntlProvider>
    ),
  });
  return { ...hook, client };
};

const registerReader = (
  client: InstanceType<typeof QueryClient>,
  matterId: string,
  resource: ResourceType,
) =>
  client.getQueryCache().build(
    client,
    resourceQueryOptions(
      {
        queryKey: ["registered", matterId, resource],
        queryFn: async () => null,
        initialData: null,
      },
      {
        resources: [resource],
        scope: { type: "workspace", workspaceId: matterId },
      },
    ),
  );

const WRITE_PATHS = [
  `/v1/tasks/${workspaceId}`,
  `/v1/lists/${workspaceId}/item-sources`,
  `/v1/lists/${workspaceId}/claim-reviews`,
  `/v1/lists/${workspaceId}/claim-rechecks`,
];
type RequestRecord = {
  path: string;
  method: string;
  body: unknown;
  key: string | null;
  capability: string | null;
};
const serve = ({
  refusedPath,
  sourceOutcome = "success",
  beforeDocumentRead,
}: {
  refusedPath?: string;
  sourceOutcome?: "success" | "response-lost";
  beforeDocumentRead?: () => Promise<void>;
} = {}) => {
  const requests: RequestRecord[] = [];
  const sourceWrites = new Map<string, unknown>();
  let refused = false;
  let sourceResponseLost = false;
  const boundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(url, init);
        const path = new URL(request.url).pathname;
        const body: unknown =
          request.method === "GET" ? null : await request.json();
        requests.push({
          path,
          method: request.method,
          body,
          key: request.headers.get("Idempotency-Key"),
          capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
        });
        if (path === refusedPath && !refused) {
          refused = true;
          return Response.json({ message: "Attempt refused" }, { status: 400 });
        }
        if (request.method === "GET") {
          await beforeDocumentRead?.();
          expect(path).toBe(`/v1/entities/${workspaceId}/entity/${documentId}`);
          return Response.json({
            entityId: documentId,
            currentVersionId: sourceResponseLost
              ? toSafeId<"entityVersion">(
                  "019a0000-0000-7000-8000-000000000007",
                )
              : versionId,
          } satisfies Pick<
            WebApiRoutes["entities"][":workspaceId"]["entity"][":entityId"]["get"]["response"][200],
            "entityId" | "currentVersionId"
          >);
        }
        switch (path) {
          case WRITE_PATHS[0]:
            return Response.json({
              entityId,
            } satisfies WebApiRoutes["tasks"][":workspaceId"]["put"]["response"][200]);
          case WRITE_PATHS[1]: {
            const key = request.headers.get("Idempotency-Key");
            sourceWrites.set(key ?? `unkeyed:${sourceWrites.size}`, body);
            if (sourceOutcome === "response-lost" && !sourceResponseLost) {
              sourceResponseLost = true;
              throw new DOMException("Source response lost", "NetworkError");
            }
            return Response.json({
              id: sourceId,
            } satisfies WebApiRoutes["lists"][":workspaceId"]["item-sources"]["post"]["response"][200]);
          }
          case WRITE_PATHS[2]:
            return Response.json({
              claimId: claim.id,
              review: EMPTY_CLAIM_REVIEW,
            } satisfies WebApiRoutes["lists"][":workspaceId"]["claim-reviews"]["post"]["response"][200]);
          case WRITE_PATHS[3]:
            return Response.json({
              replayed: false,
              claim,
            } satisfies WebApiRoutes["lists"][":workspaceId"]["claim-rechecks"]["post"]["response"][200]);
          default:
            throw new TypeError(`Unexpected request ${request.method} ${path}`);
        }
      },
      { preconnect: () => undefined },
    ),
  );
  spies.push(boundary);
  return { requests, sourceWrites };
};

for (const { operation, path } of [
  { operation: "link", path: WRITE_PATHS[2] },
  { operation: "recheck", path: WRITE_PATHS[3] },
] as const) {
  test(`${operation} invalidates registered verification readers only in the bound matter`, async () => {
    const { requests } = serve();
    const { client, result } = mountActions();
    const own = registerReader(
      client,
      workspaceId,
      RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
    );
    const other = registerReader(
      client,
      otherWorkspaceId,
      RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
    );
    await act(async () => {
      if (operation === "link") {
        await result.current.link.mutateAsync({
          factEntityId: entityId,
          change: "link",
        });
      } else {
        await result.current.recheck.mutateAsync();
      }
    });
    await waitFor(() => expect(result.current[operation].isSuccess).toBe(true));
    expect(own.state.isInvalidated).toBe(true);
    expect(other.state.isInvalidated).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(path);
    expect(requests[0]?.body).toMatchObject({
      runId: scope.runId,
      claimId: scope.claimId,
    });
  });
}

for (const [index, refusedPath] of WRITE_PATHS.entries()) {
  test(`fact addition resumes after refusal at write ${String(index + 1)} and retains cache ownership`, async () => {
    const { requests } = serve({ refusedPath });
    const { client, result } = mountActions();
    const resources = [
      RESOURCE_TYPE.ENTITY,
      RESOURCE_TYPE.LEGAL_LIST,
      RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
    ];
    const own = resources.map((resource) =>
      registerReader(client, workspaceId, resource),
    );
    const other = resources.map((resource) =>
      registerReader(client, otherWorkspaceId, resource),
    );
    const legacyKeys = [
      avtKeys.run(workspaceId, run.id),
      avtKeys.reviewHistoryOfRun(workspaceId, run.id),
      legalListKeys.items(workspaceId, scope.listId),
    ];
    for (const key of legacyKeys) {
      client.setQueryData(key, { retained: true });
    }
    await act(async () => {
      expect(
        await rejectionOf(result.current.addFact.mutateAsync(input)),
      ).toBeDefined();
    });
    await waitFor(() => expect(result.current.addFact.isError).toBe(true));
    expect(
      requests.filter(({ method }) => method !== "GET").map(({ path }) => path),
    ).toEqual(WRITE_PATHS.slice(0, index + 1));
    expect(useAddFactProgress.getState().progress[progressKey]?.input).toEqual(
      input,
    );
    for (const key of legacyKeys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(other.map((reader) => reader.state.isInvalidated)).toEqual([
      false,
      false,
      false,
    ]);
    const beforeRetry = requests.length;
    await act(async () => {
      await result.current.addFact.mutateAsync({
        ...input,
        statement: "A later edit must not replace the submitted fact.",
      });
    });
    await waitFor(() => expect(result.current.addFact.isSuccess).toBe(true));
    expect(
      requests
        .slice(beforeRetry)
        .filter(({ method }) => method !== "GET")
        .map(({ path }) => path),
    ).toEqual(WRITE_PATHS.slice(index));
    const retried = requests.filter(({ path }) => path === refusedPath);
    expect(retried).toHaveLength(2);
    expect(retried[1]?.body).toEqual(retried[0]?.body);
    expect(retried[1]?.key).toBe(retried[0]?.key ?? null);
    expect(useAddFactProgress.getState().progress[progressKey]).toBeUndefined();
    expect(own.map((reader) => reader.state.isInvalidated)).toEqual([
      true,
      true,
      true,
    ]);
    expect(other.map((reader) => reader.state.isInvalidated)).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      requests
        .filter(({ method }) => method !== "GET")
        .every(({ capability }) => capability !== null),
    ).toBe(true);
  });
}

test("a lost source response replays the pinned version after the claim panel remounts", async () => {
  const { requests, sourceWrites } = serve({ sourceOutcome: "response-lost" });
  const first = mountActions();
  await act(async () => {
    expect(
      await rejectionOf(first.result.current.addFact.mutateAsync(input)),
    ).toBeDefined();
  });
  await waitFor(() => expect(first.result.current.addFact.isError).toBe(true));
  const sourceAttempts = () =>
    requests.filter(({ path }) => path === WRITE_PATHS[1]);
  expect(sourceWrites.size).toBe(1);
  expect(sourceAttempts()).toHaveLength(1);
  expect(sourceAttempts()[0]?.key).toEqual(expect.any(String));
  expect(sourceAttempts()[0]?.body).toMatchObject({
    sourceEntityVersionId: versionId,
  });
  expect(useAddFactProgress.getState().progress[progressKey]?.step).toBe(
    "sourcing",
  );

  first.unmount();
  const resumed = mountActions();
  await act(async () => {
    await resumed.result.current.addFact.mutateAsync(input);
  });
  await waitFor(() =>
    expect(resumed.result.current.addFact.isSuccess).toBe(true),
  );
  expect(sourceAttempts()).toHaveLength(2);
  expect(sourceAttempts()[1]?.key).toBe(sourceAttempts()[0]?.key);
  expect(sourceAttempts()[1]?.body).toEqual(sourceAttempts()[0]?.body);
  expect(sourceWrites.size).toBe(1);
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1);
  expect(requests.filter(({ path }) => path === WRITE_PATHS[0])).toHaveLength(
    1,
  );
  expect(useAddFactProgress.getState().progress[progressKey]).toBeUndefined();
});

test("remounting during source preparation joins the addition instead of queuing another intent", async () => {
  const documentRead = Promise.withResolvers<undefined>();
  const { requests, sourceWrites } = serve({
    beforeDocumentRead: async () => await documentRead.promise,
  });
  const first = mountActions();
  let firstAttempt: Promise<void>;
  act(() => {
    firstAttempt = first.result.current.addFact.mutateAsync(input);
  });
  await waitFor(() => {
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1);
    expect(useAddFactProgress.getState().progress[progressKey]?.step).toBe(
      "added",
    );
  });
  first.unmount();
  const resumed = mountActions(first.client);
  let overlappingAttempt: Promise<void>;
  act(() => {
    overlappingAttempt = resumed.result.current.addFact.mutateAsync(input);
  });
  await waitFor(() =>
    expect(resumed.result.current.addFact.isPending).toBe(true),
  );
  await act(async () => {
    documentRead.resolve(undefined);
    await Promise.all([firstAttempt, overlappingAttempt]);
  });
  await waitFor(() =>
    expect(resumed.result.current.addFact.isSuccess).toBe(true),
  );
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1);
  for (const path of WRITE_PATHS) {
    expect(requests.filter((request) => request.path === path)).toHaveLength(1);
  }
  const firstSource = requests.find(({ path }) => path === WRITE_PATHS[1]);
  expect(firstSource?.key).toBeTruthy();
  expect(firstSource?.body).toMatchObject({ sourceEntityVersionId: versionId });
  expect(sourceWrites.size).toBe(1);
  expect(useAddFactProgress.getState().progress[progressKey]).toBeUndefined();

  await act(async () => {
    await resumed.result.current.addFact.mutateAsync({
      ...input,
      statement: "A later deliberate addition.",
    });
  });
  for (const path of WRITE_PATHS) {
    expect(requests.filter((request) => request.path === path)).toHaveLength(2);
  }
  const secondSource = requests
    .filter(({ path }) => path === WRITE_PATHS[1])
    .at(1);
  expect(secondSource?.key).toBeTruthy();
  expect(secondSource?.key).not.toBe(firstSource?.key);
  expect(sourceWrites.size).toBe(2);
});

test("overlapping remounts share a source rejection and a later retry replays the same intent", async () => {
  const documentRead = Promise.withResolvers<undefined>();
  const { requests, sourceWrites } = serve({
    sourceOutcome: "response-lost",
    beforeDocumentRead: async () => await documentRead.promise,
  });
  const first = mountActions();
  let firstFailure: Promise<unknown>;
  act(() => {
    firstFailure = rejectionOf(first.result.current.addFact.mutateAsync(input));
  });
  await waitFor(() => {
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1);
    expect(useAddFactProgress.getState().progress[progressKey]?.step).toBe(
      "added",
    );
  });
  first.unmount();
  const resumed = mountActions(first.client);
  let overlappingFailure: Promise<unknown>;
  act(() => {
    overlappingFailure = rejectionOf(
      resumed.result.current.addFact.mutateAsync(input),
    );
  });
  await waitFor(() =>
    expect(resumed.result.current.addFact.isPending).toBe(true),
  );
  await act(async () => {
    documentRead.resolve(undefined);
    const [firstError, overlappingError] = await Promise.all([
      firstFailure,
      overlappingFailure,
    ]);
    expect(firstError).toBeDefined();
    expect(overlappingError).toBe(firstError);
  });
  expect(requests.filter(({ path }) => path === WRITE_PATHS[0])).toHaveLength(
    1,
  );
  const sourceAttempts = () =>
    requests.filter(({ path }) => path === WRITE_PATHS[1]);
  expect(sourceAttempts()).toHaveLength(1);
  expect(sourceWrites.size).toBe(1);
  expect(useAddFactProgress.getState().progress[progressKey]?.step).toBe(
    "sourcing",
  );

  await act(async () => {
    await resumed.result.current.addFact.mutateAsync(input);
  });
  await waitFor(() =>
    expect(resumed.result.current.addFact.isSuccess).toBe(true),
  );
  expect(requests.filter(({ path }) => path === WRITE_PATHS[0])).toHaveLength(
    1,
  );
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(1);
  expect(sourceAttempts()).toHaveLength(2);
  expect(sourceAttempts().at(0)?.key).toBeTruthy();
  expect(sourceAttempts().at(1)?.key).toBe(sourceAttempts().at(0)?.key);
  expect(sourceAttempts().at(1)?.body).toEqual(sourceAttempts().at(0)?.body);
  expect(sourceWrites.size).toBe(1);
  expect(useAddFactProgress.getState().progress[progressKey]).toBeUndefined();
});
