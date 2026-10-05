import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import messages from "@/i18n/langs/en.json";
import { queryView } from "@/lib/query-view.logic";

import { SkillRevisionComparison } from "./skill-revision-comparison";

const failedRead = new Error("Read unavailable");

const renderRead = (
  view: Parameters<typeof SkillRevisionComparison>[0]["view"],
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SkillRevisionComparison view={view}>
        {(baseline) => <span>{baseline ?? "Live editor"}</span>}
      </SkillRevisionComparison>
    </IntlProvider>,
  );

test("a failed selected revision read renders an error and retry instead of an empty answer", async () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["skill-revision-comparison", "initial-error"],
    queryFn: async (): Promise<{ body: string }> => {
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
  expect(html).toContain("Live editor");
  observer.destroy();
  client.clear();
});

test("a failed selected revision refresh retains cached content with an error notice", async () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["skill-revision-comparison", "refetch-error"],
    queryFn: async (): Promise<{ body: string }> => {
      throw failedRead;
    },
    initialData: { body: "Stored revision" },
    enabled: false,
    retry: false,
  });
  const result = await observer.refetch();
  expect(result.data).toEqual({ body: "Stored revision" });
  const html = renderRead(queryView(result));
  expect(html).toContain('role="alert"');
  expect(html).toContain(messages.common.retry);
  expect(html).toContain("Stored revision");
  observer.destroy();
  client.clear();
});

test("a pending selected read has a loading status instead of empty content", () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["skill-revision-comparison", "pending"],
    queryFn: async () => ({ body: "Stored revision" }),
    enabled: false,
  });
  const html = renderRead(queryView(observer.getCurrentResult()));
  expect(html).toContain('role="status"');
  expect(html).not.toContain(messages.common.noResults);
  expect(html).toContain("Live editor");
  observer.destroy();
  client.clear();
});
