import { useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import type { TranslationKey } from "@/i18n/types";
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

const QUICK_START_MATTER_COUNT = 10;
const MATTER_IMPORT_POLL_INTERVAL_MS = 1000;
const MATTER_IMPORT_MAX_POLLS = 15 * 60;
const QUICK_START_INCOMPLETE_MATTER_MODE = "replace";

const PHASE_LABEL_KEYS = {
  [DEV_QUICK_START_PHASE.authenticate]:
    "auth.devQuickStart.phase.authenticating",
  [DEV_QUICK_START_PHASE.organization]:
    "auth.devQuickStart.phase.creatingOrganization",
  [DEV_QUICK_START_PHASE.skills]: "auth.devQuickStart.phase.addingSkills",
  [DEV_QUICK_START_PHASE.matters]: "auth.devQuickStart.phase.startingImport",
} as const satisfies Record<DevQuickStartPhase, TranslationKey>;

const DEV_QUICK_START_ERROR = {
  matterImport: "matterImport",
  otpUnavailable: "otpUnavailable",
  seed: "seed",
} as const;

type DevQuickStartErrorCode =
  (typeof DEV_QUICK_START_ERROR)[keyof typeof DEV_QUICK_START_ERROR];

const ERROR_MESSAGE_KEYS = {
  [DEV_QUICK_START_ERROR.matterImport]: "auth.devQuickStart.error.matterImport",
  [DEV_QUICK_START_ERROR.otpUnavailable]:
    "auth.devQuickStart.error.otpUnavailable",
  [DEV_QUICK_START_ERROR.seed]: "auth.devQuickStart.error.fallback",
} as const satisfies Record<DevQuickStartErrorCode, TranslationKey>;

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

const waitForMatterImport = async (
  jobId: string,
  remainingPolls = MATTER_IMPORT_MAX_POLLS,
): Promise<void> => {
  if (remainingPolls === 0) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.matterImport,
      message: "The Harvey LAB import did not finish before the timeout.",
    });
  }

  const { data, error } = await api.dev["seed-firm-knowledge"].get({
    query: { jobId },
  });
  if (error !== null || data instanceof Response) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.matterImport,
      message: "The Harvey LAB import status was unavailable.",
    });
  }

  switch (data.status) {
    case "failed":
      throw new DevQuickStartError({
        code: DEV_QUICK_START_ERROR.matterImport,
        message: data.message,
      });
    case "idle":
      throw new DevQuickStartError({
        code: DEV_QUICK_START_ERROR.matterImport,
        message: "The Harvey LAB import stopped before completion.",
      });
    case "running":
      await new Promise<void>((resolve) => {
        setTimeout(resolve, MATTER_IMPORT_POLL_INTERVAL_MS);
      });
      await waitForMatterImport(jobId, remainingPolls - 1);
      return undefined;
    case "succeeded":
      return undefined;
    default:
      data satisfies never;
      return panic(`Unhandled data: ${String(data)}`);
  }
};

const seedMatters = async (
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

  await waitForMatterImport(response.data.jobId);
};

export const DevQuickStartButton = ({ redirectTo }: { redirectTo: string }) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const invalidateSession = useInvalidateSession();
  const attemptRef = useRef<DevQuickStartAttempt | null>(null);
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);

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
        title: t("auth.devQuickStart.error.title"),
        description: DevQuickStartError.is(result.error)
          ? t(ERROR_MESSAGE_KEYS[result.error.code])
          : userErrorFromThrown(
              result.error,
              t("auth.devQuickStart.error.fallback"),
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
      {phase === null
        ? t("auth.devQuickStart.button")
        : t(PHASE_LABEL_KEYS[phase])}
    </Button>
  );
};

export const DevQuickStartContinuation = ({
  redirectTo,
}: {
  redirectTo: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const attemptRef = useRef<DevQuickStartAttempt | null>(null);
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);

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
          seedMatters,
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
        title: t("auth.devQuickStart.error.title"),
        description: DevQuickStartError.is(result.error)
          ? t(ERROR_MESSAGE_KEYS[result.error.code])
          : userErrorFromThrown(
              result.error,
              t("auth.devQuickStart.error.fallback"),
            ),
        type: "error",
      });
      return;
    }

    stellaToast.add({
      title: t("auth.devQuickStart.success.title"),
      description: t("auth.devQuickStart.success.description"),
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
      {phase === null
        ? t("auth.devQuickStart.button")
        : t(PHASE_LABEL_KEYS[phase])}
    </Button>
  );
};
