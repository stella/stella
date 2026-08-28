import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { useVerifiedEmailCitationTarget } from "@/hooks/use-verified-email-citation-target";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const FIELD_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const HREF = `#email:${ENTITY_ID}:${FIELD_ID}:body-0001`;

const CitationState = () => {
  const citation = useVerifiedEmailCitationTarget(HREF, WORKSPACE_ID);
  return <span data-citation-state={citation?.type ?? "pending"} />;
};

describe("useVerifiedEmailCitationTarget", () => {
  test("defers preview verification until citation activation", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CitationState />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-citation-state="unverified"');
  });

  test("surfaces preview failures as a retryable citation state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnMount: false,
          retry: false,
          retryOnMount: false,
        },
      },
    });
    const options = emailHtmlPreviewOptions({
      fieldId: FIELD_ID,
      workspaceId: WORKSPACE_ID,
    });
    const fetchResult = await Result.tryPromise({
      try: async () =>
        await queryClient.query({
          ...options,
          queryFn: async () => {
            throw new Error("preview unavailable");
          },
        }),
      catch: (cause) => cause,
    });
    expect(Result.isError(fetchResult)).toBe(true);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CitationState />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-citation-state="error"');
  });
});
