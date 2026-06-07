// Passive regression fixture for
// `require-matter-affordance/require-matter-affordance`.
//
// `oxlint-disable-next-line` directives below intentionally suppress cases
// the rule MUST flag. If the rule regresses, the disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

import { Link, Navigate } from "@tanstack/react-router";

import { MatterContextMenu } from "@/routes/_protected.workspaces/-components/matter-context-menu";
import { MatterRefLink } from "@/routes/_protected.workspaces/-components/matter-ref-link";

const target = {
  id: "workspace_1",
  name: "Matter",
  color: null,
  client: null,
};

const CustomLink = (_props: { to: string }) => null;

// --- Cases the rule MUST flag ---

export const FlagRawMatterLink = () => (
  // oxlint-disable-next-line require-matter-affordance/require-matter-affordance
  <Link params={{ workspaceId: target.id }} to="/workspaces/$workspaceId" />
);

export const FlagExpressionMatterLink = () => (
  // oxlint-disable-next-line require-matter-affordance/require-matter-affordance
  <Link params={{ workspaceId: target.id }} to={"/workspaces/$workspaceId"} />
);

export const FlagCustomMatterLink = () => (
  // oxlint-disable-next-line require-matter-affordance/require-matter-affordance
  <CustomLink to="/workspaces/$workspaceId" />
);

// --- Cases the rule MUST NOT flag ---

export const ListingWrappedWithMenu = () => (
  <MatterContextMenu target={target}>
    <Link params={{ workspaceId: target.id }} to="/workspaces/$workspaceId" />
  </MatterContextMenu>
);

export const InlineReference = () => (
  <MatterRefLink workspaceId={target.id}>Matter</MatterRefLink>
);

export const Redirect = () => (
  <Navigate params={{ workspaceId: target.id }} to="/workspaces/$workspaceId" />
);

export const OtherRoute = () => <Link to="/workspaces">Matters</Link>;
