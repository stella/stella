import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { TOOLBAR_ROW_HEIGHT } from "./layout-tokens";
import {
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
  resolveInspectorTabOrientation,
} from "./tabs";

const classesOf = (markup: string, slot: string) => {
  const match = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "u").exec(markup);
  const classAttribute = /class="([^"]*)"/u.exec(match?.[0] ?? "");
  return classAttribute?.[1]?.split(/\s+/u) ?? [];
};

describe("inspector tabs", () => {
  test("matches keyboard orientation to the responsive rail", () => {
    expect(resolveInspectorTabOrientation(767)).toBe("horizontal");
    expect(resolveInspectorTabOrientation(768)).toBe("vertical");
  });

  test("shares the inspector's fixed-height rail rhythm", () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs defaultValue="overview">
        <InspectorTabList>
          <InspectorTab value="overview">Overview</InspectorTab>
        </InspectorTabList>
        <InspectorTabPanel value="overview">Content</InspectorTabPanel>
      </InspectorTabs>,
    );

    expect(classesOf(markup, "inspector-tab-list")).toContain(
      TOOLBAR_ROW_HEIGHT,
    );
    expect(classesOf(markup, "inspector-tab")).toContain(TOOLBAR_ROW_HEIGHT);
    expect(classesOf(markup, "inspector-tab-list")).toContain("md:w-12");
    expect(classesOf(markup, "inspector-tab-list")).toEqual(
      expect.arrayContaining(["overflow-x-auto", "md:overflow-y-auto"]),
    );
  });

  test("keeps one scroll owner beside the desktop rail", () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs defaultValue="overview">
        <InspectorTabList>
          <InspectorTab value="overview">Overview</InspectorTab>
        </InspectorTabList>
        <InspectorTabPanel value="overview">Content</InspectorTabPanel>
      </InspectorTabs>,
    );

    expect(classesOf(markup, "inspector-tab-panel")).toEqual(
      expect.arrayContaining(["overflow-y-auto", "md:col-start-2"]),
    );
  });
});
