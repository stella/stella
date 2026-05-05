import { useEffect, useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
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
import { SessionsCard } from "@/routes/_protected.settings/-components/account/sessions-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/profile")({
  component: ProfilePage,
});

function isCommonTimezone(tz: string): tz is CommonTimezone {
  const timezones: readonly string[] = COMMON_TIMEZONES;
  return timezones.includes(tz);
}

function ProfilePage() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data: session } = useSuspenseQuery(sessionOptions);
  const storedTz = session?.user.timezoneId ?? "UTC";
  const currentTz = isCommonTimezone(storedTz) ? storedTz : "UTC";
  const [preferredName, setPreferredName] = useState(
    () => session?.user.preferredName ?? "",
  );
  const [wordEditShortcut, setWordEditShortcut] = useState(
    () => session?.user.wordEditShortcut ?? "",
  );

  useEffect(() => {
    setPreferredName(session?.user.preferredName ?? "");
    setWordEditShortcut(session?.user.wordEditShortcut ?? "");
  }, [session?.user.preferredName, session?.user.wordEditShortcut]);

  const updateTimezone = useMutation({
    mutationFn: async (timezoneId: string) => {
      const { error } = await authClient.updateUser({ timezoneId });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("settings.account.timezoneSaved"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
    },
    onError: () => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const updateWordEditIdentity = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({
        preferredName: preferredName.trim(),
        wordEditShortcut: wordEditShortcut.trim(),
      });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("settings.account.wordEditIdentitySaved"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
    },
    onError: () => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  return (
    <>
      <SettingsPageHeader
        description={t("settings.account.profileDescription")}
        title={t("settings.account.profile")}
      />
      <Frame>
        <FrameHeader>
          <FrameTitle>{t("settings.account.timezone")}</FrameTitle>
          <FrameDescription>
            {t("settings.account.timezoneDescription")}
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col gap-2 p-4">
            <Label className="sr-only" htmlFor="timezone-select">
              {t("settings.account.timezone")}
            </Label>
            <Select
              disabled={updateTimezone.isPending}
              onValueChange={(tz) => {
                if (tz) {
                  updateTimezone.mutate(tz);
                }
              }}
              value={currentTz}
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
          <form
            className="border-border flex flex-col gap-4 border-t p-4"
            onSubmit={(event) => {
              event.preventDefault();
              updateWordEditIdentity.mutate();
            }}
          >
            <div className="flex max-w-lg flex-col gap-2">
              <Label htmlFor="preferred-name-input">
                {t("settings.account.preferredName")}
              </Label>
              <p className="text-muted-foreground text-sm">
                {t("settings.account.preferredNameDescription")}
              </p>
              <Input
                id="preferred-name-input"
                maxLength={120}
                placeholder={t("settings.account.preferredNamePlaceholder")}
                value={preferredName}
                onChange={(event) => setPreferredName(event.target.value)}
              />
            </div>
            <div className="flex max-w-xs flex-col gap-2">
              <Label htmlFor="word-edit-shortcut-input">
                {t("settings.account.wordEditShortcut")}
              </Label>
              <p className="text-muted-foreground text-sm">
                {t("settings.account.wordEditShortcutDescription")}
              </p>
              <Input
                id="word-edit-shortcut-input"
                maxLength={16}
                placeholder={t("settings.account.wordEditShortcutPlaceholder")}
                value={wordEditShortcut}
                onChange={(event) => setWordEditShortcut(event.target.value)}
              />
            </div>
            <Button
              className="w-fit"
              disabled={updateWordEditIdentity.isPending}
              type="submit"
            >
              {t("common.save")}
            </Button>
          </form>
        </FramePanel>
      </Frame>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.account.sessions")}
        </h2>
        <SessionsCard />
      </section>

      {/* TODO: danger zone (follow-up PR). Both surfaces are
          designed but their backends aren't built yet, so they
          ship together rather than as fake placeholders.
          - Export my data: async job (gather user data → ZIP →
            S3 → emailed download link). Needs a job runner first.
          - Delete account: OTP-verified flow (POST
            /me/delete/send-otp + POST /me/delete/verify); must
            reject sole-org-owners, revoke all sessions, call
            auth.api.deleteUser, redirect to /auth. */}
    </>
  );
}
