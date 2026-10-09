import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { ANALYSIS_REQUEST_MODE } from "@stll/api-contract/case-law-analysis";
import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import type {
  DecisionAnalysisKey,
  AnalysisQueryResult,
} from "@/features/case-law/queries/decision-analysis";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { StrictMode } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { aiAvailabilityOptions } =
  await import("@/lib/organization/ai-config-queries");
const { decisionAnalysisOptions } =
  await import("@/features/case-law/queries/decision-analysis");
const { useLazyDecisionAnalysis } =
  await import("./use-lazy-decision-analysis");
const { useDecisionAnalysis } = await import("./use-decision-analysis");

/** What the shared analysis cache holds for these options. */
const cachedAnalysis = (
  client: InstanceType<typeof QueryClient>,
  options: ReturnType<typeof decisionAnalysisOptions>,
): AnalysisQueryResult | undefined => client.getQueryData(options.queryKey);

const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const user = {
  activeOrganizationId: "synthetic-org",
  email: "synthetic@example.test",
  id: "synthetic-reader",
  image: null,
  name: "Synthetic reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const key = {
  decisionId: "00000000-0000-4000-8000-000000000001",
  decisionUpdatedAt: "2026-01-01T00:00:00Z",
} satisfies DecisionAnalysisKey;
const eligible = {
  ...key,
  documentReady: true,
  sourceAllowsDerivedAi: true,
  mode: "enabled",
} as const;
const analysis = {
  version: 2,
  generatedAt: "2026-01-01T00:00:00Z",
  model: "synthetic-model",
  inputFingerprint: "a".repeat(64),
  tree: [
    {
      id: "section-1",
      label: "Synthetic section",
      category: "facts",
      startAnchorId: "anchor-1",
      endAnchorId: "anchor-2",
      annotations: [],
      children: [],
    },
  ],
} satisfies DecisionAnalysis;

const clientWithAvailability = (available = true) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(
    aiAvailabilityOptions({ organizationId: user.activeOrganizationId })
      .queryKey,
    {
      available,
      orgConfigured: available,
      instanceProvisioned: false,
      deferredServiceTierAvailable: false,
      mockAnswers: false,
    },
  );
  return client;
};

type WrapperOptions = {
  client: InstanceType<typeof QueryClient>;
  authenticated?: boolean;
};
const wrapperFor =
  ({ client, authenticated = true }: WrapperOptions) =>
  ({ children }: PropsWithChildren) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        {authenticated ? (
          <AuthenticatedUserProvider user={user}>
            {children}
          </AuthenticatedUserProvider>
        ) : (
          children
        )}
      </QueryClientProvider>
    </StrictMode>
  );

const respondToAnalysis = (response: () => Promise<Response>) => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toEndWith(
        `/case/decisions/${key.decisionId}/analysis`,
      );
      expect(request.method).toBe("GET");
      requests.push(request);
      return await response();
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};

