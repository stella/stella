import { useId, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  DATA_BOX_ID_LENGTH,
  STORED_DATA_BOX_ID_PATTERN,
} from "@stll/api-contract/data-box";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { PlusIcon, Trash2Icon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { queryView } from "@/lib/query-view.logic";
import { allCorrespondenceQueryRoot } from "@/lib/resource-query-roots.logic";
import {
  OrganizationDataBoxesCardFrame,
  OrganizationDataBoxesCardPending,
} from "@/routes/_protected.settings/organization/-components/organization/data-boxes-card.pending";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";
import {
  organizationDataBoxesKeys,
  organizationDataBoxesOptions,
} from "@/routes/_protected.settings/organization/-queries/organization-data-boxes";

/**
 * The organization's own data boxes. A filed data-box message sent from one
 * is outgoing, one sent to one incoming; each change re-derives the direction
 * of messages already filed, so correspondence queries are refreshed too.
 */
export const OrganizationDataBoxesCard = () => {
  const t = useTranslations();
  const errorId = useId();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const view = queryView(
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
    exceptionScope: {
      type: "handler",
      handlerId: "OrganizationDataBoxesCard.add",
    },
    mutationFn: async (boxId: string) =>
      invokeCapability(
        "organization-settings.correspondence.data-boxes.create",
        async (request) =>
          unwrapApiResponse(
            await api["organization-settings"].correspondence[
              "data-boxes"
            ].post({ boxId }, request),
          ),
      ),
    invalidate: organizationDataBoxesKeys.all,
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: () => {
      setDraft("");
      refreshCorrespondence();
    },
  });
  const remove = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "OrganizationDataBoxesCard.remove",
    },
    mutationFn: async (boxId: string) =>
      invokeCapability(
        "organization-settings.correspondence.data-boxes.delete",
        async (request) =>
          unwrapApiResponse(
            await api["organization-settings"].correspondence["data-boxes"]({
              boxId,
            }).delete(undefined, request),
          ),
      ),
    invalidate: organizationDataBoxesKeys.all,
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: refreshCorrespondence,
  });

  if (view.type === "pending") {
    return <OrganizationDataBoxesCardPending />;
  }
  if (view.type !== "items") {
    return <QueryViewFeedback view={view} />;
  }
  const { boxIds } = view.items;
  const pending = add.isPending || remove.isPending;

  return (
    <OrganizationDataBoxesCardFrame
      feedback={<QueryViewFeedback view={view} />}
    >
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
                    address: boxId,
                  })}
                  className="min-h-11"
                  disabled={pending}
                  disabledReason={t("common.saving")}
                  onClick={() => remove.mutate(boxId)}
                  size="sm"
                  tooltip={t("settings.organization.dataBoxes.remove", {
                    address: boxId,
                  })}
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
        <Form
          density="compact"
          layout="inline"
          onSubmit={(event) => {
            event.preventDefault();
            const boxId = draft.trim().toLowerCase();
            const valid = STORED_DATA_BOX_ID_PATTERN.test(boxId);
            setInvalid(!valid);
            if (valid) {
              add.mutate(boxId);
            }
          }}
        >
          <Input
            aria-describedby={invalid ? errorId : undefined}
            aria-invalid={invalid}
            aria-label={t("contacts.communication.dataBoxPlaceholder")}
            className="max-w-48 font-mono"
            dir="ltr"
            maxLength={DATA_BOX_ID_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            placeholder={t("contacts.communication.dataBoxPlaceholder")}
            value={draft}
          />
          <Button
            disabled={pending}
            disabledReason={t("common.saving")}
            type="submit"
          >
            <PlusIcon />
            {t("common.add")}
          </Button>
        </Form>
      )}
      {invalid && (
        <p className="text-destructive text-xs" id={errorId}>
          {t("settings.organization.dataBoxes.invalid")}
        </p>
      )}
    </OrganizationDataBoxesCardFrame>
  );
};
