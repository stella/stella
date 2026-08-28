import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { TOOLBAR_ROW_HEIGHT } from "./layout-tokens";
import {
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
  INSPECTOR_RAIL_MEDIA_QUERY,
  resolveInspectorTabOrientation,
} from "./tabs";

const classesOf = (markup: string, slot: string) => {
  const match = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "u").exec(markup);
  const classAttribute = /class="([^"]*)"/u.exec(match?.[0] ?? "");
  return classAttribute?.[1]?.split(/\s+/u) ?? [];
};

describe("inspector tabs", () => {
  test("matches keyboard orientation to the responsive rail", () => {
    expect(INSPECTOR_RAIL_MEDIA_QUERY).toBe("(min-width: 48rem)");
    expect(resolveInspectorTabOrientation(false)).toBe("horizontal");
    expect(resolveInspectorTabOrientation(true)).toBe("vertical");
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
    expect(classesOf(markup, "inspector-tab")).toEqual(
      expect.arrayContaining([
        "size-12",
        "shrink-0",
        "focus-visible:ring-inset",
      ]),
    );
    expect(classesOf(markup, "inspector-tab-list")).toContain("md:w-12");
    expect(classesOf(markup, "inspector-tab-list")).toEqual(
      expect.arrayContaining(["overflow-x-auto", "md:overflow-y-auto"]),
    );
  });

  test("preserves Base UI's state-aware className contract", () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs
        className={({ orientation }) => `orientation-${orientation}`}
        defaultValue="overview"
      >
        <InspectorTabList>
          <InspectorTab value="overview">Overview</InspectorTab>
        </InspectorTabList>
        <InspectorTabPanel value="overview">Content</InspectorTabPanel>
      </InspectorTabs>,
    );

    expect(classesOf(markup, "inspector-tabs")).toContain(
      "orientation-horizontal",
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

  test("hides a scrolling rail's scrollbar without reducing tab hit areas", () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs defaultValue="overview">
        <InspectorTabList>
          <InspectorTab value="overview">Overview</InspectorTab>
        </InspectorTabList>
        <InspectorTabPanel value="overview">Content</InspectorTabPanel>
      </InspectorTabs>,
    );

    expect(classesOf(markup, "inspector-tab-list")).toEqual(
      expect.arrayContaining([
        "scrollbar-none",
        "[&amp;::-webkit-scrollbar]:hidden",
      ]),
    );
  });
});
