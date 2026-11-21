import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQueries,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { ListEmpty } from "@stll/ui/list";
import { SettingsPanel, SettingsRow } from "@stll/ui/settings";
import { stellaToast } from "@stll/ui/toast";
import { parseUserAgent } from "@stll/user-agent";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import Tooltip from "@/components/tooltip";
import { sessionsKeys, sessionsOptions } from "@/lib/account/queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, revokeAuthSession } from "@/lib/auth-client";
import { sessionOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import {
  SessionsCardFrame,
  SessionsCardPending,
} from "@/routes/_protected.settings/-components/account/sessions-card.pending";

const MISSING_VALUE = "-";

// Contain this card's data dependency behind its own boundary. It suspends on
// `list-sessions`, a secondary read that is independent of the rest of the
// account page; without this, any failure of that one query (an auth error, a
// rate-limit hit, a network blip) would propagate to the route's error boundary
// and blank the entire profile page instead of just this card.
export const SessionsCard = () => (
  <QuerySuspenseBoundary
    area="account-sessions"
    errorFallback={({ reset }) => <SessionsCardError onRetry={reset} />}
    suspenseFallback={<SessionsCardPending />}
  >
    <SessionsCardContent />
  </QuerySuspenseBoundary>
);

const SessionsCardError = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations();
  return (
    <SessionsCardFrame>
      <SettingsPanel>
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">
            {t("common.somethingWentWrong")}
          </p>
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("common.retry")}
          </Button>
        </div>
      </SettingsPanel>
    </SessionsCardFrame>
  );
};

const SessionsCardContent = () => {
  const t = useTranslations();
  const { id: userId } = useAuthenticatedUser();
  const [{ data: sessions }, { data: currentSession }] = useSuspenseQueries({
    queries: [sessionsOptions(userId), sessionOptions],
  });

  const currentSessionId = currentSession?.session.id;
  const hasOtherSessions = sessions.some((s) => s.id !== currentSessionId);

  return (
    <SessionsCardFrame
      action={hasOtherSessions ? <RevokeAllDialog /> : undefined}
    >
      {sessions.map((session) => {
        const isCurrent = session.id === currentSessionId;
        const ua = parseUserAgent(session.userAgent);
        const deviceLabel =
          ua.browser && ua.os
            ? t("account.sessions.deviceOnOs", {
                browser: ua.browser,
                os: ua.os,
              })
            : (ua.browser ?? ua.os ?? t("account.sessions.unknownDevice"));

        return (
          <SettingsRow
            description={
              <>
                {session.originClientName && (
                  <span className="block">
                    {t("account.sessions.signedInFrom", {
                      clientName: session.originClientName,
                    })}
                  </span>
                )}
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  <bdi>{session.ipAddress || MISSING_VALUE}</bdi>
                  <span aria-hidden="true">·</span>
                  {isCurrent ? (
                    t("account.sessions.activeNow")
                  ) : (
                    <Tooltip
                      content={formatFullTimestamp(session.updatedAt)}
                      render={<Button variant="plain" />}
                    >
                      <span className="text-xs">
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </Tooltip>
                  )}
                </span>
              </>
            }
            key={session.id}
            title={deviceLabel}
          >
            {isCurrent ? (
              <span className="bg-muted inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium">
                {t("account.sessions.currentSession")}
              </span>
            ) : (
              <RevokeSessionButton sessionId={session.id} />
            )}
          </SettingsRow>
        );
      })}
      {!hasOtherSessions && (
        <ListEmpty>{t("account.sessions.noOtherSessions")}</ListEmpty>
      )}
    </SessionsCardFrame>
  );
};

type RevokeSessionButtonProps = {
  sessionId: string;
};

const RevokeSessionButton = ({ sessionId }: RevokeSessionButtonProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const revokeSession = useMutation({
    mutationFn: async (sessionIdToRevoke: string) => {
      const result = await revokeAuthSession({ sessionId: sessionIdToRevoke });

      if (result.error) {
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("success.sessionRevoked"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionsKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RevokeSessionButton:failure",
        scope: { type: "handler", handlerId: "RevokeSessionButton:failure" },
      });
    },
  });

  return (
    <Button
      loading={revokeSession.isPending}
      onClick={() => revokeSession.mutate(sessionId)}
      size="xs"
      variant="ghost"
    >
      {t("common.signOut")}
    </Button>
  );
};

const RevokeAllDialog = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const [isOpen, setIsOpen] = useState(false);

  const revokeOtherSessions = useMutation({
    mutationFn: async () => {
      const result = await authClient.revokeOtherSessions();

      if (result.error) {
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("success.otherSessionsRevoked"),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: sessionsKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "RevokeAllDialog:failure",
        scope: { type: "handler", handlerId: "RevokeAllDialog:failure" },
      });
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
