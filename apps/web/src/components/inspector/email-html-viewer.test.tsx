import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  EmailFileViewer,
  EmailHtmlViewer,
} from "@/components/inspector/email-html-viewer";
import {
  EMAIL_CHAT_MODE,
  EMAIL_EXTRACTION_POLL_INTERVAL_MS,
  EMAIL_VIEWER_LAYOUT,
  getEmailChatMode,
  getEmailExtractionRefetchInterval,
  getEmailFileChatContext,
  shouldSurfaceEmailChatResolutionError,
} from "@/components/inspector/email-html-viewer.logic";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";
import { EMAIL_BODY_FOLD_KIND } from "@/lib/files/email-preview";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";

const FORMATTING_LOCALE = "en-u-nu-arab";

const renderWithProviders = (children: ReactNode, queryClient: QueryClient) =>
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider
        locale="en"
        // SAFETY: locale catalogs are checked by i18n:check; this mirrors the
        // app's provider boundary used by the other static component tests.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <FormattingProvider locale={FORMATTING_LOCALE} timeZone="UTC">
          {children}
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

describe("email viewer", () => {
  test("passes the complete file identity to contextual chat", () => {
    expect(
      getEmailFileChatContext({
        entityId: "entity-1",
        fieldId: "field-1",
        fileName: "message.eml",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      activeFile: {
        entityId: "entity-1",
        fileFieldId: "field-1",
        fileName: "message.eml",
      },
      workspaceId: "workspace-1",
    });

    const html = renderWithProviders(
      <EmailFileViewer
        chatMode={EMAIL_CHAT_MODE.contextual}
        entityId="entity-1"
        fieldId="field-1"
        fileName="message.eml"
        workspaceId="workspace-1"
      />,
      new QueryClient(),
    );

    expect(html).toContain('data-file-viewer-ai="true"');
    expect(html).toContain('data-file-viewer-root="true"');
    expect(html).toContain("flex min-h-0 flex-1 flex-col");
    expect(html).toContain('role="status"');
  });

  test("keeps historical and unresolved versions preview-only", () => {
    expect(
      getEmailChatMode({
        extractionFileFieldId: "field-current-primary",
        fieldId: "field-current-primary",
      }),
    ).toBe(EMAIL_CHAT_MODE.contextual);
    expect(
      getEmailChatMode({
        extractionFileFieldId: "field-current-primary",
        fieldId: "field-current-secondary",
      }),
    ).toBe(EMAIL_CHAT_MODE.previewOnly);
    expect(
      getEmailChatMode({
        extractionFileFieldId: undefined,
        fieldId: "field-current-primary",
      }),
    ).toBe(EMAIL_CHAT_MODE.previewOnly);
  });

  test("preserves chat when a background resolution refresh fails", () => {
    expect(
      shouldSurfaceEmailChatResolutionError({ hasData: true, isError: true }),
    ).toBe(false);
    expect(
      shouldSurfaceEmailChatResolutionError({ hasData: false, isError: true }),
    ).toBe(true);
  });

  test("polls only while an open email is awaiting extraction", () => {
    expect(
      getEmailExtractionRefetchInterval({
        extractionFileFieldId: null,
        isEmailViewerActive: true,
      }),
    ).toBe(EMAIL_EXTRACTION_POLL_INTERVAL_MS);
    expect(
      getEmailExtractionRefetchInterval({
        extractionFileFieldId: "field-current",
        isEmailViewerActive: true,
      }),
    ).toBe(false);
    expect(
      getEmailExtractionRefetchInterval({
        extractionFileFieldId: null,
        isEmailViewerActive: false,
      }),
    ).toBe(false);
  });

  test("does not load the AI host for preview-only email fields", () => {
    const html = renderWithProviders(
      <EmailFileViewer
        chatMode={EMAIL_CHAT_MODE.previewOnly}
        entityId="entity-1"
        fieldId="field-sibling"
        fileName="message.eml"
        workspaceId="workspace-1"
      />,
      new QueryClient(),
    );

    expect(html).not.toContain('data-file-viewer-ai="true"');
    expect(html).toContain('data-file-viewer-root="true"');
    expect(html).not.toContain("pb-40");
    expect(html).toContain('role="status"');
  });

  test("surfaces contextual chat resolution failures with retry", () => {
    const html = renderWithProviders(
      <EmailFileViewer
        chatMode={EMAIL_CHAT_MODE.resolutionError}
        entityId="entity-1"
        fieldId="field-1"
        fileName="message.eml"
        onRetryChatResolution={() => undefined}
        workspaceId="workspace-1"
      />,
      new QueryClient(),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).not.toContain('data-file-viewer-ai="true"');
    expect(html).toContain('data-file-viewer-root="true"');
    expect(html).not.toContain("pb-40");
  });

  test("renders native metadata and keeps attachments informational", () => {
    const queryClient = new QueryClient();
    const options = emailHtmlPreviewOptions({
      fieldId: "field-1",
      workspaceId: "workspace-1",
    });
    queryClient.setQueryData(options.queryKey, {
      attachments: [
        {
          fileName: "contract.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
        },
      ],
      bcc: ["blind@example.org"],
      bodyFolds: [
        { id: "fold-0", kind: EMAIL_BODY_FOLD_KIND.quotedHistory },
        { id: "fold-1", kind: EMAIL_BODY_FOLD_KIND.signature },
      ],
      bodyHtml:
        '<p>Message body</p><details data-stella-email-fold="quoted-history"><summary data-stella-email-fold-summary="fold-0"></summary><blockquote>Previous message</blockquote></details><details data-stella-email-fold="signature"><summary data-stella-email-fold-summary="fold-1"></summary><p>Kind regards</p></details>',
      cc: ["copy@example.org"],
      date: "Mon, 02 Jun 2026 10:00:00 +0000",
      from: "Sender <sender@example.org>",
      subject: "Contract draft",
      to: ["client@example.org", "عائشة <aisha@example.ae>"],
    });

    const html = renderWithProviders(
      <EmailHtmlViewer
        fieldId="field-1"
        layout={EMAIL_VIEWER_LAYOUT.contextualChat}
        workspaceId="workspace-1"
      />,
      queryClient,
    );

    expect(html).toContain(">Contract draft</span></h1>");
    expect(html).toContain(">Sender &lt;sender@example.org&gt;</bdi>");
    expect(html).toContain(">client@example.org</bdi>");
    expect(html).toContain(">عائشة &lt;aisha@example.ae&gt;</bdi>");
    expect(html).toContain('dateTime="2026-06-02T10:00:00.000Z"');
    expect(html).toContain("Show details");
    expect(html).toContain(">blind@example.org</bdi>");
    expect(html).toContain("contract.pdf");
    expect(html).toContain(">٢ kB</span>");
    expect(html).toContain('sandbox=""');
    expect(html).toContain("pb-40");
    expect(html).toContain("srcDoc=");
    expect(html).toContain("Message body");
    expect(html).toContain("Show previous messages");
    expect(html).toContain("Hide previous messages");
    expect(html).toContain("Previous message");
    expect(html).toContain("Show signature");
    expect(html).toContain("Hide signature");
    expect(html).toContain("Kind regards");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<button");
  });

  test("renders the scoped loading state", () => {
    const html = renderWithProviders(
      <EmailHtmlViewer fieldId="field-2" workspaceId="workspace-2" />,
      new QueryClient(),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
  });

  test("renders the scoped error state with a retry control", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnMount: false,
          retry: false,
          retryOnMount: false,
        },
      },
    });
    const options = emailHtmlPreviewOptions({
      fieldId: "field-3",
      workspaceId: "workspace-3",
    });
    const fetchResult = await Result.tryPromise({
      try: async () =>
        await queryClient.fetchQuery({
          ...options,
          queryFn: async () => {
            throw new Error("preview unavailable");
          },
        }),
      catch: (cause) => cause,
    });
    expect(Result.isError(fetchResult)).toBe(true);
    if (Result.isError(fetchResult)) {
      expect(fetchResult.error).toMatchObject({
        message: "preview unavailable",
      });
    }

    const html = renderWithProviders(
      <EmailHtmlViewer fieldId="field-3" workspaceId="workspace-3" />,
      queryClient,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).toContain(">Try again</button>");
  });
});
