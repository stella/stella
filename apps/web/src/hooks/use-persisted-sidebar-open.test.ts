import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  defaultPresentationPrefs,
  parseLegacySidebarOpen,
} from "@/lib/account/presentation-prefs/preferences";
import { PresentationPrefsProvider } from "@/lib/account/presentation-prefs/provider";

import { usePersistedSidebarOpen } from "./use-persisted-sidebar-open";

const SidebarSnapshot = () => {
  const { open } = usePersistedSidebarOpen({
    defaultOpen: true,
    usePreference: true,
  });
  return createElement("aside", {
    "data-state": open ? "expanded" : "collapsed",
  });
};

describe("persisted sidebar server snapshot", () => {
  test("reads a valid pre-cutover sidebar cookie and ignores unknown values", () => {
    expect(parseLegacySidebarOpen(undefined)).toBeNull();
    expect(parseLegacySidebarOpen(null)).toBeNull();
    expect(parseLegacySidebarOpen("open")).toBeNull();
    expect(parseLegacySidebarOpen("expanded")).toBe(true);
    expect(parseLegacySidebarOpen("collapsed")).toBe(false);
  });

  test("the server renders the cookie preference before any client code runs", () => {
    for (const sidebarOpen of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(
          PresentationPrefsProvider,
          {
            initialPrefs: { ...defaultPresentationPrefs, sidebarOpen },
          },
          createElement(SidebarSnapshot),
        ),
      );
      expect(html).toContain(
        `data-state="${sidebarOpen ? "expanded" : "collapsed"}"`,
      );
    }
  });
});
