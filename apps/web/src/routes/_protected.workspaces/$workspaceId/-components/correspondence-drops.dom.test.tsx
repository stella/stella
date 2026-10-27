import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { APIError } = await import("@/lib/errors/api");
const { correspondenceDropsOptions } =
  await import("@/lib/workspaces/queries/correspondence-drops");
const { CorrespondenceDrops } = await import("./correspondence-drops");

const catalogs = { en, ar };
const MATTER_ID = "synthetic-matter";
const SOURCE_DETAIL = "Synthetic response detail";

for (const [locale, messages] of Object.entries(catalogs)) {
  for (const scenario of [
    {
      kind: "recognized validation",
      error: new APIError({
        code: "validation",
        status: 400,
        message: messages.errors.api.validation,
        rawMessage: SOURCE_DETAIL,
      }),
      expected: messages.errors.api.validation,
    },
    {
      kind: "server failure",
      error: new APIError({
        code: "unclassified_drop_failure",
        status: 500,
        message: SOURCE_DETAIL,
        rawMessage: SOURCE_DETAIL,
      }),
      expected: messages.errors.actionFailed,
    },
  ]) {
    test(`correspondence reads show the safe ${scenario.kind} message in ${locale}`, async () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { enabled: false, retry: false, gcTime: Infinity },
        },
      });
      client
        .getQueryCache()
        .build(client, {
          queryKey: correspondenceDropsOptions(MATTER_ID).queryKey,
        })
        .setState({
          status: "error",
          fetchStatus: "idle",
          error: scenario.error,
        });
      try {
        render(
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <FormattingProvider locale={locale} timeZone="UTC">
              <QueryClientProvider client={client}>
                <CorrespondenceDrops workspaceId={MATTER_ID} />
              </QueryClientProvider>
            </FormattingProvider>
          </IntlProvider>,
        );
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name: messages.correspondence.drops.title,
            }),
          );
        });
        const alert = await screen.findByRole("alert");
        if (scenario.kind === "recognized validation") {
          expect(scenario.expected).not.toBe(messages.errors.actionFailed);
        }
        expect(alert.textContent).toContain(scenario.expected);
        expect(alert.textContent).not.toContain(SOURCE_DETAIL);
        expect(
          within(alert)
            .getByRole("button", { name: messages.common.retry })
            .getAttribute("disabled"),
        ).toBeNull();
      } finally {
        cleanup();
        client.clear();
      }
    });
  }
}
