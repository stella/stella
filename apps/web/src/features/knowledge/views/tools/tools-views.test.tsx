import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ToolDetailPanelView } from "@/features/knowledge/views/tools/tool-detail-panel-view";
import { ToolsCatalogueView } from "@/features/knowledge/views/tools/tools-catalogue-view";
import type {
  KnowledgeTool,
  KnowledgeToolDetail,
} from "@/features/knowledge/views/tools/tools-seam";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {node}
      </FormattingProvider>
    </IntlProvider>,
  );

/** What a catalogue without an organization knows about a tool. */
const TOOL: KnowledgeTool = {
  slug: "registry",
  kind: "mcp",
  displayName: "Registry",
  description: "Company registry lookups",
  author: "someone",
  cost: "free",
  setup: "none",
  icon: null,
  jurisdictions: ["EU"],
  tags: [],
};

const DETAIL: KnowledgeToolDetail = { ...TOOL, license: "MIT" };

const BODY_TEXT = "long-form-body";
const FOOTER_TEXT = "footer-action";

const catalogue = (tools: readonly KnowledgeTool[]) =>
  render(
    <ToolsCatalogueView
      renderEntry={(tool) => <p key={tool.slug}>{tool.slug}</p>}
      source={{ entries: tools }}
    />,
  );

describe("tools catalogue", () => {
  test("ranks tools under Recommended and Others where the source ranks them", () => {
    const html = catalogue([
      { ...TOOL, isRecommendedForOrg: true },
      {
        ...TOOL,
        slug: "other",
        displayName: "Other",
        isRecommendedForOrg: false,
      },
    ]);
    expect(html).toContain("Recommended");
    expect(html).toContain("Others");
  });

  // A source without an organization has no ranking; its tools are listed
  // without a heading that would claim one.
  test("lists unranked tools without ranking headings", () => {
    const html = catalogue([TOOL]);
    expect(html).toContain(`<p>${TOOL.slug}</p>`);
    expect(html).not.toContain("Recommended");
    expect(html).not.toContain("Others");
  });
});

describe("tool detail panel", () => {
  test("shows long-form content and the footer only when given", () => {
    const bare = render(
      <ToolDetailPanelView onClose={() => undefined} tool={DETAIL} />,
    );
    expect(bare).not.toContain("<footer");
    expect(bare).not.toContain(BODY_TEXT);

    const full = render(
      <ToolDetailPanelView
        body={<p>{BODY_TEXT}</p>}
        footer={<button type="button">{FOOTER_TEXT}</button>}
        onClose={() => undefined}
        tool={DETAIL}
      />,
    );
    expect(full).toContain(BODY_TEXT);
    expect(full).toContain(FOOTER_TEXT);
    expect(full).toContain("<footer");
  });

  test("shows a server's settings only when the tool is connected", () => {
    expect(
      render(<ToolDetailPanelView onClose={() => undefined} tool={DETAIL} />),
    ).not.toContain("Configuration");
    expect(
      render(
        <ToolDetailPanelView
          onClose={() => undefined}
          tool={{
            ...DETAIL,
            connection: { url: "https://mcp.example.com", authType: "none" },
          }}
        />,
      ),
    ).toContain("Configuration");
  });
});
