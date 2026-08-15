import { useState } from "react";

import { Result, TaggedError } from "better-result";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
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
  type DevQuickStartIdentity,
  type DevQuickStartPhase,
  runDevQuickStart,
} from "./dev-quick-start.logic";

const QUICK_START_MATTER_COUNT = 10;

const PHASE_LABELS = {
  [DEV_QUICK_START_PHASE.authenticate]: "SIGNING IN",
  [DEV_QUICK_START_PHASE.organization]: "CREATING WORKSPACE",
  [DEV_QUICK_START_PHASE.skills]: "ADDING SKILLS",
  [DEV_QUICK_START_PHASE.matters]: "STARTING LAB IMPORT",
} as const satisfies Record<DevQuickStartPhase, string>;

class DevQuickStartError extends TaggedError("DevQuickStartError")<{
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
    throw new DevQuickStartError({ message: "Dev OTP was not available." });
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
  const created = await authClient.organization.create({
    name: organizationName,
    slug: organizationSlug,
  });
  if (created.error) {
    throw toAuthClientError(created.error);
  }

  const active = await authClient.organization.setActive({
    organizationId: created.data.id,
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
      message: "The Harvey LAB import could not start.",
    });
  }
};

export const DevQuickStartButton = ({ redirectTo }: { redirectTo: string }) => {
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const [phase, setPhase] = useState<DevQuickStartPhase | null>(null);

  const handleQuickStart = async () => {
    if (phase !== null) {
      return;
    }

    const result = await Result.tryPromise(async () => {
      await runDevQuickStart({
        authenticate,
        createOrganization,
        onPhase: setPhase,
        randomId: crypto.randomUUID(),
        seedMatters,
        seedSkills,
      });
      await invalidateSession.mutateAsync();
    });

    if (Result.isError(result)) {
      setPhase(null);
      analytics.captureError(result.error);
      stellaToast.add({
        title: "Dev quick start failed",
        description: userErrorFromThrown(
          result.error,
          "Check the API log and try again.",
        ),
        type: "error",
      });
      return;
    }

    stellaToast.add({
      title: "Dev workspace ready",
      description: "10 Harvey LAB matters are importing in the background.",
      type: "success",
    });
    window.location.assign(redirectTo);
  };

  return (
    <Button
      className="w-full"
      disabled={phase !== null}
      loading={phase !== null}
      onClick={() => {
        detached(handleQuickStart(), "dev-quick-start.run");
      }}
      size="lg"
      type="button"
      variant="outline"
    >
      {phase === null ? "DEV QUICK START" : PHASE_LABELS[phase]}
    </Button>
  );
};
