import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { stellaToast } from "@stll/ui/toast";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, renderHook, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useSkillHistoryActions } = await import("./use-skill-history-actions");
const { toAPIError } = await import("@/lib/errors/api");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test.each([403, 404, 409, 500])(
  "skill-history writes preserve localized refusal descriptions for status %i",
  async (status) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const { result } = renderHook(
      () =>
        useSkillHistoryActions({
          organizationId: "organization",
          skillId: "skill",
          userId: "user",
        }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <IntlProvider locale="en" messages={messages}>
              {children}
            </IntlProvider>
          </QueryClientProvider>
        ),
      },
    );
    const privateMessage = "Private skill implementation detail";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => Response.json({ message: privateMessage }, { status }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
    try {
      await act(async () => {
        await result.current.addComment({
          revisionId: "revision",
          start: 0,
          end: 3,
          body: "Comment",
        });
        await result.current.deleteComment("comment");
        await result.current.createProposal();
        await result.current.reviewProposal({
          proposalId: "proposal",
          decision: "accepted",
        });
      });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(toast).toHaveBeenCalledTimes(4);
      const error = toAPIError({ status, value: { message: privateMessage } });
      expect(error.message).not.toBe(privateMessage);
      for (const [options] of toast.mock.calls) {
        expect(options).toMatchObject({
          type: "error",
          description: error.message,
        });
      }
      expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
    } finally {
      toast.mockRestore();
      fetch.mockRestore();
    }
  },
);
