import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/statutes" });

// The build turns a `?worker&url` import into the emitted worker's URL; the
// chat overlay's chunk only holds on to it.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

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
      return Response.json(aiAvailableResponse());
    }
    // A reader opening its chat for the first time has no thread yet.
    if (/\/chat\/threads\/[^/]+\/messages$/u.test(url.pathname)) {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    // The composer's matter picker: a member with no matters yet.
    if (url.pathname.endsWith("/workspaces/navigation")) {
      return Response.json({ items: [], nextCursor: null, workspaces: [] });
    }
    return Response.json({});
  },
  { preconnect: originalFetch.preconnect },
);

const { Editor } = await import("@tiptap/core");
const { act, cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { LegalReaderAIChat } = await import("./legal-reader-ai-chat");
const { askAboutReaderPassage } =
  await import("./annotations/reader-annotation-target");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { DECISION_IDENTIFIER_TYPES } =
  await import("@stll/legal-ast/decision-identifier");

const READER_CONTENT = "Reader content";

afterEach(() => {
  cleanup();
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

afterAll(async () => {
  // Let React finish the work the readers scheduled before the DOM goes.
  await act(async () => {
    await sleep(50);
  });
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

type ActiveLegal = Parameters<typeof LegalReaderAIChat>[0]["activeLegal"];

/** The law route as the app mounts a reader: no AI key gate above it. */
const mountReader = async (activeLegal: ActiveLegal) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ChatEditorProvider>
          <LegalReaderAIChat activeLegal={activeLegal} aiMode="enabled">
            <p>{READER_CONTENT}</p>
          </LegalReaderAIChat>
        </ChatEditorProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/law/cz/statutes"] }),
  });
  await router.load();
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
            <RouterProvider router={router} />
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return queryClient;
};

// The statute and decision readers, in the main view and in their inspector
// views, all reach the chat through this component. Every route that mounts
// it provides the chat editor, but none may be trusted to put the AI key gate
// above it, so the overlay must bring its own rather than panic in a
// signed-in reader's face.
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
    const queryClient = await mountReader(activeLegal);
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
    expect(screen.queryByRole("alert")).toBeNull();
    const composer = await screen.findByRole("textbox", undefined, {
      timeout: 15_000,
    });
    if (!("editor" in composer) || !(composer.editor instanceof Editor)) {
      panic("Expected the reader overlay's mounted TipTap composer");
    }
    const editor = composer.editor;
    expect(editor.isEditable).toBe(true);
    const originalText = editor.getText();
    await act(async () => {
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        "www.stll.app",
      );
    });
    expect(
      composer
        .querySelector("a[data-chat-composer-link]")
        ?.getAttribute("href"),
    ).toBe("https://www.stll.app/");
    expect(
      composer.querySelector("a[data-chat-composer-link]")?.textContent,
    ).toBe("www.stll.app");
    expect(editor.getText()).toBe(`${originalText}www.stll.app`);
    expect(editor.getHTML()).not.toContain("data-chat-composer-link");
    expect(editor.getHTML()).toContain("www.stll.app");
    queryClient.clear();
  },
  // The overlay host is a lazy chunk; its first load under a busy runner
  // outlasts the default per-test timeout.
  30_000,
);

// The reader's AI action sends a passage to the decision's one conversation
// and opens it in the docked chat. That tab is then the conversation's only
// composer: the reader floats none over the text rather than showing the same
// draft a second time, and its own returns, draft included, once the tab
// leaves the screen.
test(
  "asking about a passage leaves the docked chat as the only composer",
  async () => {
    const inspector = useInspectorTabsStore.getState();
    const decisionId = "decision-1";
    const caseNumber = "7 Azs 172/2025";
    const queryClient = await mountReader({
      type: "decision",
      decisionId,
      caseNumber,
    });
    await screen.findByRole("textbox", undefined, { timeout: 15_000 });
    try {
      await act(async () => {
        askAboutReaderPassage({
          prompt: "Explain the passage",
          quote: "Reader passage",
          target: {
            type: "decision",
            caseNumber,
            caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            country: "CZE",
            court: "Nejvyšší správní soud",
            decisionDate: null,
            decisionType: null,
            ecli: null,
            id: decisionId,
            name: null,
          },
        });
      });
      await waitFor(() => {
        expect(screen.queryAllByRole("textbox")).toEqual([]);
      });
      expect(screen.getByText(READER_CONTENT)).toBeDefined();
      // Closing the docked chat hands the conversation back to the reader.
      await act(async () => {
        useInspectorTabsStore.setState({ minimized: true });
      });
      const composer = await screen.findByRole("textbox", undefined, {
        timeout: 15_000,
      });
      if (!("editor" in composer) || !(composer.editor instanceof Editor)) {
        panic("Expected the reader overlay's mounted TipTap composer");
      }
      const editor = composer.editor;
      await waitFor(() => {
        expect(JSON.stringify(editor.getJSON())).toContain("Reader passage");
      });
    } finally {
      useInspectorTabsStore.setState(inspector, true);
      queryClient.clear();
    }
  },
  // The overlay host is a lazy chunk; its first load under a busy runner
  // outlasts the default per-test timeout.
  30_000,
);
