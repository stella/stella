import { lazy, Suspense } from "react";

import { useQueryClient, useSuspenseQueries } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import {
  ToolsCatalogueSkeleton,
  ToolsPageHeader,
} from "@/features/knowledge/views/tools/tools-page-chrome";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/lib/knowledge/queries/catalogue";
import { subscribeToMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import type { CatalogueBrowserFilterKind } from "@/routes/knowledge/-components/catalogue/catalogue-browser";

const LazyCatalogueBrowser = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-components/catalogue/catalogue-browser");
  return { default: module.CatalogueBrowserWithRouteData };
});

const toolsRouteApi = getRouteApi("/knowledge/tools");

/** The organization's tools: the catalogue with what it has installed,
 *  connected and recommended. */
export function MemberToolsPage({
  organizationId,
}: {
  /** The organization the section's gate selected; every read is keyed by it. */
  organizationId: string;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { id: userId } = useAuthenticatedUser();
  const initialKind = toolsRouteApi.useSearch({
    select: (s): CatalogueBrowserFilterKind | undefined => s.kind,
  });
  const initialSlug = toolsRouteApi.useSearch({
    select: (s): string | undefined => s.slug,
  });
  // Read together before the catalogue mounts: the browser reads the role
  // through a plain query, which must already be cached when it mounts.
  const [, { data: settings }, { data: role }] = useSuspenseQueries({
    queries: [
      catalogueOptions(organizationId, userId),
      organizationSettingsOptions({ organizationId, userId }),
      roleOptions,
    ],
  });
  const canCreateSkills = authClient.organization.checkRolePermission({
    permissions: { agentSkill: ["create"] },
    role,
  });
  const canManageCustomTools = hasOrganizationManagementAccess(role);

  // OAuth completion lands in a popup tab/window; the popup
  // broadcasts via BroadcastChannel (falling back to opener
  // postMessage), so the catalogue page needs an active subscription
  // to surface the toast and refetch the catalogue.
  useExternalSyncEffect(
    () =>
      subscribeToMcpOAuthOutcome((outcome) => {
        if (outcome.status === "connected") {
          stellaToast.add({
            title: t("knowledge.mcp.connectedToast"),
            type: "success",
          });
          detached(
            queryClient.invalidateQueries({
              queryKey: catalogueKeys.all(organizationId),
            }),
            "knowledge-tools.invalidate",
          );
          return;
        }
        notifyUserError(undefined, t("knowledge.mcp.errorTitle"), {
          description: t("knowledge.mcp.errorDescription"),
        });
      }),
    [organizationId, queryClient, t],
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <ToolsPageHeader />
      <Suspense fallback={<ToolsCatalogueSkeleton />}>
        <LazyCatalogueBrowser
          canCreateSkills={canCreateSkills}
          canManageCustomTools={canManageCustomTools}
          initialKind={initialKind}
          initialSlug={initialSlug}
          // The browser reads both search params once, on mount, so a link that
          // changes either one remounts it rather than leaving the previous
          // filter or detail panel in place.
          key={`${initialKind ?? "all"}:${initialSlug ?? ""}`}
          organizationId={organizationId}
          practiceJurisdictions={settings.practiceJurisdictions}
        />
      </Suspense>
    </div>
  );
}
