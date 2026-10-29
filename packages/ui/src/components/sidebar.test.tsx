import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  PanelTrigger,
  Sidebar,
  SIDEBAR_WIDTH_ICON_PX,
  SIDEBAR_WIDTH_PX,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "./sidebar";
import {
  deriveSidebarState,
  nextOpenMobile,
  nextRequestedOpen,
  resolveSidebarLayout,
  resolveSidebarOpen,
} from "./sidebar.logic";

describe("sidebar width constants", () => {
  test("match the documented expanded and icon-rail sizes", () => {
    expect(SIDEBAR_WIDTH_PX).toBe(256);
    expect(SIDEBAR_WIDTH_ICON_PX).toBe(48);
  });
});

describe("the sidebar's layout", () => {
  // Collapse state set on desktop survives into the mobile sheet; the sheet
  // must still draw labels, tooltips off, and the full avatar trigger.
  test("is the icon rail only on desktop while collapsed", () => {
    expect(resolveSidebarLayout({ isMobile: false, state: "collapsed" })).toBe(
      "rail",
    );
    expect(resolveSidebarLayout({ isMobile: false, state: "expanded" })).toBe(
      "full",
    );
    expect(resolveSidebarLayout({ isMobile: true, state: "collapsed" })).toBe(
      "full",
    );
    expect(resolveSidebarLayout({ isMobile: true, state: "expanded" })).toBe(
      "full",
    );
  });
});

describe("toggleSidebar's open-state transitions", () => {
  test("nextRequestedOpen flips the requested state, independent of forceCollapsed", () => {
    expect(nextRequestedOpen(true)).toBe(false);
    expect(nextRequestedOpen(false)).toBe(true);
  });

  test("nextOpenMobile flips the mobile sheet's open state", () => {
    expect(nextOpenMobile(true)).toBe(false);
    expect(nextOpenMobile(false)).toBe(true);
  });

  test("resolveSidebarOpen masks the requested state while forceCollapsed", () => {
    expect(
      resolveSidebarOpen({ forceCollapsed: false, requestedOpen: true }),
    ).toBe(true);
    expect(
      resolveSidebarOpen({ forceCollapsed: true, requestedOpen: true }),
    ).toBe(false);
    expect(
      resolveSidebarOpen({ forceCollapsed: false, requestedOpen: false }),
    ).toBe(false);
  });

  test("a toggle while forceCollapsed still records the flip for once it lifts", () => {
    const requestedOpen = true;
    const forceCollapsed = true;

    // Displayed as collapsed despite the requested state being open...
    expect(resolveSidebarOpen({ forceCollapsed, requestedOpen })).toBe(false);

    // ...but toggling flips the *requested* state, not the displayed one, so
    // it still takes effect once forceCollapsed lifts.
    const toggled = nextRequestedOpen(requestedOpen);
    expect(toggled).toBe(false);
    expect(
      resolveSidebarOpen({ forceCollapsed: false, requestedOpen: toggled }),
    ).toBe(false);
  });

  test("deriveSidebarState reflects the displayed open state", () => {
    expect(deriveSidebarState(true)).toBe("expanded");
    expect(deriveSidebarState(false)).toBe("collapsed");
  });
});

describe("SidebarProvider / Sidebar", () => {
  test("data-state reflects the icon-collapsed sidebar", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider onOpenChange={() => undefined} open={false}>
        <Sidebar collapsible="icon">
          <div>Content</div>
        </Sidebar>
      </SidebarProvider>,
    );

    expect(markup).toContain('data-state="collapsed"');
    expect(markup).toContain('data-collapsible="icon"');
  });

  for (const variant of ["floating", "inset"] as const) {
    test.each(["left", "right"] as const)(
      `${variant} sidebar on the %s adds its gutter to exposed safe-area insets`,
      (side) => {
        const markup = renderToStaticMarkup(
          <SidebarProvider>
            <Sidebar side={side} variant={variant}>
              Content
            </Sidebar>
          </SidebarProvider>,
        );

        expect(markup).toContain(
          "pt-[calc(var(--safe-area-top)+--spacing(2))]",
        );
        expect(markup).toContain(
          "pb-[calc(var(--safe-area-bottom)+--spacing(2))]",
        );
        const attachedEdge = side === "left" ? "ps" : "pe";
        const inset = side === "left" ? "inline-start" : "inline-end";
        expect(markup).toContain(
          `${attachedEdge}-[calc(var(--safe-area-${inset})+--spacing(2))]`,
        );
      },
    );
  }
});

