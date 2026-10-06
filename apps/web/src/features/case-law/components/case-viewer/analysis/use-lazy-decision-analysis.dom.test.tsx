import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

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
      decisionAnalysisOptions(key).queryKey,
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
