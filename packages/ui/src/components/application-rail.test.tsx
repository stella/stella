import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  ApplicationRail,
  ApplicationRailButton,
  ApplicationRailContent,
  ApplicationRailFooter,
  APPLICATION_RAIL_BUTTON_SIZE,
  ApplicationRailHeader,
  ApplicationRailMenu,
  ApplicationRailSeparator,
  APPLICATION_RAIL_ICON_SIZE,
  APPLICATION_RAIL_WIDTH,
} from "./application-rail";

const classesOf = (markup: string, slot: string) => {
  const match = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "u").exec(markup);
  const classAttribute = /class="([^"]*)"/u.exec(match?.[0] ?? "");
  return classAttribute?.[1]?.split(/\s+/u) ?? [];
};

describe("application rail", () => {
  test("keeps compact navigation and account controls inside stella's rail rhythm", () => {
    const markup = renderToStaticMarkup(
      <ApplicationRail aria-label="Application navigation">
        <ApplicationRailHeader>
          <ApplicationRailButton aria-label="Home">Home</ApplicationRailButton>
        </ApplicationRailHeader>
        <ApplicationRailContent>
          <ApplicationRailMenu>
            <ApplicationRailButton aria-label="Search">
              Search
            </ApplicationRailButton>
          </ApplicationRailMenu>
          <ApplicationRailSeparator />
        </ApplicationRailContent>
        <ApplicationRailFooter>
          <ApplicationRailButton aria-label="Account">
            Account
          </ApplicationRailButton>
        </ApplicationRailFooter>
      </ApplicationRail>,
    );

    expect(classesOf(markup, "application-rail")).toEqual(
      expect.arrayContaining([APPLICATION_RAIL_WIDTH, "border-e", "md:flex"]),
    );
    expect(classesOf(markup, "application-rail-header")).toEqual(
      expect.arrayContaining(["h-12", "border-b", "p-0.5"]),
    );
    expect(classesOf(markup, "application-rail-menu")).toEqual(
      expect.arrayContaining(["gap-0.5", "p-0.5"]),
    );
    expect(classesOf(markup, "application-rail-button")).toEqual(
      expect.arrayContaining([
        APPLICATION_RAIL_BUTTON_SIZE,
        "rounded-md",
        "focus-visible:ring-2",
      ]),
    );
    expect(APPLICATION_RAIL_ICON_SIZE).toBe("size-4");
    expect(APPLICATION_RAIL_BUTTON_SIZE).toBe("size-11");
    expect(classesOf(markup, "application-rail-footer")).toEqual(
      expect.arrayContaining(["mt-auto", "p-0.5"]),
    );
  });
});
