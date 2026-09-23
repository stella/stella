import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";

import { AvtView } from "@/features/avt/avt-view";
import { useAvtPreviewEnabled } from "@/hooks/use-avt-preview";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";

type AvtRouteProps = {
  view: AvtWorkspaceView;
  workspaceId: string;
  runId: string | undefined;
  onRunChange: (runId: string | undefined) => void;
};

/**
 * An AVT view renders only while the AVT preview is on. Otherwise the view is
 * hidden from the switcher, so a link to it lands on the matter's first view
 * that is not AVT.
 */
export const AvtRoute = ({
  view,
  workspaceId,
  runId,
  onRunChange,
}: AvtRouteProps) => {
  const enabled = useAvtPreviewEnabled();
  if (!enabled) {
    return <AvtDisabledRedirect workspaceId={workspaceId} />;
  }
  return (
    <AvtView
      key={view.id}
      onRunChange={onRunChange}
      runId={runId}
      view={view}
      workspaceId={workspaceId}
    />
  );
};

const AvtDisabledRedirect = ({ workspaceId }: { workspaceId: string }) => {
  const { data: fallbackViewId } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (views) =>
      views.find((view) => view.layout.type !== "avt")?.id ?? null,
  });
  if (fallbackViewId === null) {
    return <Navigate replace to="/workspaces" />;
  }
  return (
    <Navigate
      params={{ workspaceId, viewId: fallbackViewId }}
      replace
      to="/workspaces/$workspaceId/$viewId"
    />
  );
};
