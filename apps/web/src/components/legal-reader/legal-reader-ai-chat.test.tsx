import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import {
  lookupLegalDocumentChatThread,
  useLegalDocumentChatThreads,
} from "@/features/chat/legal-document-chat-threads";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";

const documents = [
  {
    type: "decision",
    decisionId: "gated-decision",
    caseNumber: "7 Azs 172/2025",
  },
  { type: "statute", documentId: "gated-statute", title: "Civil Code" },
] as const satisfies readonly ActiveLegalDocument[];
const READER_CONTENT = "Reader content";

afterEach(() => {
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

for (const activeLegal of documents) {
  test(`a signed-in gated ${activeLegal.type} reader does not activate a conversation before its providers load`, () => {
    const { key } = activeLegalDocumentRef(activeLegal);
    expect(lookupLegalDocumentChatThread(key)).toEqual({ status: "none" });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "organization-1",
              email: "member@example.com",
              id: "user-1",
              image: null,
              name: "Member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <LegalReaderAIChat activeLegal={activeLegal} aiMode="gated">
              <p>{READER_CONTENT}</p>
            </LegalReaderAIChat>
          </AuthenticatedUserProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(markup).toContain(READER_CONTENT);
    expect(lookupLegalDocumentChatThread(key)).toEqual({ status: "none" });
  });
}
