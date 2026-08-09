import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { TemplateForm } from "@/components/templates/template-form";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

// Regression guard for the Template Studio Fill tab having no AI prefill
// entry point: Studio's TemplateForm call now passes `prefill={{}}` (see
// template-studio-inspector.tsx's TemplateFillFacet), the same way
// use-template-dialog.tsx does for the matter "Use template" flow. This
// renders TemplateForm with that exact prop combination and asserts the
// real TemplatePrefillPanel mounts, not just a static pointer to it.
const renderWithProviders = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          {children}
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

describe("Template Studio Fill tab prefill", () => {
  test("renders the AI prefill panel when given Studio's fill-form props", () => {
    const html = renderWithProviders(
      <TemplateForm
        conditions={[]}
        fields={[]}
        fileName="Sample_Contract.docx"
        onBack={() => undefined}
        onDone={() => undefined}
        prefill={{}}
        structureErrors={[]}
        templateId="template-1"
      />,
    );

    // The panel's always-visible header, not just its expanded contents
    // (expansion is client-side state that a static render can't exercise).
    expect(html).toContain(messages.templates.prefillTitle);
    // No matter context in Studio, so the matter-documents picker must not
    // be offered — only upload/paste-text.
    expect(html).not.toContain(messages.templates.prefillMatterDocuments);
  });
});
