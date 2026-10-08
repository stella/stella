import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/statutes" });

const originalFetch = globalThis.fetch;
let availabilityReads = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      availabilityReads += 1;
      return Response.json({ available: true });
    }
    return Response.json({});
  },
  { preconnect: originalFetch.preconnect },
);

const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { LegalReaderAIChat } = await import("./legal-reader-ai-chat");

const READER_CONTENT = "Reader content";

afterEach(() => {
  cleanup();
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

// The statute and decision readers, in the main view and in their inspector
// views, all reach the chat through this component. The public law routes
// mount it without the app shell's providers, so it must bring what the
// overlay needs rather than panic in a signed-in reader's face.
test.each([
  {
    type: "statute",
    documentId: "statute-89-2012",
    title: "Civil Code",
  } as const,
  {
    type: "decision",
    decisionId: "decision-1",
    caseNumber: "7 Azs 172/2025",
  } as const,
])(
  "a signed-in $type reader renders its chat without a route-level AI gate",
  async (activeLegal) => {
    availabilityReads = 0;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-1",
            email: "member@example.test",
            id: "user-1",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <LegalReaderAIChat activeLegal={activeLegal} aiMode="enabled">
                <p>{READER_CONTENT}</p>
              </LegalReaderAIChat>
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );
    // Nothing above the reader provides the gate, so the only availability
    // read is the one the overlay host makes for itself. Without it the
    // overlay panics and its boundary shows the error fallback instead.
    await waitFor(
      () => {
        expect(availabilityReads).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(READER_CONTENT)).toBeDefined();
    expect(screen.queryByText(messages.common.somethingWentWrong)).toBeNull();
    queryClient.clear();
  },
  // The overlay host is a lazy chunk; its first load under a busy runner
  // outlasts the default per-test timeout.
  30_000,
);
