import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { documentReviewPartiesKeys } from "@/components/ai-suggestions/document-review-queries";
import messages from "@/i18n/langs/en.json";
import { entityVersionsKeys } from "@/lib/workspaces/queries/entity-versions";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useQueryView } = await import("@/lib/use-query-view");
const { PlaybookQuerySection } = await import("./playbook-query-section");

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const target = {
  workspaceId: "matter",
  entityId: "document",
  fileFieldId: "file",
};
for (const queryKey of [
  documentReviewPartiesKeys.target(target),
  entityVersionsKeys.all(target),
]) {
  describe(`${JSON.stringify(queryKey)} query region`, () => {
    const mount = () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const requests: ReturnType<
        typeof Promise.withResolvers<readonly string[]>
      >[] = [];
      const Region = () => {
        const query = useQuery({
          queryKey,
          queryFn: async () => {
            const request = Promise.withResolvers<readonly string[]>();
            requests.push(request);
            return request.promise;
          },
        });
        const view = useQueryView(query);
        return (
          <PlaybookQuerySection
            view={view}
            pending="Loading"
            empty="Empty answer"
          >
            {(answer) => (
              <span data-testid="answer">{JSON.stringify(answer)}</span>
            )}
          </PlaybookQuerySection>
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
      const settle = async (outcome: "error" | readonly string[]) => {
        const request = requests.at(-1);
        expect(request).toBeDefined();
        if (!request) {
          throw new Error("Expected an in-flight query");
        }
        await act(async () => {
          if (outcome === "error") {
            request.reject(new Error("Read unavailable"));
          } else {
            request.resolve(outcome);
          }
        });
      };
      return { client, requests, settle, ui };
    };

    test("initial failure exposes retry instead of empty content and retry restores the answer", async () => {
      const { client, requests, settle, ui } = mount();
      expect(ui.getByText("Loading")).toBeDefined();
      await settle("error");
      await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
      expect(ui.queryByText("Empty answer")).toBeNull();
      fireEvent.click(ui.getByRole("button", { name: messages.common.retry }));
      await waitFor(() => expect(requests.length).toBe(2));
      await settle(["Confirmed answer"]);
      await waitFor(() =>
        expect(ui.getByTestId("answer").textContent).toContain(
          "Confirmed answer",
        ),
      );
      expect(ui.queryByRole("alert")).toBeNull();
      client.clear();
    });

    test("a successful zero-item answer renders the empty state", async () => {
      const { client, settle, ui } = mount();
      await settle([]);
      await waitFor(() => expect(ui.getByText("Empty answer")).toBeDefined());
      expect(ui.queryByRole("alert")).toBeNull();
      client.clear();
    });

    test("failed refetch preserves both zero-item and populated answers with a retry notice", async () => {
      for (const answer of [[], ["Cached answer"]]) {
        const { client, requests, settle, ui } = mount();
        await settle(answer);
        await waitFor(() => expect(ui.queryByText("Loading")).toBeNull());
        let refresh: Promise<void> | undefined;
        await act(async () => {
          refresh = client.refetchQueries();
        });
        await waitFor(() => expect(requests.length).toBe(2));
        await settle("error");
        await refresh;
        await waitFor(() => expect(ui.getByRole("alert")).toBeDefined());
        expect(ui.getByTestId("answer").textContent).toBe(
          JSON.stringify(answer),
        );
        fireEvent.click(
          ui.getByRole("button", { name: messages.common.retry }),
        );
        await waitFor(() => expect(requests.length).toBe(3));
        await settle(["Updated answer"]);
        await waitFor(() => expect(ui.queryByRole("alert")).toBeNull());
        expect(ui.getByTestId("answer").textContent).toContain(
          "Updated answer",
        );
        ui.unmount();
        client.clear();
      }
    });
  });
}
