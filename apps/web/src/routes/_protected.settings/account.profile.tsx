import { type PropsWithChildren, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  DestructiveActionConfirmation,
  useDestructiveActionConfirmation,
} from "@stll/ui/components/destructive-action-confirmation";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogPopup,
} from "@stll/ui/components/dialog";
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
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { toAPIError, toAuthClientError } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import type { CommonTimezone } from "@/lib/timezones";
import { sessionOptions } from "@/routes/-queries";
import { SessionsCard } from "@/routes/_protected.settings/-components/account/sessions-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/profile")({
  component: ProfilePage,
  pendingComponent: ProfilePagePending,
});

const SESSION_ROW_KEYS = ["a", "b", "c"];
const PREFERENCE_ROW_KEYS = ["language", "calendar", "weekStart", "numbers"];

// Mirrors the real profile fragment: settings header, the timezone +
// word-edit-identity Frame, and the sessions section, so the layout does
// not jump when the session query resolves.
function ProfilePagePending() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>
      <Frame>
        <FrameHeader>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-1.5 h-4 w-64 max-w-full" />
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-9 w-72 max-w-full rounded-md" />
          </div>
          <div className="border-border flex flex-col gap-4 border-t p-4">
            <div className="flex max-w-lg flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-72 max-w-full" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            <div className="flex max-w-xs flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
        </FramePanel>
      </Frame>

      <Frame>
        <div className="divide-border divide-y">
          {PREFERENCE_ROW_KEYS.map((key) => (
            <div
              className="flex items-center justify-between gap-4 p-3"
              key={key}
            >
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-56 rounded-md" />
            </div>
          ))}
        </div>
      </Frame>

      <section className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Frame>
          <div className="flex flex-col gap-3 p-4">
            {SESSION_ROW_KEYS.map((key) => (
              <div
                className="flex items-center justify-between gap-4"
                key={key}
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </Frame>
      </section>
    </>
  );
}

function isCommonTimezone(tz: string): tz is CommonTimezone {
  const timezones: readonly string[] = COMMON_TIMEZONES;
  return timezones.includes(tz);
}

function ProfilePage() {
  const { data: session } = useSuspenseQuery(sessionOptions);
  const user = session?.user;

  return (
    <ProfilePageBody
      key={[
        user?.id ?? "anonymous",
        user?.preferredName ?? "",
        user?.wordEditShortcut ?? "",
      ].join(":")}
    />
  );
}

function ProfilePageBody() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data: session } = useSuspenseQuery(sessionOptions);
  const deleteAccountConfirmation = useDestructiveActionConfirmation(
    t("settings.account.deleteAccountConfirmationPhrase"),
  );
  const storedTz = session?.user.timezoneId ?? "UTC";
  const currentTz = isCommonTimezone(storedTz) ? storedTz : "UTC";
  const [preferredName, setPreferredName] = useState(
    () => session?.user.preferredName ?? "",
  );
  const [wordEditShortcut, setWordEditShortcut] = useState(
    () => session?.user.wordEditShortcut ?? "",
  );

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [step, setStep] = useState<"loading" | "tasks" | "confirm" | "otp">(
    "loading",
  );
  const [reassignments, setReassignments] = useState<Record<string, string>>(
    {},
  );

  const { data: pendingTasksData } = useQuery({
    queryKey: ["me", "delete", "pending-tasks"],
    queryFn: async () => {
      const res = await api.me.delete["pending-tasks"].get();
      if (res.error) {
        throw toAPIError(res.error);
      }
      return res.data;
    },
    enabled: isDeleteDialogOpen,
  });

  const sendOtpMutation = useMutation({
    mutationFn: async () => {
      setOtpError(null);
      const res = await api.me.delete["send-otp"].post();
      if (res.error) {
        throw toAPIError(res.error);
      }
      return res.data;
    },
    onSuccess: () => {
      setStep("otp");
      stellaToast.add({
        title: t("settings.account.otpSentSuccess"),
        type: "success",
      });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : t("errors.actionFailed");
      setOtpError(msg);
    },
  });

  const verifyDeleteMutation = useMutation({
    mutationFn: async (payload: {
      code: string;
      reassignments?: {
        entityId: SafeId<"entity">;
        reassignedUserId: string;
      }[];
    }) => {
      setOtpError(null);
      const res = await api.me.delete.verify.post(payload);
      if (res.error) {
        throw toAPIError(res.error);
      }
      return res.data;
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("settings.account.deleteAccountSuccess"),
        type: "success",
      });
      try {
        await authClient.signOut();
      } catch {
        // Session might already be invalidated on the server
      }
      window.location.href = "/auth";
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : t("errors.actionFailed");
      setOtpError(msg);
    },
  });

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

  const pendingTasks = pendingTasksData?.tasks ?? [];
  const pendingMembers = pendingTasksData?.members ?? [];
  const allPendingTasksHaveReassignments = pendingTasks.every((task) => {
    const reassignedUserId = reassignments[task.entityId];
    if (!reassignedUserId) {
      return false;
    }

    return pendingMembers.some(
      (member) =>
        member.workspaceId === task.workspaceId &&
        member.userId === reassignedUserId,
    );
  });
  let dialogStep = step;
  if (step === "loading" && pendingTasksData) {
    dialogStep = pendingTasks.length > 0 ? "tasks" : "confirm";
  }
  const dialogTitle =
    dialogStep === "tasks"
      ? t("settings.account.deleteAccountTasksTitle")
      : t("settings.account.deleteAccount");
  let dialogDescription = t("settings.account.deleteAccountConfirmDescription");
  if (dialogStep === "otp") {
    dialogDescription = t("settings.account.deleteAccountOtpDescription");
  }
  if (dialogStep === "tasks") {
    dialogDescription = "";
  }

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
                if (!tz || tz === storedTz) {
                  return;
                }

                updateTimezone.mutate(tz);
              }}
              value={currentTz}
            >
              <SelectTrigger className="w-72" id="timezone-select">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {COMMON_TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/gu, " ")}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <form
            action={async () => {
              await updateWordEditIdentity.mutateAsync().catch(() => {
                // The error toast is surfaced via the mutation's
                // `onError`; swallow here so the action settles.
              });
            }}
            className="border-border flex flex-col gap-4 border-t p-4"
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
                dir="ltr"
                id="word-edit-shortcut-input"
                maxLength={16}
                placeholder={t("settings.account.wordEditShortcutPlaceholder")}
                value={wordEditShortcut}
                onChange={(event) => setWordEditShortcut(event.target.value)}
              />
            </div>
            <ProfileSubmitButton label={t("common.save")} />
          </form>
        </FramePanel>
      </Frame>

      <LocalePreferences />

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("common.sessions")}
        </h2>
        <SessionsCard />
      </section>

      <Frame className="border-destructive/32">
        <FrameHeader>
          <FrameTitle className="text-destructive-foreground">
            {t("settings.account.dangerZone")}
          </FrameTitle>
          <FrameDescription>
            {t("settings.account.dangerZoneDescription")}
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col gap-4 p-4">
            <p className="text-muted-foreground text-sm">
              {t("settings.account.deleteAccountWarning")}
            </p>
            <div>
              <Button
                variant="destructive"
                onClick={() => setIsDeleteDialogOpen(true)}
              >
                {t("settings.account.deleteAccount")}
              </Button>
            </div>
          </div>
        </FramePanel>
      </Frame>

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsDeleteDialogOpen(false);
            setOtpCode("");
            setOtpError(null);
            setReassignments({});
            setStep("loading");
            deleteAccountConfirmation.reset();
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4 py-2">
              {otpError && (
                <div className="border-destructive/20 bg-destructive/10 text-destructive-foreground rounded-lg border p-3 text-sm">
                  {otpError}
                </div>
              )}
              {dialogStep === "loading" && (
                <div className="flex justify-center py-4">
                  <span className="border-primary h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" />
                </div>
              )}
              {dialogStep === "tasks" && (
                <div className="flex flex-col gap-4">
                  <p className="text-muted-foreground text-sm">
                    {t("settings.account.deleteAccountTasksDescription")}
                  </p>
                  <div className="flex max-h-[280px] flex-col gap-3 overflow-y-auto pe-1">
                    {pendingTasks.map((task) => {
                      const candidates = pendingMembers.filter(
                        (m) => m.workspaceId === task.workspaceId,
                      );
                      return (
                        <div
                          key={task.assigneeId}
                          className="border-border bg-muted/20 flex flex-col gap-1 rounded-lg border p-3"
                        >
                          <div className="text-muted-foreground flex justify-between text-xs">
                            <span dir="auto">{task.workspaceName}</span>
                            <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px] capitalize">
                              {task.role}
                            </span>
                          </div>
                          <span className="text-sm font-medium">
                            {task.taskName}
                          </span>
                          <div className="mt-2">
                            {candidates.length > 0 ? (
                              <Select
                                value={reassignments[task.entityId] || ""}
                                onValueChange={(val) => {
                                  setReassignments((prev) => ({
                                    ...prev,
                                    [task.entityId]: val || "",
                                  }));
                                }}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue
                                    placeholder={t(
                                      "settings.account.deleteAccountTaskReassignPlaceholder",
                                    )}
                                  />
                                </SelectTrigger>
                                <SelectPopup>
                                  {candidates.map((candidate) => (
                                    <SelectItem
                                      key={candidate.userId}
                                      value={candidate.userId}
                                    >
                                      {candidate.userName}
                                    </SelectItem>
                                  ))}
                                </SelectPopup>
                              </Select>
                            ) : (
                              <p className="text-muted-foreground text-xs italic">
                                {t(
                                  "settings.account.deleteAccountTaskReassignNone",
                                )}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {dialogStep === "confirm" && (
                <div className="flex flex-col gap-4">
                  <p className="text-muted-foreground text-sm">
                    {t("settings.account.deleteAccountWarningExplanation")}
                  </p>
                  <DestructiveActionConfirmation
                    confirmation={t(
                      "settings.account.deleteAccountConfirmationPhrase",
                    )}
                    label={t("settings.account.deleteAccountConfirmationLabel")}
                    onValueChange={deleteAccountConfirmation.onValueChange}
                    placeholder={t(
                      "settings.account.deleteAccountConfirmationPhrase",
                    )}
                    value={deleteAccountConfirmation.value}
                  />
                </div>
              )}
              {dialogStep === "tasks" && (
                <DestructiveActionConfirmation
                  confirmation={t(
                    "settings.account.deleteAccountConfirmationPhrase",
                  )}
                  label={t("settings.account.deleteAccountConfirmationLabel")}
                  onValueChange={deleteAccountConfirmation.onValueChange}
                  placeholder={t(
                    "settings.account.deleteAccountConfirmationPhrase",
                  )}
                  value={deleteAccountConfirmation.value}
                />
              )}
              {dialogStep === "otp" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="otp-input">
                    {t("settings.account.enterOtp")}
                  </Label>
                  <Input
                    dir="ltr"
                    id="otp-input"
                    placeholder="123456"
                    maxLength={6}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={otpCode}
                    onChange={(e) =>
                      setOtpCode(e.target.value.replace(/\D/gu, ""))
                    }
                    className="max-w-[200px] text-center text-lg tracking-widest"
                  />
                </div>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setIsDeleteDialogOpen(false);
                setOtpCode("");
                setOtpError(null);
                setReassignments({});
                setStep("loading");
                deleteAccountConfirmation.reset();
              }}
              disabled={
                sendOtpMutation.isPending || verifyDeleteMutation.isPending
              }
            >
              {t("common.cancel")}
            </Button>
            {dialogStep === "otp" ? (
              <Button
                variant="destructive"
                onClick={() =>
                  verifyDeleteMutation.mutate({
                    code: otpCode,
                    reassignments: Object.entries(reassignments)
                      .filter(([_, val]) => !!val)
                      .map(([entityId, reassignedUserId]) => ({
                        entityId: toSafeId<"entity">(entityId),
                        reassignedUserId,
                      })),
                  })
                }
                disabled={
                  otpCode.length !== 6 || verifyDeleteMutation.isPending
                }
                loading={verifyDeleteMutation.isPending}
              >
                {t("settings.account.confirmDelete")}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => sendOtpMutation.mutate()}
                disabled={
                  sendOtpMutation.isPending ||
                  dialogStep === "loading" ||
                  !deleteAccountConfirmation.confirmed ||
                  (dialogStep === "tasks" && !allPendingTasksHaveReassignments)
                }
                loading={sendOtpMutation.isPending}
              >
                {t("settings.account.sendOtpCode")}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const PreferenceRow = ({
  children,
  htmlFor,
  label,
}: PropsWithChildren<{ htmlFor: string; label: string }>) => (
  <div className="flex items-center justify-between gap-4 p-3">
    <Label className="text-sm font-medium" htmlFor={htmlFor}>
      {label}
    </Label>
    {children}
  </div>
);

const LocalePreferences = () => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const calendar = useI18nStore((s) => s.calendar);
  const setCalendar = useI18nStore((s) => s.setCalendar);
  const weekStart = useI18nStore((s) => s.weekStart);
  const setWeekStart = useI18nStore((s) => s.setWeekStart);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const setNumberingSystem = useI18nStore((s) => s.setNumberingSystem);

  // The calendar select collapses "auto" to its resolved value because it has
  // no Auto option; the numbering select binds to the raw store value so its
  // own Auto option can round-trip.
  const activeCalendar = calendar === "auto" ? "gregory" : calendar;

  return (
    <Frame>
      <div className="divide-border divide-y">
        <PreferenceRow htmlFor="language-select" label={t("common.language")}>
          <Select
            onValueChange={(value) => {
              if (value) {
                void setLang(value);
              }
            }}
            value={lang}
          >
            <SelectTrigger className="w-56" id="language-select">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {supportedLanguages.map((code) => (
                <SelectItem key={code} value={code}>
                  {LANG_ENDONYMS[code]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </PreferenceRow>

        <PreferenceRow
          htmlFor="calendar-select"
          label={t("appearance.calendar")}
        >
          <Select
            onValueChange={(value) => {
              if (value) {
                setCalendar(value);
              }
            }}
            value={activeCalendar}
          >
            <SelectTrigger className="w-56" id="calendar-select">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="gregory">
                {t("appearance.calendarGregorian")}
              </SelectItem>
              <SelectItem value="islamic-umalqura">
                {t("appearance.calendarHijri")}
              </SelectItem>
            </SelectPopup>
          </Select>
        </PreferenceRow>

        <PreferenceRow
          htmlFor="week-start-select"
          label={t("appearance.weekStart")}
        >
          <Select
            onValueChange={(value) => {
              if (value) {
                setWeekStart(value);
              }
            }}
            value={weekStart}
          >
            <SelectTrigger className="w-56" id="week-start-select">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">
                {t("appearance.weekStartAuto")}
              </SelectItem>
              <SelectItem value="saturday">
                {t("appearance.weekStartSaturday")}
              </SelectItem>
              <SelectItem value="sunday">
                {t("appearance.weekStartSunday")}
              </SelectItem>
              <SelectItem value="monday">
                {t("appearance.weekStartMonday")}
              </SelectItem>
            </SelectPopup>
          </Select>
        </PreferenceRow>

        <PreferenceRow htmlFor="numbers-select" label={t("appearance.numbers")}>
          <Select
            onValueChange={(value) => {
              if (value) {
                setNumberingSystem(value);
              }
            }}
            value={numberingSystem}
          >
            <SelectTrigger className="w-56" id="numbers-select">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">
                {t("appearance.numbersAuto")}
              </SelectItem>
              <SelectItem value="latn">
                {t("appearance.numbersWestern")}
              </SelectItem>
              <SelectItem value="arab">
                {t("appearance.numbersEastern")}
              </SelectItem>
            </SelectPopup>
          </Select>
        </PreferenceRow>
      </div>
    </Frame>
  );
};

const ProfileSubmitButton = ({ label }: { label: string }) => {
  const { pending } = useFormStatus();
  return (
    <Button className="w-fit" disabled={pending} type="submit">
      {label}
    </Button>
  );
};
