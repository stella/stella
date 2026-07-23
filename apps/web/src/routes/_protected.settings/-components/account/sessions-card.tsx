import { useState } from "react";
import type { PropsWithChildren } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQueries,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { stellaToast } from "@stll/ui/components/toast";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, revokeAuthSession } from "@/lib/auth";
import type { SessionRevocationToken } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { parseUserAgent } from "@/lib/parse-user-agent";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { sessionOptions } from "@/routes/-queries";
import {
  sessionsKeys,
  sessionsOptions,
} from "@/routes/_protected.account/-queries";

const MISSING_VALUE = "-";

// Contain this card's data dependency behind its own boundary. It suspends on
// `list-sessions`, a secondary read that is independent of the rest of the
// account page; without this, any failure of that one query (an auth error, a
// rate-limit hit, a network blip) would propagate to the route's error boundary
// and blank the entire profile page instead of just this card.
export const SessionsCard = () => (
  <QuerySuspenseBoundary
    area="account.sessions"
    errorFallback={({ reset }) => <SessionsCardError onRetry={reset} />}
    suspenseFallback={<SessionsCardSkeleton />}
  >
    <SessionsCardContent />
  </QuerySuspenseBoundary>
);

const SessionsCardFrame = ({ children }: PropsWithChildren) => {
  const t = useTranslations();
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("common.sessions")}</FrameTitle>
      </FrameHeader>
      {children}
    </Frame>
  );
};

const SessionsCardSkeleton = () => (
  <SessionsCardFrame>
    <FramePanel className="flex flex-col gap-3 p-4">
      {["a", "b", "c"].map((key) => (
        <div className="flex items-center justify-between gap-4" key={key}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
      ))}
    </FramePanel>
  </SessionsCardFrame>
);

const SessionsCardError = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations();
  return (
    <SessionsCardFrame>
      <FramePanel className="flex flex-col items-start gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.retry")}
        </Button>
      </FramePanel>
    </SessionsCardFrame>
  );
};

const SessionsCardContent = () => {
  const t = useTranslations();
  const [{ data: sessions }, { data: currentSession }] = useSuspenseQueries({
    queries: [sessionsOptions, sessionOptions],
  });

  const currentSessionId = currentSession?.session.id;
  const hasOtherSessions = sessions.some((s) => s.id !== currentSessionId);

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("common.sessions")}</FrameTitle>
      </FrameHeader>
      {/* `p-0`: FramePanel pads by 5 for prose-style panels, which would inset
          the table. The rows carry their own cell padding, so the panel only
          needs to supply the card surface. */}
      <FramePanel className="p-0">
        {hasOtherSessions && (
          <div className="flex justify-end p-4 pb-0">
            <RevokeAllDialog />
          </div>
        )}
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
                  <TableCell>{session.ipAddress || MISSING_VALUE}</TableCell>
                  <TableCell title={formatFullTimestamp(session.updatedAt)}>
                    {formatRelativeTime(session.updatedAt)}
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
      </FramePanel>
    </Frame>
  );
};

type RevokeSessionButtonProps = {
  token: SessionRevocationToken;
};

const RevokeSessionButton = ({ token }: RevokeSessionButtonProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const revokeSession = useMutation({
    mutationFn: async (sessionToken: SessionRevocationToken) => {
      const result = await revokeAuthSession({ token: sessionToken });

      if (result.error) {
        stellaToast.add({
          title: userErrorFromThrown(
            toAuthClientError(result.error),
            t("errors.actionFailed"),
          ),
          type: "error",
        });
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
      analytics.captureError(error);
    },
  });

  return (
    <Button
      loading={revokeSession.isPending}
      onClick={() => revokeSession.mutate(token)}
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
        stellaToast.add({
          title: userErrorFromThrown(
            toAuthClientError(result.error),
            t("errors.actionFailed"),
          ),
          type: "error",
        });
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
      analytics.captureError(error);
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
