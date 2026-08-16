import { useRef, useState } from "react";

import { Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { detached } from "@/lib/detached";
import { fetchDevOtp } from "@/lib/dev-otp";
import { toAPIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

import {
  DEV_QUICK_START_PHASE,
  createDevQuickStartIdentity,
  type DevQuickStartAttempt,
  type DevQuickStartIdentity,
  type DevQuickStartPhase,
  runDevQuickStart,
} from "./dev-quick-start.logic";

const QUICK_START_MATTER_COUNT = 10;

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
} as const;

type DevQuickStartErrorCode =
  (typeof DEV_QUICK_START_ERROR)[keyof typeof DEV_QUICK_START_ERROR];

const ERROR_MESSAGE_KEYS = {
  [DEV_QUICK_START_ERROR.matterImport]: "auth.devQuickStart.error.matterImport",
  [DEV_QUICK_START_ERROR.otpUnavailable]:
    "auth.devQuickStart.error.otpUnavailable",
} as const satisfies Record<DevQuickStartErrorCode, TranslationKey>;

class DevQuickStartError extends TaggedError("DevQuickStartError")<{
  code: DevQuickStartErrorCode;
  message: string;
}> {}

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

  const updated = await authClient.updateUser({ name: "Dev Quick Start" });
  if (updated.error) {
    throw toAuthClientError(updated.error);
  }
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
};

const seedSkills = async () => {
  const response = await api.skills.seed.post({});
  if (response.error) {
    throw toAPIError(response.error);
  }
};

const seedMatters = async ({ selectionSeed }: DevQuickStartIdentity) => {
  const response = await api.dev["seed-firm-knowledge"].post({
    matters: QUICK_START_MATTER_COUNT,
    selectionSeed,
  });
  if (response.error) {
    throw new DevQuickStartError({
      code: DEV_QUICK_START_ERROR.matterImport,
      message: "The Harvey LAB import could not start.",
    });
  }
};

export const DevQuickStartButton = ({ redirectTo }: { redirectTo: string }) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const attemptRef = useRef<DevQuickStartAttempt | null>(null);
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);

  const handleQuickStart = async () => {
    if (phase !== null) {
      return;
    }

    const attempt =
      attemptRef.current ??
      ({
        completedPhase: null,
        identity: createDevQuickStartIdentity(crypto.randomUUID()),
      } satisfies DevQuickStartAttempt);
    attemptRef.current = attempt;

    const result = await Result.tryPromise({
      try: async () => {
        await runDevQuickStart({
          attempt,
          authenticate,
          createOrganization,
          onPhase: setPhase,
          onPhaseCompleted: (completedPhase) => {
            attemptRef.current = {
              completedPhase,
              identity: attempt.identity,
            };
          },
          seedMatters,
          seedSkills,
        });
        await invalidateSession.mutateAsync();
      },
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

    stellaToast.add({
      title: t("auth.devQuickStart.success.title"),
      description: t("auth.devQuickStart.success.description"),
      type: "success",
    });
    window.location.assign(redirectTo);
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
