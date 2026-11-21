import { useState } from "react";
import type { ReactNode } from "react";

import { useSuspenseQueries } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { sessionsOptions } from "@/lib/account/queries";
import { sessionSignInsOptions } from "@/lib/account/session-sign-ins";
import { isTwoFactorEnabledUser } from "@/lib/auth-client";
import { sessionOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import {
  otherDevices,
  pendingReviews,
  reviewCardState,
  type ReviewOutcome,
  signedInDevices,
} from "@/routes/_protected.settings/-account.security.logic";
import {
  SecurityPageShell,
  SecuritySummaryPending,
  SignedInDevicesPending,
} from "@/routes/_protected.settings/-account.security.pending";
import { PersonalDataExportCard } from "@/routes/_protected.settings/-components/account/personal-data-export-card";
import { SecuritySummary } from "@/routes/_protected.settings/-components/account/security/security-summary";
import { SignInReviewCard } from "@/routes/_protected.settings/-components/account/security/sign-in-review-card";
import {
  SignedInDevices,
  useSignOutDevice,
} from "@/routes/_protected.settings/-components/account/security/signed-in-devices";
import { SignInMethods } from "@/routes/_protected.settings/-components/account/sign-in-methods";
import { TwoFactorCard } from "@/routes/_protected.settings/-components/account/two-factor-card";

const securityRoute = getRouteApi("/_protected/settings/account/security");

/** The security page: its shell (`SecurityPageShell`) with live sections. */
export function SecurityPage() {
  const review = securityRoute.useSearch({ select: (search) => search.review });
  return (
    <SecurityPageShell
      dataExport={<PersonalDataExportCard />}
      devices={
        <DevicesBoundary
          area="account-security-devices"
          pending={<SignedInDevicesPending />}
        >
          <DevicesSection />
        </DevicesBoundary>
      }
      review={
        review === undefined ? undefined : (
          <DevicesBoundary area="account-security-review" pending={null}>
            {/* A new target starts undecided. */}
            <ReviewSection key={review} targetSessionId={review} />
          </DevicesBoundary>
        )
      }
      signInMethods={<SignInMethods />}
      summary={
        <DevicesBoundary
          area="account-security-summary"
          pending={<SecuritySummaryPending />}
        >
          <SummarySection />
        </DevicesBoundary>
      }
      twoFactor={<TwoFactorCard />}
    />
  );
}

/**
 * Each section that reads the devices suspends and fails on its own, so one
 * failed read leaves the sign-in methods, two-factor and export usable.
 */
const DevicesBoundary = ({
  area,
  children,
  pending,
}: {
  area: string;
  children: ReactNode;
  pending: ReactNode;
}) => (
  <QuerySuspenseBoundary
    area={area}
    errorFallback={({ reset }) => <DevicesError onRetry={reset} />}
    suspenseFallback={pending}
  >
    {children}
  </QuerySuspenseBoundary>
);

const DevicesError = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border p-4">
      <p className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </p>
      <Button onClick={onRetry} size="sm" variant="outline">
        {t("common.retry")}
      </Button>
    </div>
  );
};

/** The account holder's live devices and this page's own session. */
const useSecurityDevices = () => {
  const { id: userId } = useAuthenticatedUser();
  const [{ data: sessions }, { data: signIns }, { data: session }] =
    useSuspenseQueries({
      queries: [
        sessionsOptions(userId),
        sessionSignInsOptions(userId),
        resourceQueryOptions({ ...sessionOptions }, { type: "independent" }),
      ],
    });
  return {
    devices: signedInDevices(sessions, signIns),
    session,
  };
};

const SummarySection = () => {
  const { devices, session } = useSecurityDevices();
  return (
    <SecuritySummary
      pendingReviews={pendingReviews(devices)}
      twoFactorEnabled={isTwoFactorEnabledUser(session?.user)}
    />
  );
};

const DevicesSection = () => {
  const { devices, session } = useSecurityDevices();
  const currentSessionId = session?.session.id;
  return (
    <SignedInDevices
      current={devices.find(({ id }) => id === currentSessionId)}
      others={otherDevices(devices, currentSessionId)}
    />
  );
};

const ReviewSection = ({ targetSessionId }: { targetSessionId: string }) => {
  const navigate = securityRoute.useNavigate();
  const { devices } = useSecurityDevices();
  const [outcome, setOutcome] = useState<ReviewOutcome>({
    type: "undecided",
  });
  // The outcome is set before the lists refresh, so the card never shows
  // the signed-out device as already gone.
  const signOut = useSignOutDevice((sessionId) => {
    const device = devices.find(({ id }) => id === sessionId);
    if (device !== undefined) {
      setOutcome({ type: "signedOut", deviceName: device.name });
    }
  });
  return (
    <SignInReviewCard
      onDismiss={() =>
        detached(
          navigate({ search: {}, replace: true }),
          "security.review-dismiss",
        )
      }
      onSignOut={(device) => signOut.mutate(device.id)}
      signOutPending={signOut.isPending}
      state={reviewCardState({ targetSessionId, devices, outcome })}
    />
  );
};
