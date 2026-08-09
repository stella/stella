import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { EmailHtmlViewer } from "@/components/inspector/email-html-viewer";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";
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
      bodyFolds: [{ id: "fold-0", kind: "quoted-history" }],
      bodyHtml:
        '<p>Message body</p><details data-stella-email-fold="quoted-history"><summary data-stella-email-fold-summary="fold-0"></summary><blockquote>Previous message</blockquote></details>',
      cc: ["copy@example.org"],
      date: "Mon, 02 Jun 2026 10:00:00 +0000",
      from: "Sender <sender@example.org>",
      subject: "Contract draft",
      to: ["client@example.org", "عائشة <aisha@example.ae>"],
    });

    const html = renderWithProviders(
      <EmailHtmlViewer fieldId="field-1" workspaceId="workspace-1" />,
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
    expect(html).toContain("srcDoc=");
    expect(html).toContain("Message body");
    expect(html).toContain("Show previous messages");
    expect(html).toContain("Hide previous messages");
    expect(html).toContain("Previous message");
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
