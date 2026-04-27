import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { sessionOptions } from "@/routes/-queries";
import { LanguagePicker } from "@/routes/onboarding/-components/language-picker";
import { OnboardingLayout } from "@/routes/onboarding/-components/onboarding-layout";
import { SidebarPreview } from "@/routes/onboarding/-components/sidebar-preview";
import type { Phase } from "@/routes/onboarding/-components/steps/creating-step";
import { CreatingStep } from "@/routes/onboarding/-components/steps/creating-step";
import {
  DMS_NONE,
  DmsStep,
} from "@/routes/onboarding/-components/steps/dms-step";
import { InviteStep } from "@/routes/onboarding/-components/steps/invite-step";
import { OrganizationStep } from "@/routes/onboarding/-components/steps/organization-step";
type Step = "organization" | "dms" | "invite" | "creating";

type WizardData = {
  orgName: string;
  orgSlug: string;
  previousDms: string;
  emails: string[];
};

const TOTAL_STEPS = 3;

const STEP_TO_PROGRESS = {
  organization: 0,
  dms: 1,
  invite: 2,
} as const satisfies Record<Exclude<Step, "creating">, number>;

export const OnboardingWizard = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const { data: sessionData } = useQuery(sessionOptions);
  const userEmail = sessionData?.user?.email ?? "";
  const [step, setStep] = useState<Step>("organization");
  const [data, setData] = useState<WizardData>({
    orgName: "",
    orgSlug: "",
    previousDms: "",
    emails: [],
  });

  // Creating step state
  const [creatingPhase, setCreatingPhase] = useState<Phase>("org");
  const [creatingProgress, setCreatingProgress] = useState(0);

  // Live preview state
  const [previewOrgName, setPreviewOrgName] = useState("");
  const [previewDmsCount, setPreviewDmsCount] = useState(0);
  const [previewEmailCount, setPreviewEmailCount] = useState(0);

  const executeSetup = useCallback(
    async (finalData: WizardData) => {
      setStep("creating");
      const startTime = Date.now();

      // eslint-disable-next-line require-await
      const delay = async (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        });

      // Phase 1: Create organization
      setCreatingPhase("org");
      setCreatingProgress(15);
      analytics.capture("onboarding_started");
      await delay(800);

      const { data: orgData, error: createOrgError } =
        await authClient.organization.create({
          name: finalData.orgName,
          slug: finalData.orgSlug,
        });

      if (createOrgError) {
        analytics.captureError(toAuthClientError(createOrgError));
        toastManager.add({
          title: createOrgError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        setStep("organization");
        return;
      }

      await delay(600);
      setCreatingProgress(35);

      const { error: setActiveError } = await authClient.organization.setActive(
        {
          organizationId: orgData.id,
        },
      );

      if (setActiveError) {
        analytics.captureError(toAuthClientError(setActiveError));
        toastManager.add({
          title: setActiveError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        setStep("organization");
        return;
      }

      // From here the org already exists; if anything fails
      // the safest recovery is to navigate to /workspaces.
      try {
        // Refresh session so the app recognizes the new org
        await invalidateSession.mutateAsync();
        await delay(500);
        setCreatingProgress(60);

        // Phase 2: Send invitations
        if (finalData.emails.length > 0) {
          setCreatingPhase("invites");
          setCreatingProgress(70);

          const inviteResults = await Promise.all(
            // eslint-disable-next-line typescript/promise-function-async
            finalData.emails.map((email) =>
              authClient.organization.inviteMember({
                email,
                role: "member",
              }),
            ),
          );

          const failedCount = inviteResults.filter(
            (r) => r.error !== null && r.error !== undefined,
          ).length;

          if (failedCount > 0) {
            toastManager.add({
              title: t("onboarding.someInvitesFailed", {
                count: failedCount,
              }),
              type: "warning",
            });
          }
        }

        await delay(500);
        setCreatingProgress(90);

        // Capture DMS selection for sales/product
        if (finalData.previousDms !== DMS_NONE) {
          analytics.capture("onboarding_dms_selected", {
            dms: finalData.previousDms,
          });
        }

        // Phase 3: Complete
        setCreatingPhase("done");
        setCreatingProgress(100);

        analytics.capture("onboarding_completed");

        // Minimum display time so the user can read the status
        const elapsed = Date.now() - startTime;
        const minDisplayMs = 4000;
        if (elapsed < minDisplayMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, minDisplayMs - elapsed);
          });
        }
      } catch (error) {
        analytics.captureError(error);
      }

      await navigate({
        to: "/workspaces",
        replace: true,
      });
    },
    [analytics, invalidateSession, navigate, t],
  );

  const preview = (
    <SidebarPreview
      dmsCount={previewDmsCount}
      emailCount={previewEmailCount}
      matterName=""
      organizationName={previewOrgName}
    />
  );

  const renderStep = () => {
    if (step === "creating") {
      return (
        <CreatingStep
          currentPhase={creatingPhase}
          progress={creatingProgress}
        />
      );
    }

    if (step === "organization") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.organization}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <OrganizationStep
            defaultName={data.orgName}
            onNameChange={setPreviewOrgName}
            onNext={({ name, slug }) => {
              setData((d) => ({
                ...d,
                orgName: name,
                orgSlug: slug,
              }));
              setPreviewOrgName(name);
              analytics.capture("onboarding_step_completed", {
                step: "organization",
              });
              setStep("dms");
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "dms") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.dms}
          onBack={() => setStep("organization")}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <DmsStep
            onSelectionChange={setPreviewDmsCount}
            onNext={({ dms }) => {
              setData((d) => ({
                ...d,
                previousDms: dms,
              }));
              analytics.capture("onboarding_step_completed", {
                step: "dms",
                dms,
              });
              setStep("invite");
            }}
          />
        </OnboardingLayout>
      );
    }

    // step === "invite"
    return (
      <OnboardingLayout
        currentStep={STEP_TO_PROGRESS.invite}
        onBack={() => setStep("dms")}
        preview={preview}
        totalSteps={TOTAL_STEPS}
      >
        <InviteStep
          onEmailCountChange={setPreviewEmailCount}
          userEmail={userEmail}
          onNext={({ emails }) => {
            const finalData = { ...data, emails };
            setData(finalData);
            if (emails.length === 0) {
              analytics.capture("onboarding_skipped_invite");
            } else {
              analytics.capture("onboarding_step_completed", {
                step: "invite",
              });
            }
            // eslint-disable-next-line typescript/no-floating-promises
            executeSetup(finalData);
          }}
        />
      </OnboardingLayout>
    );
  };

  return (
    <>
      {renderStep()}
      <LanguagePicker />
    </>
  );
};
