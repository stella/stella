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
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  useAddFactProgress.getState().record(progressKey, null);
});
afterAll(unregisterDomEnvironment);

const mountActions = () => {
  spies.push(spyOn(stellaToast, "add").mockReturnValue("claim-gap-toast"));
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);
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
const serve = (refusedPath?: string) => {
  const requests: RequestRecord[] = [];
  let refused = false;
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
          expect(path).toBe(`/v1/entities/${workspaceId}/entity/${documentId}`);
          return Response.json({
            entityId: documentId,
            currentVersionId: versionId,
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
          case WRITE_PATHS[1]:
            return Response.json({
              id: sourceId,
            } satisfies WebApiRoutes["lists"][":workspaceId"]["item-sources"]["post"]["response"][200]);
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
  return requests;
};

for (const { operation, path } of [
  { operation: "link", path: WRITE_PATHS[2] },
  { operation: "recheck", path: WRITE_PATHS[3] },
] as const) {
  test(`${operation} invalidates registered verification readers only in the bound matter`, async () => {
    const requests = serve();
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
    const requests = serve(refusedPath);
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
