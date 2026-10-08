import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";

import { AvtView } from "@/features/avt/avt-view";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";

type AvtRouteProps = {
  view: AvtWorkspaceView;
  workspaceId: string;
  runId: string | undefined;
  onRunChange: (runId: string | undefined) => void;
};

export const AvtRoute = ({
  view,
  workspaceId,
  runId,
  onRunChange,
}: AvtRouteProps) => {
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.verification);
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
