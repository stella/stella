import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useQueryView } = await import("@/lib/use-query-view");
const { ComposerQueryResults } = await import("./composer-query-results");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

for (const source of [
  "matters",
  "mention-search",
  "skills",
  "connectors",
  "connections",
]) {
  describe(`${source} composer answer`, () => {
    const mount = (companionStatus?: "pending" | "error") => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const requests: ReturnType<typeof Promise.withResolvers<string[]>>[] = [];
      const Region = () => {
        const query = useQuery({
          queryKey: [source],
          queryFn: async () => {
            const request = Promise.withResolvers<string[]>();
            requests.push(request);
            return request.promise;
          },
        });
        const view = useQueryView(query);
        const rows = view.type === "items" ? view.items : [];
        const companion =
          companionStatus === "error"
            ? {
                type: "error" as const,
                error: new Error("Related read unavailable"),
                retry: query.refetch,
              }
            : { type: "pending" as const };
        const views =
          companionStatus === undefined
            ? { [source]: view }
            : { [source]: view, companion };
        return (
          <ComposerQueryResults
            views={views}
            hasItems={rows.length > 0}
            empty="Empty answer"
          >
            <span>{rows.join(", ")}</span>
          </ComposerQueryResults>
        );
      };
      const ui = render(
        <QueryClientProvider client={client}>
          <IntlProvider
            locale="en"
            messages={messages}
            timeZone="Europe/Prague"
          >
            <Region />
          </IntlProvider>
        </QueryClientProvider>,
      );
      const settle = async (outcome: "error" | string[]) => {
        const request = requests.at(-1);
        if (!request) {
          throw new Error("Expected in-flight read");
        }
        await act(async () => {
          if (outcome === "error") {
            request.reject(new Error("Read unavailable"));
          } else {
            request.resolve(outcome);
          }
        });
      };
      return { client, requests, ui, settle };
    };

    test("failure offers retry without an empty answer, then recovers", async () => {
      const { client, requests, ui, settle } = mount();
      expect(ui.getByRole("status")).toBeDefined();
      expect(ui.queryByText("Empty answer")).toBeNull();
      await settle("error");
      await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
      expect(ui.queryByText("Empty answer")).toBeNull();
      fireEvent.click(ui.getByRole("button", { name: messages.common.retry }));
      await waitFor(() => expect(requests.length).toBe(2));
      await settle(["Available answer"]);
      await waitFor(() =>
        expect(ui.getByText("Available answer")).toBeDefined(),
      );
      expect(ui.queryByRole("alert")).toBeNull();
      client.clear();
    });

    test("a related pending or failed read prevents an empty answer while retaining available rows", async () => {
      for (const { companionStatus, pendingCount } of [
        { companionStatus: "pending", pendingCount: 1 },
        { companionStatus: "error", pendingCount: 0 },
      ] as const) {
        for (const answer of [[], ["Available answer"]]) {
          const { client, ui, settle } = mount(companionStatus);
          await settle(answer);
          await waitFor(() =>
            expect(ui.queryAllByRole("status").length).toBe(pendingCount),
          );
          expect(ui.queryByText("Empty answer")).toBeNull();
          if (answer.length > 0) {
            expect(ui.getByText("Available answer")).toBeDefined();
          }
          if (companionStatus === "error") {
            expect(ui.getByRole("alert")).toBeDefined();
          } else {
            expect(ui.getByRole("status")).toBeDefined();
          }
          ui.unmount();
          client.clear();
        }
      }
    });

    test("successful empty reads differ from failed refreshes, including cached zero rows", async () => {
      for (const answer of [[], ["Cached answer"]]) {
        const { client, requests, ui, settle } = mount();
        await settle(answer);
        await waitFor(() => expect(ui.queryByRole("status")).toBeNull());
        if (answer.length === 0) {
          expect(ui.getByText("Empty answer")).toBeDefined();
        }
        let refresh: Promise<void> | undefined;
        await act(async () => {
          refresh = client.refetchQueries();
        });
        await waitFor(() => expect(requests.length).toBe(2));
        await settle("error");
        await refresh;
        await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
        expect(ui.queryByText("Empty answer")).toBeNull();
        if (answer.length > 0) {
          expect(ui.getByText("Cached answer")).toBeDefined();
        }
        ui.unmount();
        client.clear();
      }
    });
  });
}
