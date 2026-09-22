import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Result, TaggedError } from "better-result";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient, isTwoFactorRedirect } from "@/lib/auth";
import { detached } from "@/lib/detached";
import { fetchDevOtp } from "@/lib/dev-otp";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

import {
  clearDevQuickStartAttempt,
  readDevQuickStartAttempt,
  writeDevQuickStartAttempt,
} from "./dev-quick-start-storage";
import {
  DEV_QUICK_START_PHASE,
  createDevQuickStartIdentity,
  type DevQuickStartAttempt,
  type DevQuickStartIdentity,
  type DevQuickStartPhase,
  runDevQuickStart,
} from "./dev-quick-start.logic";

const QUICK_START_MATTER_COUNT = 3;
const QUICK_START_INCOMPLETE_MATTER_MODE = "replace";

const PHASE_LABELS = {
  [DEV_QUICK_START_PHASE.authenticate]: "Signing in",
  [DEV_QUICK_START_PHASE.organization]: "Creating organization",
  [DEV_QUICK_START_PHASE.skills]: "Adding skills",
  [DEV_QUICK_START_PHASE.matters]: "Starting LAB matter import",
} as const satisfies Record<DevQuickStartPhase, string>;

const DEV_QUICK_START_COPY = {
  button: "Dev quick start",
  errorFallback: "Check the API log and try again.",
  errorTitle: "Dev quick start failed",
  successDescription:
    "The import of 3 Harvey LAB matters has started and will continue in the background.",
  successTitle: "Dev setup ready",
} as const;

const DEV_QUICK_START_ERROR = {
  matterImport: "matterImport",
  otpUnavailable: "otpUnavailable",
  seed: "seed",
} as const;

type DevQuickStartErrorCode =
  (typeof DEV_QUICK_START_ERROR)[keyof typeof DEV_QUICK_START_ERROR];

const ERROR_MESSAGES = {
  [DEV_QUICK_START_ERROR.matterImport]:
    "The Harvey LAB import could not start.",
  [DEV_QUICK_START_ERROR.otpUnavailable]:
    "The development OTP was not available.",
  [DEV_QUICK_START_ERROR.seed]: DEV_QUICK_START_COPY.errorFallback,
} as const satisfies Record<DevQuickStartErrorCode, string>;

class DevQuickStartError extends TaggedError("DevQuickStartError")<{
  code: DevQuickStartErrorCode;
  message: string;
}> {}

const AUTHENTICATION_OUTCOME = {
  authenticated: "authenticated",
  twoFactorRequired: "twoFactorRequired",
} as const;

const authenticate = async ({ email }: DevQuickStartIdentity) => {
  const sent = await authClient.emailOtp.sendVerificationOtp({
    email,
    type: "sign-in",
  });
  if (sent.error) {
    throw toAuthClientError(sent.error);
  }

  const otp = await fetchDevOtp(email);
  if (otp === null) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.otpUnavailable,
      message: "Dev OTP was not available.",
    });
  }

  const signedIn = await authClient.signIn.emailOtp({ email, otp });
  if (signedIn.error) {
    throw toAuthClientError(signedIn.error);
  }
  if (isTwoFactorRedirect(signedIn.data)) {
    return AUTHENTICATION_OUTCOME.twoFactorRequired;
  }

  return AUTHENTICATION_OUTCOME.authenticated;
};

const createOrganization = async ({
  organizationName,
  organizationSlug,
}: DevQuickStartIdentity) => {
  const listed = await authClient.organization.list();
  if (listed.error) {
    throw toAuthClientError(listed.error);
  }

  const existing = listed.data.find(({ slug }) => slug === organizationSlug);
  const organizationId = await (async () => {
    if (existing) {
      return existing.id;
    }

    const created = await authClient.organization.create({
      name: organizationName,
      slug: organizationSlug,
    });
    if (created.error) {
      throw toAuthClientError(created.error);
    }

    return created.data.id;
  })();

  const active = await authClient.organization.setActive({
    organizationId,
  });
  if (active.error) {
    throw toAuthClientError(active.error);
  }

  return organizationId;
};

const seedSkills = async (organizationId: string) => {
  const response = await api.dev["seed-skills"].post({ organizationId });
  if (response.error) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.seed,
      message: "The default skills could not be installed.",
    });
  }
};

const startMatterImport = async (
  { selectionSeed }: DevQuickStartIdentity,
  organizationId: string,
) => {
  const response = await api.dev["seed-firm-knowledge"].post({
    incompleteMatterMode: QUICK_START_INCOMPLETE_MATTER_MODE,
    matters: QUICK_START_MATTER_COUNT,
    organizationId,
    selectionSeed,
  });
  if (response.error) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.matterImport,
      message: "The Harvey LAB import could not start.",
    });
  }

  if (response.data instanceof Response) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.matterImport,
      message: "The Harvey LAB import could not start.",
    });
  }
};

