import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Inspector,
  InspectorHeader,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
} from "./inspector";

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
  });
});
