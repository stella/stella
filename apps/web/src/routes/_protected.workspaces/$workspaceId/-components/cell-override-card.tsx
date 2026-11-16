import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Input } from "@stll/ui/input";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { TruncatedText } from "@stll/ui/truncated-text";

import { UserIdentityAvatar } from "@/components/user-avatar";
import { FieldValue } from "@/components/workspaces/field-value";
import { api } from "@/lib/api";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import type {
  WorkspaceCellMetadata,
  WorkspaceEntity,
  WorkspaceProperty,
} from "@/lib/types";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type CellOverride = NonNullable<WorkspaceCellMetadata["override"]>;

const OVERRIDE_REASON_MAX_LENGTH = 500;

type CellOverrideCardProps = React.PropsWithChildren<{
  entity: WorkspaceEntity;
  property: WorkspaceProperty;
  metadata: WorkspaceCellMetadata;
  override: CellOverride;
}>;

/**
 * A cell whose AI value a person replaced: a small corner mark on the cell,
 * and on hover who changed it, when, why, and the value the AI produced. The
 * edit itself stays one step (type over the value); the reason is optional
 * and added here afterwards.
 */
export const CellOverrideCard = ({
  entity,
  property,
  metadata,
  override,
  children,
}: CellOverrideCardProps) => {
  const t = useTranslations();
  const machineContent = override.machine.content;

  return (
    <PreviewCard>
      <PreviewCardTrigger
        closeDelay={100}
        delay={650}
        render={<div className="relative w-full min-w-0" />}
      >
        {children}
        <span
          aria-label={t("common.edited")}
          className="bg-foreground-placeholder pointer-events-none absolute end-0.5 top-0.5 size-1.5 rounded-full"
          role="img"
        />
      </PreviewCardTrigger>
      <PreviewCardPopup align="start" className="w-80">
        <div className="flex w-full flex-col gap-2 text-start text-xs">
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
            <span className="text-foreground shrink-0 font-medium">
              {t("common.edited")}
            </span>
            <span className="shrink-0">·</span>
            <UserIdentityAvatar
              className="text-3xs size-4 shrink-0"
              image={override.editedByImage}
              name={override.editedByName}
            />
            <TruncatedText>
              {override.editedByName ? (
                <>
                  <BidiText>{override.editedByName}</BidiText>
                  {" · "}
                </>
              ) : null}
              {formatRelativeTime(override.editedAt)}
            </TruncatedText>
          </span>
          <OverrideReason
            entityId={entity.entityId}
            manualFlags={metadata.manualFlags}
            propertyId={property.id}
            reason={override.reason}
            workspaceId={property.workspaceId}
          />
          <span className="flex flex-col gap-1 border-t pt-2">
            <span className="text-muted-foreground font-medium">
              {t("workspaces.cellOverride.machineValue")}
            </span>
            {machineContent.type === "unsupported" ? (
              <span className="text-muted-foreground italic">
                {t("common.notStated")}
              </span>
            ) : (
              <FieldValue content={machineContent} property={property} />
            )}
          </span>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
};

type OverrideReasonProps = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  manualFlags: WorkspaceCellMetadata["manualFlags"];
  reason: string | null;
};

const OverrideReason = ({
  workspaceId,
  entityId,
  propertyId,
  manualFlags,
  reason,
}: OverrideReasonProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(reason ?? "");

  const saveReason = useCapabilityMutation({
    capability: "fields.cell-metadata.update",
    target: resourceRef({
      type: RESOURCE_TYPE.WORKSPACE,
      id: toSafeId<"workspace">(workspaceId),
    }),
    mutationFn: async (nextReason: string | null, request) =>
      unwrapApiResponse(
        await api
          .fields({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .metadata.patch(
            {
              entityId: toSafeId<"entity">(entityId),
              propertyId: toSafeId<"property">(propertyId),
              // Flags are untouched: the base and the request are one list.
              baseManualFlags: manualFlags,
              manualFlags,
              overrideReason: nextReason,
            },
            request,
          ),
      ),
    scope: { id: `cell-metadata:${workspaceId}:${entityId}:${propertyId}` },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        "cell-override-card.invalidate",
      );
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === reason) {
      return;
    }
    saveReason.mutate(next);
  };

  return (
    <Input
      aria-label={t("workspaces.cellOverride.reasonPlaceholder")}
      maxLength={OVERRIDE_REASON_MAX_LENGTH}
      onBlur={commit}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      placeholder={t("workspaces.cellOverride.reasonPlaceholder")}
      size="sm"
      value={draft}
    />
  );
};