describe("shared lazy decision analysis", () => {
  test("concurrent StrictMode views join one first read and reuse its completed analysis", async () => {
    const pending = Promise.withResolvers<Response>();
    const requests = respondToAnalysis(async () => await pending.promise);
    const client = clientWithAvailability();
    const wrapper = wrapperFor({ client });
    const first = renderHook(() => useLazyDecisionAnalysis(eligible), {
      wrapper,
    });
    const second = renderHook(() => useLazyDecisionAnalysis(eligible), {
      wrapper,
    });
    await waitFor(() => expect(requests.length).toBe(1));
    expect(first.result.current.state.status).toBe("generating");
    expect(second.result.current.state.status).toBe("generating");
    await act(async () => {
      pending.resolve(Response.json({ status: "done", analysis }));
    });
    await waitFor(() => expect(first.result.current.state.status).toBe("done"));
    expect(second.result.current.state).toEqual({ status: "done", analysis });
    first.unmount();
    second.unmount();
    const returning = renderHook(() => useLazyDecisionAnalysis(eligible), {
      wrapper,
    });
    expect(returning.result.current.state).toEqual({
      status: "done",
      analysis,
    });
    expect(requests.length).toBe(1);
  });

  test("a cached result is drawn without a read and a new decision version reads once", async () => {
    const requests = respondToAnalysis(async () =>
      Response.json({ status: "done", analysis }),
    );
    const client = clientWithAvailability();
    client.setQueryData(
      decisionAnalysisOptions({
        ...key,
        organizationId: user.activeOrganizationId,
      }).queryKey,
      () =>
        ({
          kind: "done",
          analysis,
        }) satisfies AnalysisQueryResult,
    );
    const mounted = renderHook((options) => useLazyDecisionAnalysis(options), {
      initialProps: eligible,
      wrapper: wrapperFor({ client }),
    });
    expect(mounted.result.current.state).toEqual({ status: "done", analysis });
    expect(requests.length).toBe(0);
    mounted.rerender({
      ...eligible,
      decisionUpdatedAt: "2026-01-02T00:00:00Z",
    });
    await waitFor(() => expect(requests.length).toBe(1));
    await waitFor(() =>
      expect(mounted.result.current.state.status).toBe("done"),
    );
  });

  test.each([
    {
      description: "anonymous",
      authenticated: false,
      available: true,
      options: eligible,
    },
    {
      description: "AI disabled",
      authenticated: true,
      available: true,
      options: { ...eligible, mode: "gated" } as const,
    },
    {
      description: "no key",
      authenticated: true,
      available: false,
      options: eligible,
    },
    {
      description: "source disallows derived AI",
      authenticated: true,
      available: true,
      options: { ...eligible, sourceAllowsDerivedAi: false },
    },
    {
      description: "document not ready",
      authenticated: true,
      available: true,
      options: { ...eligible, documentReady: false },
    },
  ])(
    "$description neither automatically nor manually starts analysis",
    async ({ authenticated, available, options }) => {
      const requests = respondToAnalysis(async () =>
        Response.json({ status: "done", analysis }),
      );
      const client = clientWithAvailability(available);
      const { result } = renderHook(() => useLazyDecisionAnalysis(options), {
        wrapper: wrapperFor({ client, authenticated }),
      });
      expect(result.current.available).toBe(false);
      expect(result.current.state.status).toBe("idle");
      await act(async () => {
        result.current.generate();
      });
      expect(result.current.state.status).toBe("idle");
      expect(requests.length).toBe(0);
    },
  );

  test("a failed availability read stays silent and never starts analysis", async () => {
    const client = clientWithAvailability();
    const availabilityKey = aiAvailabilityOptions({
      organizationId: user.activeOrganizationId,
    }).queryKey;
    client.removeQueries({ queryKey: availabilityKey });
    const paths: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const pathname = new URL(new Request(input, init).url).pathname;
        paths.push(pathname);
        expect(pathname).toEndWith("/organization-settings/ai-availability");
        return Response.json(
          { message: "Synthetic unavailable configuration" },
          { status: 403 },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const { result } = renderHook(() => useLazyDecisionAnalysis(eligible), {
      wrapper: wrapperFor({ client }),
    });
    await waitFor(() =>
      expect(client.getQueryState(availabilityKey)?.status).toBe("error"),
    );
    await act(async () => {
      result.current.generate();
    });
    expect(result.current.available).toBe(false);
    expect(result.current.state.status).toBe("idle");
    expect(paths.length).toBe(1);
  });

  test.each([200, 402, 503])(
    "analysis refusal (%i) settles without a control or another immediate read",
    async (status) => {
      const requests = respondToAnalysis(async () =>
        Response.json(
          { status: "error", error: "Synthetic unavailable analysis" },
          { status },
        ),
      );
      const client = clientWithAvailability();
      const { result } = renderHook(() => useLazyDecisionAnalysis(eligible), {
        wrapper: wrapperFor({ client }),
      });
      await waitFor(() => expect(result.current.state.status).toBe("error"));
      // The inspector's control requires a generating or completed analysis;
      // this terminal state never offers an outline or displays a user error.
      expect(
        result.current.state.status === "generating" ||
          result.current.state.status === "done",
      ).toBe(false);
      expect(requests.length).toBe(1);
    },
  );
});

test("lazy analysis retains provider guidance data from an async failed response", async () => {
  const diagnostic = {
    provider: "openai",
    code: PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota,
    message: "Quota refused. Complete provider reason.",
  };
  respondToAnalysis(async () =>
    Response.json({ status: "error", providerDiagnostic: diagnostic }),
  );
  const client = clientWithAvailability();
  const mounted = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper: wrapperFor({ client }),
  });
  await waitFor(() =>
    expect(mounted.result.current.state).toEqual({
      status: "error",
      providerDiagnostic: diagnostic,
    }),
  );
});

