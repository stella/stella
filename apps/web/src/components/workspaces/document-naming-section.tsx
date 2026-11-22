import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";

import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import { workspaceOptions } from "@/lib/workspaces/queries";
import { organizationSettingsOptions } from "@/queries/organization-settings";

type DocumentNamingSectionProps = {
  workspaceId: string;
};

/**
 * The matter's opt-in to the organization's document name pattern. Shown
 * only once the organization has a pattern, since there is nothing to opt
 * into before that.
 */
export const DocumentNamingSection = ({
  workspaceId,
}: DocumentNamingSectionProps) => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const workspaceView = queryView(
    useQuery(
      resourceQueryOptions(workspaceOptions(workspaceId), {
        resources: [RESOURCE_TYPE.WORKSPACE],
        scope: { type: "workspace", workspaceId },
      }),
    ),
  );
  const settingsView = queryView(
    useQuery(
      organizationSettingsOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
    ),
  );
  const optIn = useUpdateWorkspace();

  if (
    workspaceView.type !== "items" ||
    settingsView.type !== "items" ||
    settingsView.items.documentNamePattern === null
  ) {
    return null;
  }

  return (
    <section className="border-b px-3 py-2">
      <Field className="gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            checked={workspaceView.items.documentNamingEnabled}
            disabled={!canUpdate || optIn.isPending}
            onCheckedChange={(checked) => {
              if (typeof checked === "boolean") {
                optIn.mutate({
                  workspaceId,
                  update: { type: "documentNamingEnabled", value: checked },
                });
              }
            }}
          />
          <FieldLabel>{t("workspaces.documentNaming.label")}</FieldLabel>
        </div>
        <FieldDescription>
          {t("workspaces.documentNaming.description", {
            // Isolated left-to-right so an RTL sentence does not reverse its tokens.
            pattern: `\u2066${settingsView.items.documentNamePattern}\u2069`,
          })}
        </FieldDescription>
      </Field>
    </section>
  );
};
