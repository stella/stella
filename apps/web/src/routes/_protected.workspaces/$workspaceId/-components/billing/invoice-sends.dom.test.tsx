import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { parseTimeZoneId } from "@stll/time";

import messages from "@/i18n/langs/en.json";
import type { InvoiceSends } from "@/lib/workspaces/queries/invoices";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { invoiceSendsInfiniteOptions } =
  await import("@/lib/workspaces/queries/invoices");
const { toSafeId } = await import("@/lib/safe-id");
const { useCallerFeatureAdmission } =
  await import("@/lib/organization/feature-access/access");
const { CALLER_FEATURE } =
  await import("@/lib/organization/feature-access/surfaces");
const { organizationSettingsOptions } =
  await import("@/queries/organization-settings");

const { InvoiceSendsSection } = await import("./invoice-sends");

const InvoiceHistory = ({
  workspaceId,
  invoiceId,
}: {
  workspaceId: string;
  invoiceId: string;
}) => {
  const admission = useCallerFeatureAdmission(CALLER_FEATURE.invoiceLinks);
  return (
    <InvoiceSendsSection
      workspaceId={workspaceId}
      invoiceId={invoiceId}
      sendControl={
        admission === undefined
          ? { type: "hidden" }
          : { type: "available", admission, onSendAgain: () => undefined }
      }
    />
  );
};

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => await unregisterDomEnvironment());

test.each([false, true])(
  "an active invoice link remains revocable when sending is available: %s",
  async (canSend) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const scope = {
      workspaceId: "019086ce-4321-7000-8000-000000000001",
      invoiceId: "019086ce-4321-7000-8000-000000000002",
      userId: "invoice-member",
    };
    client.setQueryData(
      organizationSettingsOptions({
        organizationId: "invoice-org",
        userId: scope.userId,
      }).queryKey,
      {
        declaredFeatureIds: ["invoice-links"],
        capabilities: {
          "invoice-links": { status: canSend ? "enabled" : "hidden" },
        },
        deploymentFeatures: { legalLists: false, invoiceLinks: true },
        documentProcessingMode: "off",
        matterNumberPattern: "{year}/{number}",
        matterNumberPadding: 3,
        matterNumberingEnabled: false,
        practiceJurisdictions: [],
        promptCachingEnabled: true,
        managedAIResidency: "eu",
        memoryExtractionEnabled: false,
        timeMinimumUnitMinutes: 1,
        timeEditWindowDays: 30,
        timeLockedThroughMonth: null,
        timeNarrativeRequired: false,
        timeZone: parseTimeZoneId("UTC") ?? panic("UTC fixture must exist"),
        timeZoneSource: "organization",
      } satisfies OrganizationSettings,
    );
    const history = {
      defaultRecipients: [],
      replyTo: null,
      nextCursor: null,
      limit: 20,
      items: [
        {
          id: toSafeId<"invoiceSend">("019086ce-4321-7000-8000-000000000003"),
          recipients: ["recipient@example.test"],
          failedRecipients: [],
          message: null,
          replyTo: "sender@example.test",
          language: "en",
          deliveryStatus: "delivered",
          linkStatus: "active",
          sentBy: null,
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2027-01-01T00:00:00Z",
          revokedAt: null,
          firstViewedAt: null,
        },
      ],
    } satisfies InvoiceSends;
    client.setQueryData(invoiceSendsInfiniteOptions(scope).queryKey, {
      pages: [history],
      pageParams: [undefined],
    });
    render(
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "invoice-org",
            id: scope.userId,
            email: "member@example.test",
            name: "Member",
            image: null,
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <InvoiceHistory
                workspaceId={scope.workspaceId}
                invoiceId={scope.invoiceId}
              />
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("button", {
        name: messages.billing.invoices.sending.revoke,
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: messages.billing.invoices.sending.sendAgain,
      }) !== null,
    ).toBe(canSend);
  },
);
