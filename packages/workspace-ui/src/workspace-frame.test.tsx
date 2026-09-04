import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  ApplicationRail,
  ApplicationRailButton,
  ApplicationRailContent,
  ApplicationRailFooter,
  ApplicationRailHeader,
  ApplicationRailMenu,
} from "@stll/ui/application-rail";
import { SIDE_RAIL_WIDTH } from "@stll/ui/inspector";

import { WorkspaceFrame } from "./workspace-frame";

const resizeHandleProps = {
  "aria-orientation": "vertical",
  "aria-valuemax": 800,
  "aria-valuemin": 320,
  "aria-valuenow": 512,
  onKeyDown: () => undefined,
  onLostPointerCapture: () => undefined,
  onPointerCancel: () => undefined,
  onPointerDown: () => undefined,
  onPointerMove: () => undefined,
  onPointerUp: () => undefined,
  tabIndex: 0,
} as const;

test("renders one stella-owned frame from typed navigation and rail descriptors", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      endRail={{
        chatAction: {
          label: "Chat",
          reason: "Unavailable",
          status: "unavailable",
        },
        label: "Inspector",
        topAction: <span data-testid="rail-toggle" />,
      }}
      inspector={{
        pane: <div data-testid="pane" />,
        resizeHandleLabel: "Resize",
        resizeHandleProps,
        showPaneContent: true,
        width: 512,
      }}
      navigation={{
        compact: {
          content: <div data-testid="compact-navigation" />,
          label: "Navigation",
          onOpenChange: () => undefined,
          open: false,
          trigger: null,
        },
        items: [
          {
            active: true,
            icon: <span data-testid="nav-icon" />,
            id: "board",
            label: "Board",
            onActivate: () => undefined,
          },
        ],
        label: "Navigation",
      }}
      topBar={{ leading: <span data-testid="top-bar" /> }}
    >
      <div data-testid="content" />
    </WorkspaceFrame>,
  );
  const referenceRail = renderToStaticMarkup(
    <ApplicationRail aria-label="Navigation">
      <ApplicationRailHeader />
      <ApplicationRailContent>
        <ApplicationRailMenu>
          <ApplicationRailButton
            aria-current="page"
            aria-label="Board"
            data-active="true"
            title="Board"
            className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
            onClick={() => undefined}
          >
            <span data-testid="nav-icon" />
          </ApplicationRailButton>
        </ApplicationRailMenu>
      </ApplicationRailContent>
      <ApplicationRailFooter />
    </ApplicationRail>,
  );

  expect(rendered).toContain('data-slot="workspace-shell"');
  expect(rendered).toContain('data-slot="application-rail"');
  expect(rendered).toContain('data-slot="application-rail-button"');
  expect(rendered).toContain('aria-current="page"');
  expect(rendered).toContain('data-slot="inspector-rail"');
  expect(rendered).toContain('data-slot="inspector-dock"');
  expect(rendered).toContain('data-slot="inspector-rail"');
  expect(rendered).toContain("width:512px");
  expect(rendered).toContain(referenceRail);
});

test("renders the same stella rail primitive when the inspector pane is absent", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      endRail={{
        chatAction: {
          label: "Chat",
          reason: "Unavailable",
          status: "unavailable",
        },
        label: "Inspector",
        topAction: <span />,
      }}
      navigation={{
        compact: {
          content: <div />,
          label: "Navigation",
          onOpenChange: () => undefined,
          open: false,
          trigger: null,
        },
        items: [],
        label: "Navigation",
      }}
      topBar={{}}
    >
      <div />
    </WorkspaceFrame>,
  );

  expect(rendered).toContain('data-slot="application-rail"');
  expect(rendered).toContain('data-slot="inspector-rail"');
  expect(rendered).not.toContain('data-slot="inspector-dock"');
  expect(rendered).toContain("w-12");
});

const countOccurrences = (markup: string, needle: string) =>
  markup.split(needle).length - 1;

const describedNavigation = {
  compact: {
    content: <div />,
    label: "Navigation",
    onOpenChange: () => undefined,
    open: false,
    trigger: null,
  },
  items: [],
  label: "Navigation",
} as const;

test("mounts no end dock for a host with neither an inspector nor an end rail", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      navigation={describedNavigation}
      topBar={{}}
    >
      <div />
    </WorkspaceFrame>,
  );

  expect(rendered).toContain('data-slot="workspace-shell"');
  expect(rendered).not.toContain('data-slot="inspector-rail"');
  expect(rendered).not.toContain('data-slot="inspector-dock"');
  // The application rail is the only 48px strip left: the frame reserves no
  // second one on the inline-end edge.
  expect(countOccurrences(rendered, SIDE_RAIL_WIDTH)).toBe(1);
});

test("keeps the end rail when a host describes one without an inspector", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      endRail={{
        chatAction: {
          label: "Chat",
          reason: "Unavailable",
          status: "unavailable",
        },
        label: "Inspector",
        topAction: <span />,
      }}
      navigation={describedNavigation}
      topBar={{}}
    >
      <div />
    </WorkspaceFrame>,
  );

  expect(rendered).toContain('data-slot="inspector-rail"');
  expect(rendered).not.toContain('data-slot="inspector-dock"');
  expect(countOccurrences(rendered, SIDE_RAIL_WIDTH)).toBe(2);
});

