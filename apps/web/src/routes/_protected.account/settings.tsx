import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { toastManager } from "@stll/ui/components/toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import type { CommonTimezone } from "@/lib/timezones";
import { sessionOptions } from "@/routes/-queries";
import { DesktopDownloadSection } from "@/routes/_protected.account/-desktop-download-section";
import { SessionsSection } from "@/routes/_protected.account/-sessions-section";

export const Route = createFileRoute("/_protected/account/settings")({
  component: Settings,
});

function isCommonTimezone(tz: string): tz is CommonTimezone {
  const timezones: readonly string[] = COMMON_TIMEZONES;
  return timezones.includes(tz);
}

function Settings() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data: session } = useSuspenseQuery(sessionOptions);
  const storedTz = session?.user.timezoneId ?? "UTC";
  const currentTz = isCommonTimezone(storedTz) ? storedTz : "UTC";

  const updateTimezone = useMutation({
    mutationFn: async (timezoneId: string) => {
      const { error } = await authClient.updateUser({ timezoneId });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      toastManager.add({
        title: t("account.settings.timezoneSaved"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
    },
    onError: () => {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <Frame>
        <FrameHeader>
          <FrameTitle>{t("common.settings")}</FrameTitle>
          <FrameDescription>
            {t("account.settings.description")}
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col gap-2 p-4">
            <Label htmlFor="timezone-select">
              {t("account.settings.timezone")}
            </Label>
            <p className="text-muted-foreground text-sm">
              {t("account.settings.timezoneDescription")}
            </p>
            <Select
              disabled={updateTimezone.isPending}
              value={currentTz}
              onValueChange={(tz) => {
                if (tz) {
                  updateTimezone.mutate(tz);
                }
              }}
            >
              <SelectTrigger className="w-72" id="timezone-select">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {COMMON_TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </FramePanel>
      </Frame>
      <DesktopDownloadSection />
      <SessionsSection />
    </div>
  );
}
