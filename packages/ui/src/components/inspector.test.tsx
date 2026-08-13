import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Inspector,
  InspectorContent,
  InspectorHeader,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorTab,
  InspectorTabs,
} from "./inspector";

describe("Inspector", () => {
  test("keeps one explicit content scroll owner", () => {
    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorHeader>Record</InspectorHeader>
        <InspectorTabs aria-label="Record views">
          <InspectorTab active>Overview</InspectorTab>
        </InspectorTabs>
        <InspectorContent>Long content</InspectorContent>
      </Inspector>,
    );

    expect(markup).toContain('data-slot="inspector"');
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain('data-slot="inspector-content"');
    expect(markup.match(/overflow-y-auto/gu)).toHaveLength(1);
  });

  test("exposes active tabs and semantic property rows", () => {
    const markup = renderToStaticMarkup(
      <Inspector>
        <InspectorTabs aria-label="Record views">
          <InspectorTab active>Overview</InspectorTab>
          <InspectorTab>Activity</InspectorTab>
        </InspectorTabs>
        <InspectorContent>
          <InspectorPropertyList>
            <InspectorProperty>
              <InspectorPropertyLabel>Owner</InspectorPropertyLabel>
              <InspectorPropertyValue>Ada</InspectorPropertyValue>
            </InspectorProperty>
          </InspectorPropertyList>
        </InspectorContent>
      </Inspector>,
    );

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('data-slot="inspector-property-label"');
    expect(markup).toContain('data-slot="inspector-property-value"');
  });
});