export const DevQuickStartButton = ({ redirectTo }: { redirectTo: string }) => {
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const invalidateSession = useInvalidateSession();
  const attemptRef = useRef<DevQuickStartAttempt | null>(null);
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);
  const currentPhaseLabel = phase === null ? null : PHASE_LABELS[phase];

  const runQuickStart = async () => {
    const attempt =
      attemptRef.current ??
      readDevQuickStartAttempt() ??
      ({
        completedPhase: null,
        identity: createDevQuickStartIdentity(crypto.randomUUID()),
        organizationId: null,
      } satisfies DevQuickStartAttempt);
    attemptRef.current = attempt;
    writeDevQuickStartAttempt(attempt);
    setPhase(DEV_QUICK_START_PHASE.authenticate);

    const result = await Result.tryPromise({
      try: async () => await authenticate(attempt.identity),
      catch: (cause) => cause,
    });

    if (Result.isError(result)) {
      setPhase(null);
      analytics.captureError(result.error);
      stellaToast.add({
        title: DEV_QUICK_START_COPY.errorTitle,
        description: DevQuickStartError.is(result.error)
          ? ERROR_MESSAGES[result.error.code]
          : userErrorFromThrown(
              result.error,
              DEV_QUICK_START_COPY.errorFallback,
            ),
        type: "error",
      });
      return;
    }

    const authenticatedAttempt =
      attempt.completedPhase === null
        ? {
            completedPhase: DEV_QUICK_START_PHASE.authenticate,
            identity: attempt.identity,
            organizationId: attempt.organizationId,
          }
        : attempt;
    attemptRef.current = authenticatedAttempt;
    writeDevQuickStartAttempt(authenticatedAttempt);

    if (result.value === AUTHENTICATION_OUTCOME.twoFactorRequired) {
      await navigate({
        to: "/auth/two-factor",
        search: { devQuickStart: true, redirectTo },
      });
      return;
    }

    await invalidateSession.mutateAsync();
    await navigate({
      to: "/auth/organization",
      search: { devQuickStart: true, redirectTo },
    });
  };

  const handleQuickStart = async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;

    await runQuickStart().finally(() => {
      runningRef.current = false;
    });
  };

  return (
    <Button
      className="w-full uppercase"
      disabled={phase !== null}
      loading={phase !== null}
      onClick={() => {
        detached(handleQuickStart(), "dev-quick-start.run");
      }}
      size="lg"
      type="button"
      variant="outline"
    >
      {currentPhaseLabel ?? DEV_QUICK_START_COPY.button}
    </Button>
  );
};

export const DevQuickStartContinuation = ({
  redirectTo,
}: {
  redirectTo: string;
}) => {
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const attemptRef = useRef<DevQuickStartAttempt | null>(null);
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);
  const currentPhaseLabel = phase === null ? null : PHASE_LABELS[phase];

  const runContinuation = async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;

    const attempt =
      attemptRef.current ??
      readDevQuickStartAttempt() ??
      ({
        completedPhase: DEV_QUICK_START_PHASE.authenticate,
        identity: createDevQuickStartIdentity(crypto.randomUUID()),
        organizationId: null,
      } satisfies DevQuickStartAttempt);
    attemptRef.current = attempt;
    writeDevQuickStartAttempt(attempt);

    const result = await Result.tryPromise({
      try: async () => {
        const updated = await authClient.updateUser({
          name: "Dev Quick Start",
        });
        if (updated.error) {
          throw toAuthClientError(updated.error);
        }

        await runDevQuickStart({
          attempt,
          authenticate: async () => {
            await Promise.resolve();
          },
          createOrganization,
          onAttemptUpdated: (nextAttempt) => {
            attemptRef.current = nextAttempt;
            writeDevQuickStartAttempt(nextAttempt);
          },
          onPhase: setPhase,
          startMatterImport,
          seedSkills,
        });
        await invalidateSession.mutateAsync();
        clearDevQuickStartAttempt();
      },
      catch: (cause) => cause,
    });

    runningRef.current = false;
    if (Result.isError(result)) {
      setPhase(null);
      analytics.captureError(result.error);
      stellaToast.add({
        title: DEV_QUICK_START_COPY.errorTitle,
        description: DevQuickStartError.is(result.error)
          ? ERROR_MESSAGES[result.error.code]
          : userErrorFromThrown(
              result.error,
              DEV_QUICK_START_COPY.errorFallback,
            ),
        type: "error",
      });
      return;
    }

    stellaToast.add({
      title: DEV_QUICK_START_COPY.successTitle,
      description: DEV_QUICK_START_COPY.successDescription,
      type: "success",
    });
    window.location.assign(redirectTo);
  };

  useMountEffect(() => {
    detached(runContinuation(), "dev-quick-start.continue");
  });

  return (
    <Button
      className="w-full max-w-md uppercase"
      disabled={phase !== null}
      loading={phase !== null}
      onClick={() => {
        detached(runContinuation(), "dev-quick-start.retry");
      }}
      size="lg"
      type="button"
      variant="outline"
    >
      {currentPhaseLabel ?? DEV_QUICK_START_COPY.button}
    </Button>
  );
};
