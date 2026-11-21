import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { parseTimeZoneId } from "@stll/time";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import messages from "@/i18n/langs/en.json";
import type { OrganizationSettings } from "@/queries/organization-settings";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { organizationSettingsOptions } =
  await import("@/queries/organization-settings");
const { useDocxCitationCheck } = await import("./use-docx-citation-check");

const ORGANIZATION_ID = "citation-org";
const USER_ID = "citation-member";
const CITING_SENTENCE =
  "The limitation period runs anew, see sp. zn. 21 Cdo 1234/2020.";

const settings = (status: "enabled" | "hidden" | "undeclared") =>
  ({
    declaredFeatureIds: status === "undeclared" ? [] : ["citation-check"],
    capabilities:
      status === "undeclared" ? {} : { "citation-check": { status } },
    deploymentFeatures: { legalLists: false, invoiceLinks: false },
    documentProcessingMode: "off",
    matterNumberPattern: "{year}/{number}",
    matterNumberPadding: 3,
    matterNumberingEnabled: false,
    practiceJurisdictions: [],
    promptCachingEnabled: true,
    aiInstructions: "",
    aiInstructionsMaxLength: 3000,
    managedAIResidency: "eu",
    memoryExtractionEnabled: false,
    localRunMaxApprovalMode: "full_auto",
    timeMinimumUnitMinutes: 1,
    timeEditWindowDays: 30,
    timeLockedThroughMonth: null,
    timeNarrativeRequired: false,
    timeZone: parseTimeZoneId("UTC") ?? panic("UTC fixture must exist"),
    primaryJurisdictionTimeZone:
      parseTimeZoneId("UTC") ?? panic("UTC fixture must exist"),
    timeZoneSource: "organization",
  }) satisfies OrganizationSettings;

const clients: InstanceType<typeof QueryClient>[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => await unregisterDomEnvironment());

const renderCitationCheck = (status: "enabled" | "hidden" | "undeclared") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(
    organizationSettingsOptions({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    }).queryKey,
    settings(status),
  );
  const forwarded: string[] = [];
  const onSelectionTextChange = (selection: { text: string }) => {
    forwarded.push(selection.text);
  };
  const editorRef: { current: DocxEditorRef | null } = { current: null };
  const rendered = renderHook(
    () => useDocxCitationCheck({ editorRef, onSelectionTextChange }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: ORGANIZATION_ID,
              id: USER_ID,
              email: "member@example.test",
              name: "Member",
              image: null,
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              {children}
            </IntlProvider>
          </AuthenticatedUserProvider>
        </QueryClientProvider>
      ),
    },
  );
  return { rendered, onSelectionTextChange, forwarded };
};

const expectEditorUntouched = (status: "hidden" | "undeclared") => {
  globalThis.fetch = Object.assign(
    async () =>
      await Promise.resolve(panic("A disabled citation check sent a request")),
    { preconnect: originalFetch.preconnect },
  );
  const { rendered, onSelectionTextChange, forwarded } =
    renderCitationCheck(status);
  const { editorProps, card } = rendered.result.current;
  // The editor's own callback comes back as is, so a selection cannot arm
  // the settle timer or reach the check endpoint.
  expect(editorProps.onSelectionTextChange).toBe(onSelectionTextChange);
  expect(editorProps.customContextMenuItems).toBeUndefined();
  expect(editorProps.onCustomContextAction).toBeUndefined();
  expect(card).toBeNull();
  editorProps.onSelectionTextChange({
    from: 0,
    to: CITING_SENTENCE.length,
    text: CITING_SENTENCE,
  });
  expect(forwarded).toEqual([CITING_SENTENCE]);
};

test("a hidden feature leaves the editor's selection callback alone and requests nothing", () => {
  expectEditorUntouched("hidden");
});

test("an undeclared feature leaves the editor's selection callback alone and requests nothing", () => {
  expectEditorUntouched("undeclared");
});

test("with the feature enabled a selection naming a decision offers the check and still reaches the editor", () => {
  const { rendered, forwarded } = renderCitationCheck("enabled");
  act(() => {
    rendered.result.current.editorProps.onSelectionTextChange({
      from: 0,
      to: CITING_SENTENCE.length,
      text: CITING_SENTENCE,
    });
  });
  expect(forwarded).toEqual([CITING_SENTENCE]);
  expect(
    rendered.result.current.editorProps.customContextMenuItems?.map(
      (item) => item.id,
    ),
  ).toEqual(["stella.check-citation"]);
});