test("keeps the inspector dock when a host has an inspector but no end rail", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      inspector={{
        pane: <div data-testid="pane" />,
        resizeHandleLabel: "Resize",
        resizeHandleProps,
        showPaneContent: false,
        width: 512,
      }}
      navigation={describedNavigation}
      topBar={{}}
    >
      <div />
    </WorkspaceFrame>,
  );

  expect(rendered).toContain('data-slot="inspector-dock"');
  expect(rendered).toContain('data-testid="pane"');
  // Without a rail there is nothing to collapse to, so the dock keeps the
  // described pane width rather than the 48px rail footprint.
  expect(rendered).toContain("width:512px");
  expect(rendered).not.toContain('data-slot="inspector-rail"');
  expect(countOccurrences(rendered, SIDE_RAIL_WIDTH)).toBe(1);
});

const sidebarNavigation = (
  defaultOpen: boolean,
  sidebar: { forceCollapsed?: boolean; open?: boolean } = {},
) =>
  ({
    compact: {
      content: <div />,
      label: "Navigation",
      onOpenChange: () => undefined,
      open: false,
      trigger: null,
    },
    footer: <span data-testid="nav-footer" />,
    header: <span data-testid="rail-only-header" />,
    items: [
      {
        active: true,
        icon: <span data-testid="nav-icon" />,
        id: "board",
        label: "Board",
        onActivate: () => undefined,
      },
    ],
    label: "Navigation",
    sidebar: {
      brand: <span data-testid="brand" />,
      defaultOpen,
      toggleLabel: { collapse: "Hide sidebar", expand: "Show sidebar" },
      ...sidebar,
    },
  }) as const;

const renderSidebarFrame = (
  defaultOpen: boolean,
  sidebar?: { forceCollapsed?: boolean; open?: boolean },
) =>
  renderToStaticMarkup(
    <WorkspaceFrame
      composition="described"
      endRail={{
        chatAction: {
          label: "Chat",
          reason: "Unavailable",
          status: "unavailable",
        },
        label: "Inspector",
        topAction: <span />,
      }}
      navigation={sidebarNavigation(defaultOpen, sidebar)}
      topBar={{}}
    >
      <div />
    </WorkspaceFrame>,
  );

test("renders described navigation through the sidebar shell when asked", () => {
  const rendered = renderSidebarFrame(true);

  expect(rendered).toContain('data-slot="workspace-shell"');
  expect(rendered).toContain('data-slot="sidebar"');
  expect(rendered).toContain('data-state="expanded"');
  // The items stay a navigation landmark, and keep the rail's 44px target.
  expect(rendered).toContain('<nav aria-label="Navigation">');
  expect(rendered).toContain('data-sidebar="menu-button"');
  expect(rendered).toContain('data-size="rail"');
  expect(rendered).toContain("h-11");
  expect(rendered).toContain('aria-current="page"');
  expect(rendered).toContain('data-testid="nav-icon"');
  expect(rendered).toContain('data-testid="nav-footer"');
  expect(rendered).toContain('data-testid="brand"');
  expect(rendered).toContain('aria-label="Hide sidebar"');
  expect(rendered).not.toContain('data-slot="application-rail"');
  // The sidebar owns its header row; the rail-only header slot is not shown.
  expect(rendered).not.toContain('data-testid="rail-only-header"');
});

test("hides the brand and names the expand toggle while the sidebar is collapsed", () => {
  const rendered = renderSidebarFrame(false);

  expect(rendered).toContain('data-state="collapsed"');
  expect(rendered).toContain('data-collapsible="icon"');
  expect(rendered).not.toContain('data-testid="brand"');
  expect(rendered).toContain('aria-label="Show sidebar"');
  expect(rendered).toContain('data-testid="nav-icon"');
});

test("a controlled open state wins over the default, and a forced collapse over both", () => {
  expect(renderSidebarFrame(true, { open: false })).toContain(
    'data-state="collapsed"',
  );
  expect(renderSidebarFrame(false, { open: true })).toContain(
    'data-state="expanded"',
  );
  expect(
    renderSidebarFrame(true, { forceCollapsed: true, open: true }),
  ).toContain('data-state="collapsed"');
});

test("uses the same frame for Stella-owned responsive chrome", () => {
  const rendered = renderToStaticMarkup(
    <WorkspaceFrame
      composition="host-responsive"
      endDock={<div data-testid="host-dock" />}
      navigation={{
        content: <nav data-testid="host-navigation" />,
        mode: "responsive",
      }}
      topBar={() => <header data-testid="host-top-bar" />}
    >
      <div data-testid="host-content" />
    </WorkspaceFrame>,
  );

  expect(rendered).toContain('data-slot="workspace-shell"');
  expect(rendered).toContain('data-testid="host-navigation"');
  expect(rendered).toContain('data-testid="host-top-bar"');
  expect(rendered).toContain('data-testid="host-dock"');
  expect(rendered).toContain('data-testid="host-content"');
});