test("explicit retry sends retry once for shared views and subsequent progress polling uses poll", async () => {
  const pendingRetry = Promise.withResolvers<Response>();
  const pendingPoll = Promise.withResolvers<Response>();
  let served = 0;
  const requests = respondToAnalysis(async () => {
    served += 1;
    if (served === 1) {
      return Response.json({ status: "error" });
    }
    if (served === 2) {
      return await pendingRetry.promise;
    }
    return await pendingPoll.promise;
  });
  const client = clientWithAvailability();
  const wrapper = wrapperFor({ client });
  const first = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  const second = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  await waitFor(() => expect(first.result.current.state.status).toBe("error"));
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([ANALYSIS_REQUEST_MODE.poll]);
  await act(async () => {
    first.result.current.generate();
    first.result.current.generate();
    second.result.current.generate();
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(first.result.current.state.status).toBe("generating");
  expect(second.result.current.state.status).toBe("generating");
  await act(async () => {
    pendingRetry.resolve(Response.json({ status: "generating" }));
  });
  const options = decisionAnalysisOptions({
    ...key,
    organizationId: user.activeOrganizationId,
  });
  await waitFor(() => {
    expect(cachedAnalysis(client, options)).toEqual({
      kind: "generating",
      tree: [],
    });
  });
  await waitFor(() => expect(requests).toHaveLength(3), { timeout: 4000 });
  await act(async () => {
    pendingPoll.resolve(Response.json({ status: "done", analysis }));
  });
  await waitFor(() => expect(first.result.current.state.status).toBe("done"));
  expect(second.result.current.state).toEqual({ status: "done", analysis });
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.retry,
    ANALYSIS_REQUEST_MODE.poll,
  ]);
  expect(cachedAnalysis(client, options)).toEqual({
    kind: "done",
    analysis,
  });
  await act(async () => first.result.current.generate());
  expect(requests).toHaveLength(3);
});

test("a view mounted during retry waits for retry before resuming normal polling", async () => {
  const pendingRetry = Promise.withResolvers<Response>();
  const pendingPoll = Promise.withResolvers<Response>();
  let served = 0;
  const requests = respondToAnalysis(async () => {
    served += 1;
    if (served === 1) {
      return Response.json({ status: "error" });
    }
    if (served === 2) {
      return await pendingRetry.promise;
    }
    return await pendingPoll.promise;
  });
  const client = clientWithAvailability();
  const wrapper = wrapperFor({ client });
  const first = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  await waitFor(() => expect(first.result.current.state.status).toBe("error"));
  await act(async () => first.result.current.generate());
  await waitFor(() => expect(requests).toHaveLength(2));

  const arriving = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  await act(async () => arriving.rerender());
  expect(arriving.result.current.state.status).toBe("generating");
  expect(requests).toHaveLength(2);
  const options = decisionAnalysisOptions({
    ...key,
    organizationId: user.activeOrganizationId,
  });
  expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe("idle");

  await act(async () => {
    pendingRetry.resolve(Response.json({ status: "generating" }));
  });
  await waitFor(() => expect(requests).toHaveLength(3), { timeout: 4000 });
  expect(cachedAnalysis(client, options)).toEqual({
    kind: "generating",
    tree: [],
  });
  expect(first.result.current.state.status).toBe("generating");
  expect(arriving.result.current.state.status).toBe("generating");
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.retry,
    ANALYSIS_REQUEST_MODE.poll,
  ]);
  await act(async () => {
    pendingPoll.resolve(Response.json({ status: "done", analysis }));
  });
  await waitFor(() => expect(first.result.current.state.status).toBe("done"));
  expect(arriving.result.current.state).toEqual({ status: "done", analysis });
  expect(cachedAnalysis(client, options)).toEqual({
    kind: "done",
    analysis,
  });
  expect(requests).toHaveLength(3);
});

