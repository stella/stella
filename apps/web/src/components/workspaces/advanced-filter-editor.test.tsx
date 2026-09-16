import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { GroupNode } from "@stll/conditions";

import type { FieldOption } from "@/components/conditions/condition-builder-logic";
import { leafFromField } from "@/components/conditions/condition-builder-logic";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

import {
  ADVANCED_FILTER_POPUP_CLASS_NAME,
  AdvancedFilterEditor,
} from "./advanced-filter-editor";

const FIELD = {
  operand: { type: "property", propertyId: "title" },
  label: "Title",
  valueType: "text",
  type: "text",
} as const satisfies FieldOption;

const FILTER = {
  type: "group",
  combinator: "and",
  children: [leafFromField(FIELD)],
} as const satisfies GroupNode;

const renderEditor = () =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {/* The builder reads the formatting locale for its date editor, so it
          renders under the same provider the app mounts it in. */}
      <FormattingProvider locale="en" timeZone="UTC">
        <AdvancedFilterEditor
          fields={[FIELD]}
          node={FILTER}
          onChange={() => undefined}
          onRemove={() => undefined}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

describe("advanced filter editor", () => {
  test("bounds nested rules in an internal scroll region above the footer", () => {
    const html = renderEditor();
    const scrollRegion = html.indexOf(
      'data-slot="advanced-filter-scroll-region"',
    );
    const footer = html.indexOf('data-slot="advanced-filter-footer"');

    expect(html).toContain(
      "max-h-[min(48rem,80dvh,var(--available-height,80dvh))]",
    );
    expect(html).toContain("overflow-auto");
    expect(html).toContain("overscroll-contain");
    expect(ADVANCED_FILTER_POPUP_CLASS_NAME).toContain(
      "*:data-[slot=popover-viewport]:p-0!",
    );
    expect(scrollRegion).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(scrollRegion);
  });
});
