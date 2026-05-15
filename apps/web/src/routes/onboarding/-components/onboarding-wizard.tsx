import { useCallback, useEffect, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import {
  createDefaultRoleModels,
  createProviderCredentialDraft,
  getProviderValues,
  hasUsableProviderDrafts,
  serializeOverrideModels,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderCredentialDraft,
  ProviderPreview,
  RoleModelSelections,
} from "@/components/ai-config-role-models.logic";
import { LanguagePicker } from "@/components/language-picker";
import { ThemePicker } from "@/components/theme-picker";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { toAPIError, toAuthClientError } from "@/lib/errors";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import { suggestedCountryCodes as getSuggestedCountryCodes } from "@/lib/jurisdictions";
import { sessionOptions } from "@/routes/-queries";
import { aiConfigKeys } from "@/routes/_protected.organization/-ai-config-queries";
import { OnboardingLayout } from "@/routes/onboarding/-components/onboarding-layout";
import { PricesPanel } from "@/routes/onboarding/-components/prices-panel";
import { SidebarPreview } from "@/routes/onboarding/-components/sidebar-preview";
import { AIStep } from "@/routes/onboarding/-components/steps/ai-step";
import type { Phase } from "@/routes/onboarding/-components/steps/creating-step";
import { CreatingStep } from "@/routes/onboarding/-components/steps/creating-step";
import { DownloadStep } from "@/routes/onboarding/-components/steps/download-step";
import { InviteStep } from "@/routes/onboarding/-components/steps/invite-step";
import {
  JurisdictionGlobePreview,
  JurisdictionStep,
} from "@/routes/onboarding/-components/steps/jurisdiction-step";
import { OrganizationStep } from "@/routes/onboarding/-components/steps/organization-step";
type Step =
  | "organization"
  | "jurisdiction"
  | "ai"
  | "invite"
  | "download"
  | "creating";

type WizardData = {
  orgName: string;
  orgSlug: string;
  practiceJurisdictions: PracticeJurisdiction[];
  emails: string[];
  aiProviders: ProviderCredentialDraft[];
  aiRoleModels: RoleModelSelections;
};

const TOTAL_STEPS = 5;

const STEP_TO_PROGRESS = {
  organization: 0,
  jurisdiction: 1,
  ai: 2,
  invite: 3,
  download: 4,
} as const satisfies Record<Exclude<Step, "creating">, number>;

export const OnboardingWizard = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const queryClient = useQueryClient();
  const { data: sessionData } = useQuery(sessionOptions);
  const userEmail = sessionData?.user?.email ?? "";
  const [step, setStep] = useState<Step>("organization");
  const [data, setData] = useState<WizardData>(() => ({
    orgName: "",
    orgSlug: "",
    practiceJurisdictions: [],
    emails: [],
    aiProviders: [createProviderCredentialDraft()],
    aiRoleModels: createDefaultRoleModels(),
  }));
  const [suggestedCountryCodes, setSuggestedCountryCodes] = useState<string[]>(
    [],
  );
  const [jurisdictionSuggestionApplied, setJurisdictionSuggestionApplied] =
    useState(false);

  // Creating step state
  const [creatingPhase, setCreatingPhase] = useState<Phase>("org");
  const [creatingProgress, setCreatingProgress] = useState(0);

  // Live preview state
  const [previewOrgName, setPreviewOrgName] = useState("");
  const [previewEmailCount, setPreviewEmailCount] = useState(0);
  const [previewAiProviders, setPreviewAiProviders] = useState<
    readonly ProviderPreview[]
  >([]);
  const [aiPhase, setAiPhase] = useState<"providers" | "models">("providers");

  useEffect(() => {
    const locale =
      typeof navigator === "undefined" ? "en" : navigator.language || "en";

    setSuggestedCountryCodes(
      getSuggestedCountryCodes({
        email: userEmail,
        locale,
      }),
    );
  }, [userEmail]);

  useEffect(() => {
    const suggestedCountryCode = suggestedCountryCodes.at(0);

    if (
      jurisdictionSuggestionApplied ||
      data.practiceJurisdictions.length > 0 ||
      !suggestedCountryCode
    ) {
      return;
    }

    setData((currentData) => ({
      ...currentData,
      practiceJurisdictions: [
        { countryCode: suggestedCountryCode, isPrimary: true },
      ],
    }));
    setJurisdictionSuggestionApplied(true);
  }, [
    data.practiceJurisdictions.length,
    jurisdictionSuggestionApplied,
    suggestedCountryCodes,
  ]);

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
      await delay(800);

      const { data: orgData, error: createOrgError } =
        await authClient.organization.create({
          name: finalData.orgName,
          slug: finalData.orgSlug,
        });

      if (createOrgError) {
        analytics.captureError(toAuthClientError(createOrgError));
        stellaToast.add({
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
        stellaToast.add({
          title: setActiveError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        setStep("organization");
        return;
      }

      // From here the org already exists; if anything fails
      // the safest recovery is to navigate to the main chat.
      try {
        // Refresh session so the app recognizes the new org
        await invalidateSession.mutateAsync();
        await delay(500);
        setCreatingProgress(50);

        if (finalData.practiceJurisdictions.length > 0) {
          const { error: jurisdictionError } = await api[
            "organization-settings"
          ]["practice-jurisdictions"].post({
            practiceJurisdictions: finalData.practiceJurisdictions,
          });

          if (jurisdictionError) {
            analytics.captureError(toAPIError(jurisdictionError));
            stellaToast.add({
              title: t("onboarding.jurisdictionSaveFailed"),
              type: "warning",
            });
          }
        }

        // Phase 2: Save AI config (BYOK) if user provided one
        const aiProviderValues = getProviderValues(finalData.aiProviders);
        const aiOverrideModels = serializeOverrideModels({
          providers: aiProviderValues,
          roleModels: finalData.aiRoleModels,
        });

        if (
          hasUsableProviderDrafts(finalData.aiProviders) &&
          aiOverrideModels !== null
        ) {
          setCreatingPhase("ai");
          setCreatingProgress(65);
          const { error: aiConfigError } = await api["organization-settings"][
            "ai-config"
          ].post({
            providers: finalData.aiProviders.map((providerDraft) => ({
              provider: providerDraft.provider,
              ...(providerDraft.apiKey.trim()
                ? { apiKey: providerDraft.apiKey.trim() }
                : {}),
              ...(() => {
                if (providerDraft.provider === "azure_foundry") {
                  return {
                    endpoint: providerDraft.endpoint.trim(),
                    ...(providerDraft.apiVersion
                      ? {
                          apiVersion: providerDraft.apiVersion,
                        }
                      : {}),
                  };
                }
                return {};
              })(),
              region: providerDraft.region,
            })),
            overrideModels: aiOverrideModels,
          });

          if (aiConfigError) {
            analytics.captureError(toAPIError(aiConfigError));
            stellaToast.add({
              title: t("onboarding.aiConfigFailed"),
              type: "warning",
            });
          } else {
            queryClient.setQueryData(
              aiConfigKeys.availability({ organizationId: orgData.id }),
              {
                available: true,
                instanceProvisioned: false,
                orgConfigured: true,
              },
            );
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: aiConfigKeys.byOrganization({
                  organizationId: orgData.id,
                }),
              }),
              queryClient.invalidateQueries({
                queryKey: aiConfigKeys.availability({
                  organizationId: orgData.id,
                }),
              }),
            ]);
          }
        }

        // Phase 3: Send invitations
        if (finalData.emails.length > 0) {
          setCreatingPhase("invites");
          setCreatingProgress(80);

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
            stellaToast.add({
              title: t("onboarding.someInvitesFailed", {
                count: failedCount,
              }),
              type: "warning",
            });
          }
        }

        await delay(500);
        setCreatingProgress(90);

        // Phase 3: Complete
        setCreatingPhase("done");
        setCreatingProgress(100);

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
        to: "/chat",
        replace: true,
      });
    },
    [analytics, invalidateSession, navigate, queryClient, t],
  );

  const showPrices = step === "ai" && aiPhase === "models";
  const preview = (() => {
    if (step === "jurisdiction") {
      return (
        <JurisdictionGlobePreview
          onChange={(practiceJurisdictions) => {
            setData((d) => ({
              ...d,
              practiceJurisdictions,
            }));
            setJurisdictionSuggestionApplied(true);
          }}
          selected={data.practiceJurisdictions}
        />
      );
    }
    if (showPrices) {
      return (
        <PricesPanel
          providers={data.aiProviders.map((p) => p.provider)}
          roleModels={data.aiRoleModels}
        />
      );
    }
    return (
      <SidebarPreview
        aiProviders={previewAiProviders}
        chatActive={step === "ai"}
        emailCount={previewEmailCount}
        matterName=""
        organizationName={previewOrgName}
      />
    );
  })();

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
              setStep("jurisdiction");
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "jurisdiction") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.jurisdiction}
          onBack={() => setStep("organization")}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <JurisdictionStep
            selected={data.practiceJurisdictions}
            suggestedCountryCodes={suggestedCountryCodes}
            onChange={(practiceJurisdictions) => {
              setData((d) => ({ ...d, practiceJurisdictions }));
              setJurisdictionSuggestionApplied(true);
            }}
            onNext={() => setStep("ai")}
            onSkip={() => {
              setData((d) => ({ ...d, practiceJurisdictions: [] }));
              setJurisdictionSuggestionApplied(true);
              setStep("ai");
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "invite") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.invite}
          onBack={() => setStep("ai")}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <InviteStep
            onEmailCountChange={setPreviewEmailCount}
            userEmail={userEmail}
            onNext={({ emails }) => {
              setData((d) => ({ ...d, emails }));
              setStep("download");
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "ai") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.ai}
          onBack={() => {
            if (aiPhase === "models") {
              setAiPhase("providers");
              return;
            }
            setStep("jurisdiction");
          }}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <AIStep
            onNext={() => setStep("invite")}
            onPhaseChange={setAiPhase}
            onPreviewChange={setPreviewAiProviders}
            phase={aiPhase}
            onProvidersChange={(aiProviders) => {
              setData((d) => ({ ...d, aiProviders }));
            }}
            onRoleModelsChange={(aiRoleModels) => {
              setData((d) => ({ ...d, aiRoleModels }));
            }}
            onSkip={() => {
              setData((d) => ({
                ...d,
                aiProviders: [createProviderCredentialDraft()],
                aiRoleModels: createDefaultRoleModels(),
              }));
              setPreviewAiProviders([]);
              setStep("invite");
            }}
            providers={data.aiProviders}
            roleModels={data.aiRoleModels}
          />
        </OnboardingLayout>
      );
    }

    // step === "download"
    return (
      <OnboardingLayout
        currentStep={STEP_TO_PROGRESS.download}
        onBack={() => setStep("invite")}
        preview={preview}
        totalSteps={TOTAL_STEPS}
      >
        <DownloadStep
          onNext={() => {
            // eslint-disable-next-line typescript/no-floating-promises
            executeSetup(data);
          }}
          onSkip={() => {
            // eslint-disable-next-line typescript/no-floating-promises
            executeSetup(data);
          }}
        />
      </OnboardingLayout>
    );
  };

  return (
    <>
      {renderStep()}
      <div className="fixed end-4 top-4 z-20 flex items-center gap-2 lg:end-8 lg:top-6">
        <ThemePicker />
        <LanguagePicker />
      </div>
    </>
  );
};