test("retry cancels a stale poll before replacing the shared analysis cache", async () => {
  const stalePoll = Promise.withResolvers<Response>();
  let served = 0;
  const requests = respondToAnalysis(async () => {
    served += 1;
    if (served === 1) {
      return Response.json({ status: "error" });
    }
    if (served === 2) {
      return await stalePoll.promise;
    }
    return Response.json({ status: "done", analysis });
  });
  const client = clientWithAvailability();
  const mounted = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper: wrapperFor({ client }),
  });
  await waitFor(() =>
    expect(mounted.result.current.state.status).toBe("error"),
  );
  const options = decisionAnalysisOptions({
    ...key,
    organizationId: user.activeOrganizationId,
  });
  let refetch: Promise<void> | undefined;
  await act(async () => {
    refetch = client.refetchQueries({
      queryKey: options.queryKey,
      exact: true,
    });
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  await act(async () => mounted.result.current.generate());
  await waitFor(() => expect(mounted.result.current.state.status).toBe("done"));
  expect(requests.at(1)?.signal.aborted).toBe(true);
  await act(async () => {
    stalePoll.resolve(Response.json({ status: "error" }));
    await refetch;
  });
  expect(cachedAnalysis(client, options)).toEqual({
    kind: "done",
    analysis,
  });
  expect(mounted.result.current.state).toEqual({ status: "done", analysis });
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.retry,
  ]);
});

test("a retry transport error retains its provider diagnostic until the next retry", async () => {
  const diagnostic = {
    provider: "anthropic",
    code: PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits,
    message: "Synthetic provider refusal after explicit retry",
  };
  let served = 0;
  const requests = respondToAnalysis(async () => {
    served += 1;
    if (served === 1) {
      return Response.json({ status: "error" });
    }
    if (served === 2) {
      return Response.json(
        {
          message: "Provider refused",
          providerDiagnostic: diagnostic,
        },
        { status: 402 },
      );
    }
    return Response.json({ status: "done", analysis });
  });
  const client = clientWithAvailability();
  const mounted = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper: wrapperFor({ client }),
  });
  await waitFor(() =>
    expect(mounted.result.current.state.status).toBe("error"),
  );
  await act(async () => mounted.result.current.generate());
  await waitFor(() =>
    expect(mounted.result.current.state).toEqual({
      status: "error",
      providerDiagnostic: diagnostic,
    }),
  );
  expect(requests).toHaveLength(2);
  await act(async () => mounted.result.current.generate());
  await waitFor(() =>
    expect(mounted.result.current.state).toEqual({ status: "done", analysis }),
  );
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.retry,
    ANALYSIS_REQUEST_MODE.retry,
  ]);
});

