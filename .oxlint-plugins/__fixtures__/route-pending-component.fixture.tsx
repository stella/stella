// Passive regression fixture for
// `route-pending-component/route-pending-component`.
//
// The disabled lines must be flagged: a page route pairs its page with its
// own pending view from sibling modules. The clean routes below import both,
// delegate as a layout, or only redirect.

import { createFileRoute, Outlet } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { LeafPendingView } from "@/routes/-route-pending-view";

import { FixturePage } from "./route-pending-component.fixture.shell.page.fixture";
import { FixturePending } from "./route-pending-component.fixture.shell.pending.fixture";

const LocalPage = () => null;

// A page route without a pending view.
export const MissingPendingRoute = createFileRoute("/__fixture/missing")({
  // oxlint-disable-next-line route-pending-component/route-pending-component
  component: FixturePage,
});

// The frame's generic skeleton as a page's loading view.
export const DefaultPendingRoute = createFileRoute("/__fixture/default")({
  component: FixturePage,
  // oxlint-disable-next-line route-pending-component/route-pending-component
  pendingComponent: DefaultPendingComponent,
});

// A component defined in the route file.
export const LocalComponentRoute = createFileRoute("/__fixture/local")({
  component: LocalPage,
  // oxlint-disable-next-line route-pending-component/route-pending-component
  pendingComponent: FixturePending,
});

// expect-clean: route-pending-component/route-pending-component
export const PairedRoute = createFileRoute("/__fixture/paired")({
  component: FixturePage,
  pendingComponent: FixturePending,
});

const Layout = () => <Outlet />;

// A layout delegates its pending view to the page it leads to.
export const LayoutRoute = createFileRoute("/__fixture/layout")({
  component: Layout,
  pendingComponent: LeafPendingView,
});
