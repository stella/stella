import { useState } from "react";

import { usePostHog } from "@posthog/react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQueries,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stella/ui/components/dialog";
import { Frame } from "@stella/ui/components/frame";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stella/ui/components/table";
import { toastManager } from "@stella/ui/components/toast";

import { useI18nStore } from "@/i18n/i18n-store";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { parseUserAgent } from "@/lib/parse-user-agent";
import { captureError } from "@/lib/posthog/utils";
import { formatRelativeTime } from "@/lib/relative-time";
import { sessionOptions } from "@/routes/-queries";
import {
  sessionsKeys,
  sessionsOptions,
} from "@/routes/_protected.account/-queries";

export const Route = createFileRoute("/_protected/account/sessions")({
  component: Sessions,
});

const EM_DASH = "\u2014";

function Sessions() {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const [{ data: sessions }, { data: currentSession }] = useSuspenseQueries({
    queries: [sessionsOptions, sessionOptions],
  });

  const currentSessionId = currentSession?.session.id;
  const hasOtherSessions = sessions.some((s) => s.id !== currentSessionId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t("account.sessions.title")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("account.sessions.description")}
        </p>
      </div>
      {hasOtherSessions && <RevokeAllDialog />}
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("account.sessions.device")}</TableHead>
              <TableHead>{t("account.sessions.ipAddress")}</TableHead>
              <TableHead>{t("account.sessions.lastActive")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => {
              const isCurrent = session.id === currentSessionId;
              const ua = parseUserAgent(session.userAgent);
              const deviceLabel =
                ua.browser && ua.os
                  ? t("account.sessions.deviceOnOs", {
                      browser: ua.browser,
                      os: ua.os,
                    })
                  : (ua.browser ??
                    ua.os ??
                    t("account.sessions.unknownDevice"));

              return (
                <TableRow key={session.id}>
                  <TableCell>{deviceLabel}</TableCell>
                  <TableCell>{session.ipAddress || EM_DASH}</TableCell>
                  <TableCell>
                    {formatRelativeTime(session.updatedAt, lang)}
                  </TableCell>
                  <TableCell className="text-end">
                    {isCurrent ? (
                      <span className="bg-muted inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium">
                        {t("account.sessions.currentSession")}
                      </span>
                    ) : (
                      <RevokeSessionButton token={session.token} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!hasOtherSessions && (
              <TableRow>
                <TableCell
                  className="text-muted-foreground text-center"
                  colSpan={4}
                >
                  {t("account.sessions.noOtherSessions")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Frame>
    </div>
  );
}

type RevokeSessionButtonProps = {
  token: string;
};

const RevokeSessionButton = ({ token }: RevokeSessionButtonProps) => {
  const t = useTranslations();
  const posthog = usePostHog();
  const queryClient = useQueryClient();

  const revokeSession = useMutation({
    mutationFn: async (sessionToken: string) => {
      const result = await authClient.revokeSession({ token: sessionToken });

      if (result.error) {
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      toastManager.add({
        title: t("success.sessionRevoked"),
        type: "success",
      });
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: sessionsKeys.all,
      });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  return (
    <Button
      loading={revokeSession.isPending}
      onClick={() => revokeSession.mutate(token)}
      size="xs"
      variant="ghost"
    >
      {t("account.sessions.revokeSession")}
    </Button>
  );
};
const RevokeAllDialog = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [isOpen, setIsOpen] = useState(false);

  const revokeOtherSessions = useMutation({
    mutationFn: async () => {
      const result = await authClient.revokeOtherSessions();

      if (result.error) {
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      toastManager.add({
        title: t("success.otherSessionsRevoked"),
        type: "success",
      });
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: sessionsKeys.all,
      });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
    onSettled: () => {
      setIsOpen(false);
    },
  });

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger
        render={
          <Button
            className="max-w-max"
            disabled={revokeOtherSessions.isPending}
            size="sm"
            variant="outline"
          />
        }
      >
        {t("account.sessions.revokeOtherSessions")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("account.sessions.revokeOtherSessions")}</DialogTitle>
          <DialogDescription>
            {t("account.sessions.revokeOtherSessionsConfirm")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            loading={revokeOtherSessions.isPending}
            onClick={() => {
              revokeOtherSessions.mutate();
            }}
            variant="destructive"
          >
            {t("account.sessions.revokeOtherSessions")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
