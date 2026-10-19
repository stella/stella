import { useId, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  DATA_BOX_ID_LENGTH,
  DATA_BOX_ID_PATTERN,
} from "@stll/api-contract/data-box";
import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Trash2Icon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { allCorrespondenceQueryRoot } from "@/lib/resource-query-roots.logic";
import { useQueryView } from "@/lib/use-query-view";
import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";
import {
  organizationDataBoxesKeys,
  organizationDataBoxesOptions,
} from "@/routes/_protected.admin/-queries/organization-data-boxes";

/**
 * The organization's own data boxes. A filed data-box message sent from one
 * is outgoing, one sent to one incoming; each change re-derives the direction
 * of messages already filed, so correspondence queries are refreshed too.
 */
export const OrganizationDataBoxesCard = () => {
  const t = useTranslations();
  const inputId = useId();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const view = useQueryView(
    useQuery(
      organizationDataBoxesOptions({ organizationId: activeOrganizationId }),
    ),
  );
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const refreshCorrespondence = () =>
    detached(
      queryClient.invalidateQueries({ queryKey: allCorrespondenceQueryRoot() }),
      "data-boxes.refresh-correspondence",
    );
  const add = useSettingsMutation({
    mutationFn: async (boxId: string) =>
      unwrapEden(
        await api["organization-settings"].correspondence["data-boxes"].post({
          boxId,
        }),
      ),
    invalidate: organizationDataBoxesKeys.all,
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: () => {
      setDraft("");
      refreshCorrespondence();
    },
  });
  const remove = useSettingsMutation({
    mutationFn: async (boxId: string) =>
      unwrapEden(
        await api["organization-settings"].correspondence["data-boxes"]({
          boxId,
        }).delete(),
      ),
    invalidate: organizationDataBoxesKeys.all,
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: refreshCorrespondence,
  });

  if (view.type !== "items") {
    return <QueryViewFeedback view={view} />;
  }
  const { boxIds } = view.items;
  const pending = add.isPending || remove.isPending;

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <QueryViewFeedback view={view} />
          <p className="text-muted-foreground text-sm">
            {t("settings.organization.dataBoxes.description")}
          </p>
          {boxIds.length > 0 && (
            <ul className="divide-y">
              {boxIds.map((boxId) => (
                <li
                  className="flex min-h-11 items-center justify-between gap-2"
                  key={boxId}
                >
                  <bdi className="font-mono text-sm" dir="ltr">
                    {boxId}
                  </bdi>
                  {canEdit && (
                    <Button
                      aria-label={t("settings.organization.dataBoxes.remove", {
                        boxId,
                      })}
                      className="min-h-11"
                      disabled={pending}
                      onClick={() => remove.mutate(boxId)}
                      size="sm"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const boxId = draft.trim().toLowerCase();
                const valid = DATA_BOX_ID_PATTERN.test(boxId);
                setInvalid(!valid);
                if (valid) {
                  add.mutate(boxId);
                }
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor={inputId}>
                  {t("contacts.communication.dataBoxPlaceholder")}
                </Label>
                <Input
                  aria-invalid={invalid}
                  className="w-32 font-mono"
                  dir="ltr"
                  id={inputId}
                  maxLength={DATA_BOX_ID_LENGTH}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setInvalid(false);
                  }}
                  value={draft}
                />
              </div>
              <Button className="min-h-11" disabled={pending} type="submit">
                {t("common.add")}
              </Button>
            </form>
          )}
          {invalid && (
            <p className="text-destructive text-xs">
              {t("settings.organization.dataBoxes.invalid")}
            </p>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
