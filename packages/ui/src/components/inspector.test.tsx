import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { Tabs, TabsList } from "@stll/ui/components/tabs";

import type * as InspectorModule from "./inspector";
import {
  Inspector,
  InspectorActions,
  InspectorContent,
  InspectorDescription,
  InspectorHeader,
  InspectorHeaderText,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorSection,
  InspectorSectionTitle,
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
  InspectorTitle,
} from "./inspector";

// Total over the module's exports, so a new slot component cannot land without
// being named here: `satisfies` fails to compile until it is, and the coverage
// assertion below then fails until the fixture renders it and RECORD_DATA_SLOTS
// classifies it as record data or chrome.
const SLOT_BY_EXPORT = {
  Inspector: "inspector",
  InspectorActions: "inspector-actions",
  InspectorContent: "inspector-content",
  InspectorDescription: "inspector-description",
  InspectorHeader: "inspector-header",
  InspectorHeaderText: "inspector-header-text",
  InspectorProperty: "inspector-property",
  InspectorPropertyLabel: "inspector-property-label",
  InspectorPropertyList: "inspector-property-list",
  InspectorPropertyValue: "inspector-property-value",
  InspectorSection: "inspector-section",
  InspectorSectionTitle: "inspector-section-title",
  InspectorTab: "inspector-tab",
  InspectorTabList: "inspector-tab-list",
  InspectorTabPanel: "inspector-tab-panel",
  InspectorTabs: "inspector-tabs",
  InspectorTitle: "inspector-title",
} as const satisfies Record<keyof typeof InspectorModule, string>;

type InspectorSlot = (typeof SLOT_BY_EXPORT)[keyof typeof SLOT_BY_EXPORT];

// Slots carrying caller-supplied record values; each must isolate its own bidi
// context so a Latin value inside an RTL inspector keeps its character order.
const RECORD_DATA_SLOTS = [
  "inspector-description",
  "inspector-property-value",
  "inspector-title",
] as const satisfies readonly InspectorSlot[];

