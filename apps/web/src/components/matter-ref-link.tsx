import { Link } from "@tanstack/react-router";

type MatterRefLinkProps = {
  workspaceId: string;
  className?: string;
  title?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  children: React.ReactNode;
};

/**
 * A non-listing reference link to a matter — breadcrumbs, side panels,
 * task rows, contact-scoped matter lists. Navigates only and
 * intentionally carries NO right-click menu.
 *
 * For a browsable matter listing (sidebar, matters grid/table, the chat
 * landing), wrap the trigger in `<MatterContextMenu>` (or wire it with
 * `useMatterContextMenu`) so the shared menu is present. The
 * `require-matter-affordance` lint rule forces every matter link to pick
 * one of these two paths.
 */
export const MatterRefLink = ({
  workspaceId,
  ...props
}: MatterRefLinkProps) => (
  <Link params={{ workspaceId }} to="/workspaces/$workspaceId" {...props} />
);
