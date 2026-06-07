import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

/** Modal shown when the current organisation cannot run more AI work. */

export type UsageLimitExceededReason =
  | "no_entitlement"
  | "usage_limit_exceeded"
  | "entitlement_inactive";

export type UsageLimitModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  required: number;
  available: number;
  reason: UsageLimitExceededReason;
  /**
   * Whether the org has a hosted entitlement. Drives which CTA
   * is shown. The caller knows this from the entitlement query.
   */
  hasHostedEntitlement: boolean;
};

export const UsageLimitModal = ({
  open,
  onOpenChange,
  required,
  available,
  reason,
  hasHostedEntitlement,
}: UsageLimitModalProps) => {
  const t = useTranslations();
  const managementMutation = useMutation({
    mutationFn: async () => {
      const response = await api.usage.hosted.management.post();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      stellaToast.add({
        title: t("settings.organization.usageManageError"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(TITLE_KEYS[reason])}</DialogTitle>
          <DialogDescription>{t(DESCRIPTION_KEYS[reason])}</DialogDescription>
        </DialogHeader>

        <div className="bg-muted/40 rounded-md p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t("settings.organization.usageLimitNeeded")}
            </span>
            <span className="font-medium">
              {t("settings.organization.usageUnitCount", { count: required })}
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-muted-foreground">
              {t("settings.organization.usageLimitAvailable")}
            </span>
            <span className="font-medium">
              {t("settings.organization.usageUnitCount", { count: available })}
            </span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("settings.organization.usageLimitNotNow")}
          </DialogClose>
          {hasHostedEntitlement ? (
            <Button
              disabled={managementMutation.isPending}
              onClick={() => managementMutation.mutate()}
            >
              {t("settings.organization.usageManage")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const TITLE_KEYS = {
  entitlement_inactive:
    "settings.organization.usageLimitTitleEntitlementInactive",
  no_entitlement: "settings.organization.usageLimitTitleNoEntitlement",
  usage_limit_exceeded:
    "settings.organization.usageLimitTitleUsageLimitExceeded",
} as const satisfies Record<UsageLimitExceededReason, TranslationKey>;

const DESCRIPTION_KEYS = {
  entitlement_inactive:
    "settings.organization.usageLimitDescriptionEntitlementInactive",
  no_entitlement: "settings.organization.usageLimitDescriptionNoEntitlement",
  usage_limit_exceeded:
    "settings.organization.usageLimitDescriptionUsageLimitExceeded",
} as const satisfies Record<UsageLimitExceededReason, TranslationKey>;