describe("Inspector", () => {
  test("keeps one explicit content scroll owner", () => {
    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorHeader>Record</InspectorHeader>
        <InspectorTabs defaultValue="overview">
          <InspectorTabList aria-label="Record views">
            <InspectorTab value="overview">Overview</InspectorTab>
          </InspectorTabList>
          <InspectorTabPanel value="overview">Long content</InspectorTabPanel>
        </InspectorTabs>
      </Inspector>,
    );

    expect(markup).toContain('data-slot="inspector"');
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain('data-slot="inspector-tab-panel"');
    expect(markup.match(/overflow-y-auto/gu)).toHaveLength(1);
  });

  test("exposes active tabs and semantic property rows", () => {
    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorTabs defaultValue="overview">
          <InspectorTabList aria-label="Record views">
            <InspectorTab value="overview">Overview</InspectorTab>
            <InspectorTab value="activity">Activity</InspectorTab>
          </InspectorTabList>
          <InspectorTabPanel value="overview">
            <InspectorPropertyList>
              <InspectorProperty>
                <InspectorPropertyLabel>Owner</InspectorPropertyLabel>
                <InspectorPropertyValue>Ada</InspectorPropertyValue>
              </InspectorProperty>
            </InspectorPropertyList>
          </InspectorTabPanel>
          <InspectorTabPanel value="activity">No activity</InspectorTabPanel>
        </InspectorTabs>
      </Inspector>,
    );

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('data-slot="inspector-property-label"');
    expect(markup).toContain('data-slot="inspector-property-value"');

    // Tabs sit flush inside the root's `overflow-hidden`, so the focus ring has
    // to be drawn inside the tab or the indicator is clipped for keyboard users.
    expect(markup).toContain("focus-visible:ring-inset");

    // The slot names above survive a swap to generic elements, so pin the
    // description-list tags too: the semantics are the point of these slots.
    expect(markup).toMatch(/<dl\b/u);
    expect(markup).toMatch(/<dt\b/u);
    expect(markup).toMatch(/<dd\b/u);
  });

  test("isolates bidi on exactly the record-data slots", () => {
    // Every exported slot is rendered, so the assertion below is a closed set
    // over the whole shell rather than over whichever slots a case happened to
    // use: a new record-data slot that forgets `dir` fails the first direction,
    // and a chrome slot that grows one fails the second.
    const markup = renderToStaticMarkup(
      <>
        <Inspector>
          <InspectorHeader>
            <InspectorHeaderText>
              {/* A Latin identifier is exactly the value an RTL inspector reorders. */}
              <InspectorTitle>
                ECLI:CZ:NS:2024:25.CDO.1234.2023.1
              </InspectorTitle>
              <InspectorDescription>8 Tdo 1234/2023</InspectorDescription>
            </InspectorHeaderText>
            <InspectorActions>Actions</InspectorActions>
          </InspectorHeader>
          <InspectorTabs defaultValue="overview">
            <InspectorTabList aria-label="Record views">
              <InspectorTab value="overview">Overview</InspectorTab>
            </InspectorTabList>
            <InspectorTabPanel value="overview">
              <InspectorSection>
                <InspectorSectionTitle>Metadata</InspectorSectionTitle>
                <InspectorPropertyList>
                  <InspectorProperty>
                    <InspectorPropertyLabel>Docket</InspectorPropertyLabel>
                    <InspectorPropertyValue>
                      25 Cdo 1234/2023
                    </InspectorPropertyValue>
                  </InspectorProperty>
                </InspectorPropertyList>
              </InspectorSection>
            </InspectorTabPanel>
          </InspectorTabs>
        </Inspector>
        <Inspector>
          <InspectorContent>Untabbed layout</InspectorContent>
        </Inspector>
      </>,
    );

    const renderedSlots = new Set<string>();
    const isolatedSlots = new Set<string>();

    for (const tag of markup.match(/<[a-z][^>]*>/gu) ?? []) {
      const slot = /data-slot="([^"]+)"/u.exec(tag)?.[1];

      if (slot === undefined) {
        continue;
      }

      renderedSlots.add(slot);

      if (
        tag.includes('dir="auto"') &&
        tag.includes("[unicode-bidi:isolate]")
      ) {
        isolatedSlots.add(slot);
      }
    }

    // Closes the set in both directions against the module's exports rather
    // than against whatever the fixture happens to use: every declared slot
    // must be exercised, and any `inspector-*` slot the fixture renders must be
    // declared. Slots owned by the underlying tabs primitive are not prefixed,
    // so they stay out of this comparison.
    const inspectorSlotsRendered = [...renderedSlots]
      .filter((slot) => slot.startsWith("inspector"))
      .sort();

    expect(inspectorSlotsRendered).toEqual(
      Object.values(SLOT_BY_EXPORT).toSorted(),
    );

    expect([...isolatedSlots].sort()).toEqual([...RECORD_DATA_SLOTS]);
  });

  test("holds forced chrome props against a widened spread", () => {
    // The omits on these wrappers only reject a literal `orientation`/`variant`.
    // An object annotated with the full props type satisfies `Omit<...>` under
    // structural width subtyping and the rest spread forwards it, so the pins
    // after each spread are what actually hold the chrome. Both forced props in
    // the shell are exercised here; `dir` is deliberately not among them, since
    // record-data slots stay caller-overridable.
    const leakedTabs: React.ComponentProps<typeof Tabs> = {
      defaultValue: "overview",
      orientation: "vertical",
    };
    const leakedTabList: React.ComponentProps<typeof TabsList> = {
      variant: "default",
    };

    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorTabs {...leakedTabs}>
          <InspectorTabList {...leakedTabList} aria-label="Record views">
            <InspectorTab value="overview">Overview</InspectorTab>
          </InspectorTabList>
          <InspectorTabPanel value="overview">Content</InspectorTabPanel>
        </InspectorTabs>
      </Inspector>,
    );

    expect(markup).toContain('data-orientation="horizontal"');
    expect(markup).not.toContain('data-orientation="vertical"');

    // The variant is only observable through the indicator's styling: the
    // underline strip paints `bg-primary`, the default variant a rounded chip.
    const indicator = /<[a-z][^>]*data-slot="tab-indicator"[^>]*>/u.exec(
      markup,
    )?.[0];

    expect(indicator).toContain("bg-primary");
    expect(indicator).not.toContain("rounded-md");
  });

  test("lets callers force a direction on a record-data slot", () => {
    const markup = renderToStaticMarkup(
      <InspectorPropertyValue dir="ltr">CASE-1/2023</InspectorPropertyValue>,
    );

    expect(markup).toContain('dir="ltr"');
    expect(markup).not.toContain('dir="auto"');
  });
});