describe("PanelTrigger", () => {
  // The sidebar trigger and a panel trigger at the opposite edge share one
  // toolbar row; they must differ only in which panel icon they draw.
  test("the sidebar trigger and a right panel trigger render as mirror images", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarTrigger className="-ms-1" label="Sidebar" />
        <PanelTrigger className="-me-1" label="Inspector" side="right" />
      </SidebarProvider>,
    );
    const buttonClasses = [
      ...markup.matchAll(/<button[^>]*class="([^"]*)"/gu),
    ].map((match) => match[1]);
    const iconClasses = [...markup.matchAll(/<svg[^>]*class="([^"]*)"/gu)].map(
      (match) => match[1],
    );

    expect(buttonClasses).toHaveLength(2);
    expect(buttonClasses[0]?.replace(" -ms-1", "")).toBe(
      buttonClasses[1]?.replace(" -me-1", ""),
    );
    expect(iconClasses).toHaveLength(2);
    expect(iconClasses[0]).toContain("panel-left");
    expect(iconClasses[1]).toContain("panel-right");
    // lucide names each glyph in its classes, and the left panel also by its
    // older alias, `lucide-sidebar`; past those names the icons match.
    const unnamed = (classes: string | undefined) =>
      classes
        ?.split(" ")
        .filter((name) => !/^lucide-(?:panel-|sidebar)/u.test(name))
        .join(" ");
    expect(unnamed(iconClasses[0])).toBe(unnamed(iconClasses[1]));
  });
});

describe("SidebarRail", () => {
  // The rail's className is static (it keys off the ambient data-side
  // attribute via CSS rather than branching on a prop), so both `side`
  // values render the same markup. The point of rendering both is to guard
  // against a future change that re-templates physical left-*/right-*
  // classes from the `side` prop directly.
  test.each(["left", "right"] as const)(
    'side="%s" positions the rail with logical start-*/end-* classes, not physical left-*/right-* offsets',
    (side) => {
      const markup = renderToStaticMarkup(
        <SidebarProvider onOpenChange={() => undefined} open={true}>
          <Sidebar side={side}>
            <SidebarRail />
          </Sidebar>
        </SidebarProvider>,
      );
      const rail = /<button[^>]*data-slot="sidebar-rail"[^>]*>/u
        .exec(markup)
        ?.at(0);
      if (rail === undefined) {
        throw new Error("Expected a SidebarRail button in the markup.");
      }

      // Content-facing boundary offsets, converted to logical classes.
      expect(rail).toContain("group-data-[side=left]:-end-4");
      expect(rail).toContain("group-data-[side=right]:start-0");
      expect(rail).toContain("after:start-1/2");
      expect(rail).toContain(
        "group-data-[collapsible=offcanvas]:group-data-[side=left]:after:end-full",
      );
      expect(rail).toContain(
        "group-data-[collapsible=offcanvas]:group-data-[side=right]:after:start-full",
      );
      expect(rail).toContain("[[data-side=left][data-collapsible=offcanvas]_&");
      expect(rail).toContain("-end-2");
      expect(rail).toContain(
        "[[data-side=right][data-collapsible=offcanvas]_&",
      );
      expect(rail).toContain("-start-2");

      // None of the old physical offsets should remain.
      expect(rail).not.toContain("-right-4");
      expect(rail).not.toContain("-right-2");
      expect(rail).not.toContain("left-0");
      expect(rail).not.toContain("left-1/2");
      expect(rail).not.toContain("left-full");
      expect(rail).not.toContain("-left-2");
    },
  );
});
