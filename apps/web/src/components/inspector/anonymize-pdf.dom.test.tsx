import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useFileAnonymizationPipeline } = await import("./anonymize-pdf");
const { useInspectorAnonymizationStore } =
  await import("./inspector-anonymization-store");
const { ClientOperationError } = await import("@/lib/errors/client");
const { anonymizationTermsOptions } =
  await import("@/lib/workspaces/queries/anonymization-terms");
const { anonymizationAllowlistOptions } =
  await import("@/lib/workspaces/queries/anonymization-allowlist");

beforeEach(() => {
  useInspectorAnonymizationStore.setState({
    anonymizationPipelineStatusByFieldId: {},
    anonymizationRetryByFieldId: {},
  });
});
afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

for (const failedRead of ["terms", "allowlist", "both"]) {
  test(`the PDF pipeline resumes after ${failedRead} policy recovery`, async () => {
    const workspaceId = "019e7000-0000-7000-8000-000000000002";
    const fieldId = `policy-recovery-${failedRead}`;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false, refetchOnMount: false },
      },
    });
    const terms = anonymizationTermsOptions(workspaceId);
    const allowlist = anonymizationAllowlistOptions({
      workspaceId,
      entityId: null,
    });
    client.setQueryData(terms.queryKey, { entries: [] });
    client.setQueryData(allowlist.queryKey, { entries: [] });
    for (const options of failedRead === "both"
      ? [terms, allowlist]
      : [failedRead === "terms" ? terms : allowlist]) {
      const query = client.getQueryCache().find({ queryKey: options.queryKey });
      if (!query) {
        panic("Policy fixture has no cached query");
      }
      query.setState({
        status: "error",
        data: undefined,
        error: new ClientOperationError({
          action: "policy-read",
          message: "Policy unavailable",
        }),
      });
    }
    const runPipeline = mock(async () => {
      await Promise.resolve();
      return Result.ok(undefined);
    });
    const Wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () =>
        useFileAnonymizationPipeline({
          enabled: true,
          fieldId,
          workspaceId,
          entityId: null,
          runPipeline,
        }),
      { wrapper: Wrapper },
    );
    expect(runPipeline).toHaveBeenCalledTimes(0);
    await act(async () => {
      client.setQueryData(terms.queryKey, { entries: [] });
      await Promise.resolve();
    });
    if (failedRead !== "terms") {
      expect(runPipeline).toHaveBeenCalledTimes(0);
    }
    await act(async () => {
      client.setQueryData(allowlist.queryKey, { entries: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    expect(
      useInspectorAnonymizationStore.getState()
        .anonymizationPipelineStatusByFieldId[fieldId],
    ).not.toBe("error");
    hook.unmount();
    client.clear();
  });
}
