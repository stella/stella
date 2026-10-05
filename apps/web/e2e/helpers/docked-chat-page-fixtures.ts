import type { Page } from "@playwright/test";

import { E2E_API_ORIGIN } from "./api";
import { dockedChatPagePayloads } from "./docked-chat-page-payloads";

type DockedChatPageFixtureOptions = {
  workspaceId: string;
  /** The world fixture's uploaded document id; also names these HTTP-only records. */
  resourceId: string;
};

/** Rich route-content reads keep the real shell and dock mounted without domain writes. */
export const installDockedChatPageFixtures = async (
  page: Page,
  { workspaceId, resourceId }: DockedChatPageFixtureOptions,
) => {
  const { invoice, report, correspondence, registryLookup } =
    dockedChatPagePayloads({ workspaceId, resourceId });
  const responses = new Map<string, unknown>([
    [`/v1/invoices/${workspaceId}/${resourceId}`, invoice],
    [`/v1/workspaces/${workspaceId}/reports/${resourceId}`, report],
    [
      `/v1/workspaces/${workspaceId}/correspondence/${resourceId}`,
      correspondence,
    ],
  ]);
  const apiOrigin = new URL(E2E_API_ORIGIN).origin;
  const isRegistryFixture = (url: URL) =>
    url.pathname === "/v1/contacts/business-registries" &&
    url.searchParams.get("registry") === "companies-house" &&
    url.searchParams.get("q") === "12345678";
  await page.route(
    (url) =>
      url.origin === apiOrigin &&
      (responses.has(url.pathname) || isRegistryFixture(url)),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const requestUrl = new URL(route.request().url());
      const pathname = requestUrl.pathname;
      // A successful no-match lookup renders the real registry page without
      // credentials, an external request, or a fabricated registry record.
      const response = isRegistryFixture(requestUrl)
        ? registryLookup
        : responses.get(pathname);
      if (response === undefined) {
        throw new Error(`Missing docked-chat page fixture for ${pathname}`);
      }
      await route.fulfill({ status: 200, json: response });
    },
  );
};
