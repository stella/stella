import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import messages from "@/i18n/langs/en.json";
import { queryView } from "@/lib/query-view.logic";

import { ProvisionLeadingDecisions } from "./provision-leading-decisions";

const CACHED_DECISIONS = "Cached decisions";

const failedRead = new Error("Read unavailable");

const renderRead = (
  view: Parameters<typeof ProvisionLeadingDecisions>[0]["view"],
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ProvisionLeadingDecisions view={view}>
        {<span>{CACHED_DECISIONS}</span>}
      </ProvisionLeadingDecisions>
    </IntlProvider>,
  );

test("a failed leading decisions read renders an error and retry instead of an empty answer", async () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["provision-leading-decisions", "initial-error"],
    queryFn: async (): Promise<never[]> => {
      throw failedRead;
    },
    enabled: false,
    retry: false,
  });
  const result = await observer.refetch();
  expect(result.data).toBeUndefined();
  const html = renderRead(queryView(result));
  expect(html).toContain('role="alert"');
  expect(html).toContain(messages.common.retry);
  expect(html).not.toContain(messages.common.noResults);
  expect(html).not.toContain("Live editor");
  observer.destroy();
  client.clear();
});

test("a failed leading decisions refresh retains cached content with an error notice", async () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["provision-leading-decisions", "refetch-error"],
    queryFn: async (): Promise<never[]> => {
      throw failedRead;
    },
    initialData: [],
    enabled: false,
    retry: false,
  });
  const result = await observer.refetch();
  expect(result.data).toEqual([]);
  const html = renderRead(queryView(result));
  expect(html).toContain('role="alert"');
  expect(html).toContain(messages.common.retry);
  expect(html).toContain(CACHED_DECISIONS);
  observer.destroy();
  client.clear();
});

test("a pending selected read has a loading status instead of empty content", () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["provision-leading-decisions", "pending"],
    queryFn: async () => [],
    enabled: false,
  });
  const html = renderRead(queryView(observer.getCurrentResult()));
  expect(html).toContain('role="status"');
  expect(html).not.toContain(messages.common.noResults);
  expect(html).not.toContain("Live editor");
  observer.destroy();
  client.clear();
});

test("only a successful zero-decision response renders no results", async () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["provision-leading-decisions", "empty"],
    queryFn: async () => [],
    enabled: false,
  });
  const result = await observer.refetch();
  const html = renderRead(queryView(result));
  expect(html).toContain(messages.common.noResults);
  expect(html).not.toContain('role="alert"');
  observer.destroy();
  client.clear();
});
