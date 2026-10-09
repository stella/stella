import { useSyncExternalStore } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Result, TaggedError } from "better-result";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient, isTwoFactorRedirect } from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { fetchDevOtp } from "@/lib/dev-otp";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { createRandomValue } from "@/lib/uuid";

import { devQuickStartRuntime } from "./dev-quick-start-runtime";
import {
  readDevQuickStartAttempt,
  writeDevQuickStartAttempt,
} from "./dev-quick-start-storage";
import {
  DEV_QUICK_START_PHASE,
  DEV_QUICK_START_STAGE,
  createDevQuickStartIdentity,
  type DevQuickStartAttempt,
  type DevQuickStartIdentity,
  type DevQuickStartPhase,
  resolveDevQuickStartOrganization,
  runDevQuickStart,
  startDevQuickStartAttempt,
} from "./dev-quick-start.logic";

const QUICK_START_MATTER_COUNT = 3;
const QUICK_START_INCOMPLETE_MATTER_MODE = "replace";

const PHASE_LABELS = {
  [DEV_QUICK_START_PHASE.authenticate]: "Signing in",
  [DEV_QUICK_START_PHASE.organization]: "Creating organization",
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
  matterImportRunning: "matterImportRunning",
  otpUnavailable: "otpUnavailable",
} as const;

type DevQuickStartErrorCode =
  (typeof DEV_QUICK_START_ERROR)[keyof typeof DEV_QUICK_START_ERROR];

const ERROR_MESSAGES = {
  [DEV_QUICK_START_ERROR.matterImport]:
    "The Harvey LAB import could not start.",
  [DEV_QUICK_START_ERROR.matterImportRunning]:
    "An import is already running. Wait for it to finish and try again.",
  [DEV_QUICK_START_ERROR.otpUnavailable]:
    "The development OTP was not available.",
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

const createOrganization = async (identity: DevQuickStartIdentity) => {
  const resolved = await resolveDevQuickStartOrganization({
    identity,
    listOrganizations: async () => {
      const listed = await authClient.organization.list();
      if (listed.error) {
        throw toAuthClientError(listed.error);
      }
      return listed.data;
    },
    createOrganization: async ({ organizationName, organizationSlug }) => {
      const created = await authClient.organization.create({
        name: organizationName,
        slug: organizationSlug,
      });
      if (created.error) {
        throw toAuthClientError(created.error);
      }
      return created.data.id;
    },
  });
  if (Result.isError(resolved)) {
    throw resolved.error;
  }
  const organizationId = resolved.value;

  const active = await authClient.organization.setActive({
    organizationId,
  });
  if (active.error) {
    throw toAuthClientError(active.error);
  }

  return organizationId;
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
    const code =
      response.error.status === 409
        ? DEV_QUICK_START_ERROR.matterImportRunning
        : DEV_QUICK_START_ERROR.matterImport;
    throw new DevQuickStartError({
      code,
      message: ERROR_MESSAGES[code],
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
  const phase = useSyncExternalStore(
    devQuickStartRuntime.subscribe,
    devQuickStartRuntime.getPhase,
    () => null,
  );
  const currentPhaseLabel = phase === null ? null : PHASE_LABELS[phase];

  const runQuickStart = async () => {
    const createIdentity = () =>
      createDevQuickStartIdentity(createRandomValue());
    const retainedAttempt = devQuickStartRuntime.getAttempt(
      () =>
        readDevQuickStartAttempt() ??
        ({
          completedPhase: null,
          identity: createIdentity(),
          organizationId: null,
        } satisfies DevQuickStartAttempt),
    );
    const attempt = startDevQuickStartAttempt(retainedAttempt, createIdentity);
    devQuickStartRuntime.setAttempt(attempt);
    writeDevQuickStartAttempt(attempt);
    devQuickStartRuntime.setPhase(DEV_QUICK_START_PHASE.authenticate);

    const result = await Result.tryPromise({
      try: async () => await authenticate(attempt.identity),
      catch: (cause) => cause,
    });

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      notifyUserError(result.error, DEV_QUICK_START_COPY.errorTitle, {
        description: DevQuickStartError.is(result.error)
          ? ERROR_MESSAGES[result.error.code]
          : userErrorFromThrown(
              result.error,
              DEV_QUICK_START_COPY.errorFallback,
            ),
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
    devQuickStartRuntime.setAttempt(authenticatedAttempt);
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
    await devQuickStartRuntime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.authenticate,
      run: runQuickStart,
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
  const phase = useSyncExternalStore(
    devQuickStartRuntime.subscribe,
    devQuickStartRuntime.getPhase,
    () => null,
  );
  const currentPhaseLabel = phase === null ? null : PHASE_LABELS[phase];

  const runContinuation = async () => {
    const attempt = devQuickStartRuntime.getAttempt(
      () =>
        readDevQuickStartAttempt() ??
        ({
          completedPhase: DEV_QUICK_START_PHASE.authenticate,
          identity: createDevQuickStartIdentity(createRandomValue()),
          organizationId: null,
        } satisfies DevQuickStartAttempt),
    );
    writeDevQuickStartAttempt(attempt);
    devQuickStartRuntime.setPhase(DEV_QUICK_START_PHASE.organization);

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
            devQuickStartRuntime.setAttempt(nextAttempt);
            writeDevQuickStartAttempt(nextAttempt);
          },
          onPhase: devQuickStartRuntime.setPhase,
          startMatterImport,
        });
        await invalidateSession.mutateAsync();
      },
      catch: (cause) => cause,
    });

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      notifyUserError(result.error, DEV_QUICK_START_COPY.errorTitle, {
        description: DevQuickStartError.is(result.error)
          ? ERROR_MESSAGES[result.error.code]
          : userErrorFromThrown(
              result.error,
              DEV_QUICK_START_COPY.errorFallback,
            ),
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

  const handleContinuation = async () =>
    devQuickStartRuntime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run: runContinuation,
    });

  useMountEffect(() => {
    detached(handleContinuation(), "dev-quick-start.continue");
  });

  return (
    <Button
      className="w-full max-w-md uppercase"
      disabled={phase !== null}
      loading={phase !== null}
      onClick={() => {
        detached(handleContinuation(), "dev-quick-start.retry");
      }}
      size="lg"
      type="button"
      variant="outline"
    >
      {currentPhaseLabel ?? DEV_QUICK_START_COPY.button}
    </Button>
  );
};
