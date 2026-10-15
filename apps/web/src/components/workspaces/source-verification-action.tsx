import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon } from "@stll/ui/icons";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { toSafeId } from "@/lib/safe-id";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

export const SourceVerificationAction = ({
  workspaceId,
  listId,
  itemEntityId,
  sourceId,
  verified,
}: SourceVerificationActionProps) => {
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.verification);
  const t = useTranslations();
  const queryClient = useQueryClient();

  const verifySource = async () => {
    if (!enabled) {
      return;
    }
    const listApi = api.lists({
      workspaceId: toSafeId<"workspace">(workspaceId),
    });
    const response = await listApi["item-sources"].patch({
      id: toSafeId<"legalListItemSource">(sourceId),
      listId: toSafeId<"legalList">(listId),
      itemEntityId: toSafeId<"entity">(itemEntityId),
      status: "verified",
    });
    if (response.error) {
      notifyUserError(toAPIError(response.error), t("errors.actionFailed"));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: legalListKeys.sources(workspaceId, listId, itemEntityId),
      }),
      queryClient.invalidateQueries({
        queryKey: legalListKeys.activity(workspaceId, listId, itemEntityId),
      }),
    ]);
  };

  if (!enabled) {
    return null;
  }
  return (
    <Button
      aria-label={t("common.accept")}
      disabled={verified}
      onClick={() => detached(verifySource(), "lists.verify-source")}
      size="icon-sm"
      variant="ghost"
    >
      <CheckIcon />
    </Button>
  );
};

type SourceVerificationActionProps = {
  workspaceId: string;
  listId: string;
  itemEntityId: string;
  sourceId: string;
  verified: boolean;
};
