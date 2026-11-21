// A suppression becoming unused proves the default-view detector stopped firing.

declare const workspaceId: string;
declare const match: { params: { viewId: string } } | undefined;
declare const DEFAULT_WORKSPACE_VIEW_ID: string;
declare const Viewer: (props: { viewId: string }) => null;

export const hardcoded = {
  to: "/workspaces/$workspaceId/$viewId",
  // oxlint-disable-next-line no-literal-view-id/no-literal-view-id -- A navigation param names the default view slug.
  params: { workspaceId, viewId: "all" },
};

// oxlint-disable-next-line no-literal-view-id/no-literal-view-id -- A route fallback names the default view slug.
export const fallback = match?.params.viewId ?? "all";

// oxlint-disable-next-line no-literal-view-id/no-literal-view-id -- A JSX prop names the default view slug.
export const element = <Viewer viewId="all" />;

// oxlint-disable-next-line no-literal-view-id/no-literal-view-id -- A duplicate constant restates the slug.
export const ALL_VIEW_ID = "all";

// expect-clean: no-literal-view-id/no-literal-view-id
export const owned = {
  params: { workspaceId, viewId: DEFAULT_WORKSPACE_VIEW_ID },
  filter: "all",
};
