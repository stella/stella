import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { CollectionBodySource } from "@stll/decision-reader/collection-attribution";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

import collectionMessages from "./i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { lazy, Suspense } = await import("react");
const { IntlProvider } = await import("use-intl");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const collection = {
  id: "af6c7d89-41ab-42ba-814e-b657703584ed",
  name: "Official collection",
  adapterKey: "test-collection",
  allowsDerivedAi: true,
};
const bodySource: CollectionBodySource = {
  textSource: "collection",
  source: collection,
  sourceUrl: "https://example.test/collection",
  retrievedAt: null,
  extent: "section",
  provenance: {
    coverage: "truncated",
    totalCount: 2,
    omittedCount: 1,
    records: [
      {
        extent: "section",
        sectionNumber: 1,
        collectionLabel: "I.",
        source: collection,
        sourceDocumentId: "post-1",
        sourceUrl: "https://example.test/collection/post-1",
        retrievedAt: null,
        contribution: "body",
      },
    ],
  },
};

// As the web reader declares it: a lazy component in the reader's boundary.
const CollectionAttribution = lazy(
  async () => await import("./web-collection-attribution"),
);
const ReaderSlot = () => (
  <Suspense fallback={<span data-testid="attribution-pending" />}>
    <CollectionAttribution bodySource={bodySource} />
  </Suspense>
);

test("collection attribution loads its strings with its own chunk", async () => {
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <ReaderSlot />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(
    await screen.findByText(collectionMessages.readerCollection.partialText),
  ).toBeTruthy();
  expect(screen.queryByTestId("attribution-pending")).toBeNull();
  expect(screen.getByText("Omitted publication records: 1 of 2.")).toBeTruthy();
  const link = screen.getByRole("link", {
    name: "Official collection (post-1)",
  });
  expect(link.getAttribute("href")).toBe(
    "https://example.test/collection/post-1",
  );
  expect(link.closest("li")?.textContent).toContain("Retrieval date unknown.");
});
