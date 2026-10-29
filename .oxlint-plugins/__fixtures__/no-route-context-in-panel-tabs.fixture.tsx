import { getRouteApi, useRouteContext } from "@tanstack/react-router";

const route = getRouteApi("/_protected");

export const PanelTabFixture = () => {
  // oxlint-disable-next-line no-route-context-in-panel-tabs/no-route-context-in-panel-tabs -- Panel tabs obtain identity from shared providers.
  const context = useRouteContext({ from: "/_protected", strict: false });
  // oxlint-disable-next-line no-route-context-in-panel-tabs/no-route-context-in-panel-tabs -- Route API context remains scoped to one route.
  const routeContext = route.useRouteContext();
  // expect-clean: no-route-context-in-panel-tabs/no-route-context-in-panel-tabs
  const navigate = route.useNavigate();
  return String([context, routeContext, navigate]);
};