test("another view's completed retry wins over this view's failed retry, which can still retry later", async () => {
  const diagnostic = {
    provider: "anthropic",
    code: PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits,
    message: "Synthetic provider refusal after explicit retry",
  };
  let served = 0;
  const requests = respondToAnalysis(async () => {
    served += 1;
    switch (served) {
      case 1:
        return Response.json({ status: "error" });
      case 2:
        return Response.json(
          { message: "Provider refused", providerDiagnostic: diagnostic },
          { status: 402 },
        );
      case 3:
        return Response.json({ status: "done", analysis });
      default:
        return Response.json({ status: "generating" });
    }
  });
  const client = clientWithAvailability();
  const wrapper = wrapperFor({ client });
  const first = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  const second = renderHook(() => useLazyDecisionAnalysis(eligible), {
    wrapper,
  });
  await waitFor(() => {
    expect(first.result.current.state.status).toBe("error");
  });

  // The first view's retry fails in transport; only that view shows it.
  await act(async () => {
    first.result.current.generate();
  });
  await waitFor(() => {
    expect(first.result.current.state).toEqual({
      status: "error",
      providerDiagnostic: diagnostic,
    });
  });
  expect(second.result.current.state).toEqual({ status: "error" });

  // The second view's retry completes the shared analysis: both show it.
  await act(async () => {
    second.result.current.generate();
  });
  await waitFor(() => {
    expect(second.result.current.state).toEqual({ status: "done", analysis });
  });
  expect(first.result.current.state).toEqual({ status: "done", analysis });

  // The analysis fails again; the first view's old failure does not mask it
  // and its retry is accepted.
  const options = decisionAnalysisOptions({
    ...key,
    organizationId: user.activeOrganizationId,
  });
  await act(async () => {
    client.setQueryData(
      options.queryKey,
      () => ({ kind: "error" }) satisfies AnalysisQueryResult,
    );
  });
  await waitFor(() => {
    expect(first.result.current.state).toEqual({ status: "error" });
  });
  await act(async () => {
    first.result.current.generate();
  });
  await waitFor(() => {
    expect(requests).toHaveLength(4);
  });
  expect(
    requests.map((request) => new URL(request.url).searchParams.get("mode")),
  ).toEqual([
    ANALYSIS_REQUEST_MODE.poll,
    ANALYSIS_REQUEST_MODE.retry,
    ANALYSIS_REQUEST_MODE.retry,
    ANALYSIS_REQUEST_MODE.retry,
  ]);
});

type AnalysisIdentity = typeof key & { organizationId: string };

/** How the view moves to another identity while a retry is pending. */
const IDENTITY_CHANGES = {
  organization: (origin: AnalysisIdentity) => ({
    ...origin,
    organizationId: "synthetic-other-org",
  }),
  decision: (origin: AnalysisIdentity) => ({
    ...origin,
    decisionId: "00000000-0000-4000-8000-000000000002",
  }),
} satisfies Record<string, (origin: AnalysisIdentity) => AnalysisIdentity>;

for (const [change, move] of Object.entries(IDENTITY_CHANGES)) {
  test(`a retry answer is cached only under the identity it was asked for when the ${change} changes while it is pending`, async () => {
    const pendingRetry = Promise.withResolvers<Response>();
    let served = 0;
    const requests = respondToAnalysis(async () => {
      served += 1;
      if (served === 1) {
        return Response.json({ status: "error" });
      }
      return await pendingRetry.promise;
    });
    const client = clientWithAvailability();
    const origin = { ...key, organizationId: user.activeOrganizationId };
    const moved = move(origin);
    const refusal = {
      provider: "anthropic",
      code: PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits,
      message: "Synthetic refusal for the original identity",
    };
    const mounted = renderHook(
      (props: typeof origin & { enabled: boolean }) =>
        useDecisionAnalysis(props),
      {
        initialProps: { ...origin, enabled: true },
        wrapper: wrapperFor({ client }),
      },
    );
    await waitFor(() => {
      expect(mounted.result.current.state.status).toBe("error");
    });
    await act(async () => {
      mounted.result.current.generate();
    });
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });

    // The view moves on before the retry answers. It stays disabled there, so
    // the moved identity is read from the cache only.
    mounted.rerender({ ...moved, enabled: false });
    await act(async () => {
      pendingRetry.resolve(
        Response.json({ status: "error", providerDiagnostic: refusal }),
      );
    });
    await waitFor(() => {
      expect(cachedAnalysis(client, decisionAnalysisOptions(origin))).toEqual({
        kind: "error",
        providerDiagnostic: refusal,
      });
    });
    expect(
      cachedAnalysis(client, decisionAnalysisOptions(moved)),
    ).toBeUndefined();
    expect(mounted.result.current.state).toEqual({ status: "idle" });
  });
}
