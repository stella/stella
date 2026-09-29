import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { toChatThreadId } from "@/lib/chat-thread-ref";

// The query module imports the Eden client, which reads the API URL eagerly.
beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const ORGANIZATION_ID = "org-1";

const USER = {
  activeOrganizationId: ORGANIZATION_ID,
  email: "member@example.test",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const renderDock = async ({
  mockAnswers,
  user,
}: {
  mockAnswers: boolean;
  user: AuthenticatedUser | null;
}) => {
  const { ChatComposerDock } = await import("./chat-composer-dock");
  const { aiConfigKeys } = await import("@/lib/organization/ai-config-queries");
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    aiConfigKeys.availability({ organizationId: ORGANIZATION_ID }),
    {
      available: true,
      deferredServiceTierAvailable: false,
      instanceProvisioned: true,
      mockAnswers,
      orgConfigured: false,
    },
  );
  const dock = (
    <ChatComposerDock
      status="pending"
      threadRef={{ scope: "global", threadId: toChatThreadId("thread-1") }}
    />
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          {user === null ? (
            dock
          ) : (
            <AuthenticatedUserProvider user={user}>
              {dock}
            </AuthenticatedUserProvider>
          )}
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe("mock model badge in the chat composer", () => {
  test("marks the composer as dev chrome while the mock answers", async () => {
    const markup = await renderDock({ mockAnswers: true, user: USER });

    expect(markup).toContain('data-slot="chat-mock-model-badge"');
    expect(markup).toContain("data-dev-chrome");
    expect(markup).toContain(en.chat.mockModel.label);
  });

  test("stays absent when a real model answers", async () => {
    const markup = await renderDock({ mockAnswers: false, user: USER });

    expect(markup).toContain('data-slot="chat-composer-dock"');
    expect(markup).not.toContain('data-slot="chat-mock-model-badge"');
    expect(markup).not.toContain(en.chat.mockModel.label);
  });

  test("stays absent outside a signed-in organization", async () => {
    const markup = await renderDock({ mockAnswers: true, user: null });

    expect(markup).toContain('data-slot="chat-composer-dock"');
    expect(markup).not.toContain('data-slot="chat-mock-model-badge"');
  });
});
