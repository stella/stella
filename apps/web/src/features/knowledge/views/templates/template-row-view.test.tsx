import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { TemplateRowView } from "@/features/knowledge/views/templates/template-row-view";
import type { KnowledgeTemplate } from "@/features/knowledge/views/templates/templates-seam";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const noop = () => undefined;

// The author avatar sits in the only wrapper hidden on narrow screens.
const AUTHOR_AVATAR = "hidden sm:inline-flex";

const render = (template: KnowledgeTemplate) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ul>
          <TemplateRowView
            actions={{ open: noop, menu: [] }}
            categoryName={null}
            density="comfortable"
            template={template}
          />
        </ul>
      </FormattingProvider>
    </IntlProvider>,
  );

/** What every source knows about a template: its content, nothing about use. */
const CONTENT_ONLY: KnowledgeTemplate = {
  id: "nda",
  name: "Nondisclosure agreement",
  fieldCount: 7,
  categoryId: null,
  tags: null,
  languages: ["en"],
  whenToUse: "Before sharing confidential information",
  whenNotToUse: null,
};

const LIBRARY_TEMPLATE: KnowledgeTemplate = {
  ...CONTENT_ONLY,
  updatedAt: "2026-02-01T00:00:00.000Z",
  lastUsedAt: "2026-02-02T00:00:00.000Z",
  useCount: 3,
  authorName: "A Person",
  authorImage: null,
};

describe("template row", () => {
  test("shows usage, times and the author a library records", () => {
    const html = render(LIBRARY_TEMPLATE);
    expect(html).toContain("7 fields");
    expect(html).toContain("Used 3 times");
    expect(html).toContain("Last used");
    expect(html).toContain("Updated");
    expect(html).toContain(AUTHOR_AVATAR);
  });

  // A source that does not know how a template was used must not be shown
  // as "never used" or "updated just now".
  test("leaves out what the source does not know", () => {
    const html = render(CONTENT_ONLY);
    expect(html).toContain("7 fields");
    expect(html).toContain("Before sharing confidential information");
    expect(html).not.toContain("Used");
    expect(html).not.toContain("Last used");
    expect(html).not.toContain("Updated");
    expect(html).not.toContain(AUTHOR_AVATAR);
  });

  test("an unknown author is still shown when the library records none", () => {
    const html = render({ ...LIBRARY_TEMPLATE, authorName: null });
    expect(html).toContain(AUTHOR_AVATAR);
  });
});
