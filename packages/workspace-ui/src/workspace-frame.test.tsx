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
