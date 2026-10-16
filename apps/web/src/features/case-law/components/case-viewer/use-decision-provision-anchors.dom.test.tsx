import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { locateAbbreviatedProvisionCitations } from "@stll/decision-reader/fallback-legal-anchors";
import type { Block } from "@stll/legal-ast/document-ast";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";

import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { cleanup, renderHook, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { decisionProvisionsForLinkingOptions } =
  await import("@/features/case-law/queries/provisions");
const { useDecisionProvisionAnchors } =
  await import("./use-decision-provision-anchors");
const messages = (await import("@/i18n/langs/en.json")).default;
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
afterAll(unregisterDomEnvironment);

test("legacy EU decision fallback never requests hosted statute text", async () => {
  const text = "Article 6(1)(a) of Regulation (EU) 2016/679 applies.";
  const blocks = [
    {
      id: "eu",
      anchorId: "eu",
      type: "paragraph",
      plainText: text,
      inlines: [{ type: "text", text }],
    },
  ] as const satisfies readonly Block[];
  // The fixture must reach the publisher grammar that previously entered the hosted resolver.
  expect(
    locateAbbreviatedProvisionCitations(blocks, PROVISION_CITATION_GRAMMARS.EU),
  ).toHaveLength(1);
  const decisionId = toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000004",
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const options = decisionProvisionsForLinkingOptions(decisionId);
  client.setQueryData(options.queryKey, {
    items: [],
    nextCursor: null,
    previews: [],
    status: { type: "legacy" },
    generation: "0",
  } satisfies Awaited<ReturnType<NonNullable<typeof options.queryFn>>>);
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Response.json({ items: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { result } = renderHook(
    () =>
      useDecisionProvisionAnchors({
        blocks,
        country: "EU",
        decisionDate: "2024-01-01",
        court: "Court of Justice",
        caseNumber: "C-1/24",
        decisionId,
        surface: "full-reader",
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            {children}
          </IntlProvider>
        </QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(result.current).toEqual({ anchors: [], externalAnchors: [] });
  expect(requests).toEqual([]);
});
