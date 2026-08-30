import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  isToggleableNativeToolBackendSlug,
  loadCatalogue,
  recommendedSlugsForJurisdictions,
} from "@stll/catalogue";
import { stellaToast } from "@stll/ui/toast";

import {
  createDefaultRoleModels,
  createProviderCredentialDraft,
  getProviderValues,
  hasUsableProviderDrafts,
  serializeOverrideModels,
  serializeProviderDrafts,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderCredentialDraft,
  ProviderPreview,
  RoleModelSelections,
} from "@/components/ai-config-role-models.logic";
import { LanguagePicker } from "@/components/language-picker";
import { ThemePicker } from "@/components/theme-picker";
import { useBrowserRegion } from "@/hooks/use-browser-region";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { refreshAuthQueries, sessionOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import { suggestedCountryCodes as getSuggestedCountryCodes } from "@/lib/jurisdictions";
import { aiConfigKeys } from "@/lib/organization/ai-config-queries";
import { CatalogueDetailPreview } from "@/routes/onboarding/-components/catalogue-detail-preview";
import { CatalogueStackPreview } from "@/routes/onboarding/-components/catalogue-stack-preview";
import {
  createCatalogueAutoSelectionPlan,
  createCatalogueSetupPlan,
  isCatalogueEntryAvailableDuringOnboarding,
  reconcileCatalogueSlugsForJurisdictions,
} from "@/routes/onboarding/-components/onboarding-catalogue-setup.logic";
import { OnboardingLayout } from "@/routes/onboarding/-components/onboarding-layout";
import { SidebarPreview } from "@/routes/onboarding/-components/sidebar-preview";
import { AIStep } from "@/routes/onboarding/-components/steps/ai-step";
import { CatalogueStep } from "@/routes/onboarding/-components/steps/catalogue-step";
import type { DownloadTarget } from "@/routes/onboarding/-components/steps/download-step";
import {
  DownloadSetupPreview,
  DownloadStep,
} from "@/routes/onboarding/-components/steps/download-step";
import { InviteStep } from "@/routes/onboarding/-components/steps/invite-step";
import {
  JurisdictionGlobePreview,
  JurisdictionStep,
} from "@/routes/onboarding/-components/steps/jurisdiction-step";
import { OrganizationStep } from "@/routes/onboarding/-components/steps/organization-step";
import { nativeToolDeployAvailabilityOptions } from "@/routes/onboarding/-queries";

type Step =
  | "organization"
  | "jurisdiction"
  | "catalogue"
  | "ai"
  | "invite"
  | "download";

type WizardData = {
  orgName: string;
  orgSlug: string;
  practiceJurisdictions: PracticeJurisdiction[];
  catalogueSlugs: string[];
  emails: string[];
  aiProviders: ProviderCredentialDraft[];
  aiRoleModels: RoleModelSelections;
};

const TOTAL_STEPS = 6;

const STEP_TO_PROGRESS = {
  organization: 0,
  jurisdiction: 1,
  catalogue: 2,
  ai: 3,
  invite: 4,
  download: 5,
} as const satisfies Record<Step, number>;

export const OnboardingWizard = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const browserRegion = useBrowserRegion();
  const queryClient = useQueryClient();
  const { data: sessionData } = useQuery(sessionOptions);
  const { data: nativeToolDeployAvailability } = useQuery(
    nativeToolDeployAvailabilityOptions,
  );
  const userEmail = sessionData?.user.email ?? "";
  const [step, setStep] = useState<Step>("organization");
  const [catalogueFocusedSlug, setCatalogueFocusedSlug] = useState<
    string | null
  >(null);
  const [catalogueRemovedSlugs, setCatalogueRemovedSlugs] = useState<
    readonly string[]
  >([]);
  const [downloadTarget, setDownloadTarget] =
    useState<DownloadTarget>("desktop");
  const [data, setData] = useState<WizardData>(() => ({
    orgName: "",
    orgSlug: "",
    practiceJurisdictions: [],
    catalogueSlugs: [],
    emails: [],
    aiProviders: [createProviderCredentialDraft()],
    aiRoleModels: createDefaultRoleModels(),
  }));
  const suggestedCountryCodes = getSuggestedCountryCodes({
    email: userEmail,
    browserRegion: browserRegion || undefined,
    detectedCountry: sessionData?.user.detectedCountry,
  });
  const [jurisdictionSuggestionApplied, setJurisdictionSuggestionApplied] =
    useState(false);

  const [isCreating, setIsCreating] = useState(false);

  // Live preview state
  const [previewOrgName, setPreviewOrgName] = useState("");
  const [previewEmailCount, setPreviewEmailCount] = useState(0);
  const [previewAiProviders, setPreviewAiProviders] = useState<
    readonly ProviderPreview[]
  >([]);
  const unavailableNativeToolBackendSlugs = useMemo<
    ReadonlySet<string> | undefined
  >(() => {
    if (!nativeToolDeployAvailability) {
      return undefined;
    }
    return new Set(
      nativeToolDeployAvailability.unavailableNativeToolBackendSlugs,
    );
  }, [nativeToolDeployAvailability]);
  const onboardingCatalogueEntries = useMemo(
    () =>
      loadCatalogue().filter((entry) =>
        isCatalogueEntryAvailableDuringOnboarding(entry, {
          unavailableNativeToolBackendSlugs,
        }),
      ),
    [unavailableNativeToolBackendSlugs],
  );
  useLayoutEffect(() => {
    if (step !== "catalogue") {
      return;
    }
    // eslint-disable-next-line react/react-compiler -- commit-safe parent-owned reconciliation; the functional update rechecks current selections so stale renders cannot overwrite user edits
    setData((currentData) => {
      const practiceCountryCodes = new Set(
        currentData.practiceJurisdictions.map((jurisdiction) =>
          jurisdiction.countryCode.toUpperCase(),
        ),
      );
      const recommendedSlugs =
        recommendedSlugsForJurisdictions(practiceCountryCodes);
      const recommendedEntries = onboardingCatalogueEntries.filter(
        (entry) =>
          (entry.kind !== "native-tool" ||
            isToggleableNativeToolBackendSlug(entry.backendSlug)) &&
          !(entry.kind === "native-tool" && entry.pinned) &&
          recommendedSlugs.has(entry.slug),
      );
      const autoSelectionPlan = createCatalogueAutoSelectionPlan({
        recommendedEntries,
        removedSlugs: catalogueRemovedSlugs,
        selectedSlugs: currentData.catalogueSlugs,
      });
      if (autoSelectionPlan.addedSlugs.length === 0) {
        return currentData;
      }
      return {
        ...currentData,
        catalogueSlugs: [...autoSelectionPlan.selectedSlugs],
      };
    });
  }, [catalogueRemovedSlugs, onboardingCatalogueEntries, step]);

  const suggestedCountryCode = suggestedCountryCodes.at(0);
  useLayoutEffect(() => {
    if (jurisdictionSuggestionApplied || !suggestedCountryCode) {
      return;
    }
    // eslint-disable-next-line react/react-compiler -- commit-safe one-shot latch for an async suggestion; user edits are rechecked in the functional data update below
    setJurisdictionSuggestionApplied(true);
    setData((currentData) => {
      if (currentData.practiceJurisdictions.length > 0) {
        return currentData;
      }
      return {
        ...currentData,
        practiceJurisdictions: [
          { countryCode: suggestedCountryCode, isPrimary: true },
        ],
      };
    });
  }, [jurisdictionSuggestionApplied, suggestedCountryCode]);

  const continueFromJurisdiction = () => {
    setData((currentData) => ({
      ...currentData,
      catalogueSlugs: [
        ...reconcileCatalogueSlugsForJurisdictions({
          entries: onboardingCatalogueEntries,
          practiceJurisdictions: currentData.practiceJurisdictions,
          selectedSlugs: currentData.catalogueSlugs,
        }),
      ],
    }));
    setCatalogueFocusedSlug(null);
    setStep("catalogue");
  };

  const setCatalogueSlugRemoved = (slug: string, removed: boolean) => {
    setCatalogueRemovedSlugs((currentSlugs) => {
      const next = new Set(currentSlugs);
      if (removed) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      if (next.size === currentSlugs.length) {
        return currentSlugs;
      }
      return [...next];
    });
  };

  const markCatalogueSlugsRemoved = (slugs: readonly string[]) => {
    if (slugs.length === 0) {
      return;
    }
    setCatalogueRemovedSlugs((currentSlugs) => {
      const next = new Set(currentSlugs);
      for (const slug of slugs) {
        next.add(slug);
      }
      if (next.size === currentSlugs.length) {
        return currentSlugs;
      }
      return [...next];
    });
  };

  const executeSetup = useCallback(
    async (finalData: WizardData) => {
      setIsCreating(true);

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
        setIsCreating(false);
        return;
      }

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
        setIsCreating(false);
        return;
      }

      // From here the org already exists; if anything fails
      // the safest recovery is to continue on to the apps step.
      try {
        // Refresh the session/role query cache so the rest of setup (and
        // the apps step after it) sees the new active org. This
        // deliberately refetches the queries directly instead of going
        // through `useInvalidateSession`, which also calls
        // `router.invalidate()`: that re-runs this route's `beforeLoad`
        // immediately, and since the session now has an
        // `activeOrganizationId`, the guard would redirect away from
        // /onboarding before the wizard ever reaches the apps step.
        await refreshAuthQueries(queryClient);

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

        // Phase 1b: Install selected catalogue entries and persist
        // explicit opt-outs for omitted default-on native tools. Runs
        // in parallel; partial failure surfaces as a toast but doesn't
        // block the rest of setup.
        const catalogueEntries = loadCatalogue();
        const catalogueSetupPlan = createCatalogueSetupPlan({
          entries: catalogueEntries,
          practiceJurisdictions: finalData.practiceJurisdictions,
          selectedSlugs: finalData.catalogueSlugs,
          unavailableNativeToolBackendSlugs,
        });
        const installTasks = catalogueSetupPlan.installSlugs.map(
          async (slug) => {
            const entry = catalogueEntries.find((e) => e.slug === slug);
            if (!entry) {
              return;
            }
            if (entry.kind === "skill") {
              const { error } = await api.catalogue["install-skill"].post({
                slug: entry.slug,
              });
              if (error) {
                throw toAPIError(error);
              }
              return;
            }
            if (entry.kind === "native-tool") {
              const { error } = await api.mcp["native-tools"]({
                slug: entry.backendSlug,
              }).patch({ enabled: true });
              if (error) {
                throw toAPIError(error);
              }
              return;
            }
            const { error } = await api.mcp.connectors.post({
              displayName: entry.displayName,
              description: entry.description,
              url: entry.url,
            });
            if (error) {
              throw toAPIError(error);
            }
          },
        );
        const optOutTasks = catalogueSetupPlan.nativeToolOptOuts.map(
          async (entry) => {
            const { error } = await api.mcp["native-tools"]({
              slug: entry.backendSlug,
            }).patch({ enabled: false });
            if (error) {
              throw toAPIError(error);
            }
          },
        );
        const catalogueTasks = [...installTasks, ...optOutTasks];
        if (catalogueTasks.length > 0) {
          const catalogueResults = await Promise.allSettled(catalogueTasks);
          const installResults = catalogueResults.slice(0, installTasks.length);
          const failedInstallCount = installResults.filter(
            (r) => r.status === "rejected",
          ).length;
          const failed = catalogueResults.filter(
            (r) => r.status === "rejected",
          ).length;
          if (failed > 0) {
            stellaToast.add({
              title: t("onboarding.cataloguePartial", {
                installed: String(installTasks.length - failedInstallCount),
                failed: String(failed),
              }),
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
          const { error: aiConfigError } = await api["organization-settings"][
            "ai-config"
          ].post({
            providers: serializeProviderDrafts(finalData.aiProviders),
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
          const inviteResults = await Promise.all(
            finalData.emails.map(
              async (email) =>
                await authClient.organization.inviteMember({
                  email,
                  role: "member",
                }),
            ),
          );

          const failedCount = inviteResults.filter(
            (r) => r.error !== null,
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
      } catch (error) {
        analytics.captureError(error);
      }

      setIsCreating(false);
      setStep("download");
    },
    [
      analytics,
      queryClient,
      setIsCreating,
      t,
      unavailableNativeToolBackendSlugs,
    ],
  );

  let preview = (
    <SidebarPreview
      aiProviders={previewAiProviders}
      chatActive={step === "ai"}
      emailCount={previewEmailCount}
      matterName=""
      organizationName={previewOrgName}
    />
  );
  if (step === "jurisdiction") {
    preview = (
      <JurisdictionGlobePreview
        onChange={(practiceJurisdictions) => {
          setData((d) => ({ ...d, practiceJurisdictions }));
          setJurisdictionSuggestionApplied(true);
        }}
        selected={data.practiceJurisdictions}
      />
    );
  } else if (step === "catalogue") {
    const focusedEntry = catalogueFocusedSlug
      ? onboardingCatalogueEntries.find(
          (entry) => entry.slug === catalogueFocusedSlug,
        )
      : undefined;
    if (focusedEntry) {
      const installed = data.catalogueSlugs.includes(focusedEntry.slug);
      preview = (
        <CatalogueDetailPreview
          entry={focusedEntry}
          installed={installed}
          onCancel={() => setCatalogueFocusedSlug(null)}
          onConfirm={() => {
            const next = new Set(data.catalogueSlugs);
            if (installed) {
              next.delete(focusedEntry.slug);
              setCatalogueSlugRemoved(focusedEntry.slug, true);
            } else {
              next.add(focusedEntry.slug);
              setCatalogueSlugRemoved(focusedEntry.slug, false);
            }
            setData((d) => ({ ...d, catalogueSlugs: [...next] }));
            setCatalogueFocusedSlug(null);
          }}
        />
      );
    } else {
      preview = (
        <CatalogueStackPreview
          entries={onboardingCatalogueEntries}
          onFocus={setCatalogueFocusedSlug}
          selectedSlugs={data.catalogueSlugs}
        />
      );
    }
  } else if (step === "download") {
    preview = <DownloadSetupPreview target={downloadTarget} />;
  }

  const renderStep = () => {
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
            onNext={continueFromJurisdiction}
            onSkip={() => {
              setData((d) => ({
                ...d,
                catalogueSlugs: [],
                practiceJurisdictions: [],
              }));
              setJurisdictionSuggestionApplied(true);
              setCatalogueFocusedSlug(null);
              setStep("catalogue");
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "catalogue") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.catalogue}
          onBack={() => setStep("jurisdiction")}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <CatalogueStep
            focusedSlug={catalogueFocusedSlug}
            onAdd={(slug) => {
              setCatalogueSlugRemoved(slug, false);
              setData((d) => {
                if (d.catalogueSlugs.includes(slug)) {
                  return d;
                }
                return { ...d, catalogueSlugs: [...d.catalogueSlugs, slug] };
              });
            }}
            onFocusChange={setCatalogueFocusedSlug}
            onNext={() => setStep("ai")}
            onRemove={(slug) => {
              setCatalogueSlugRemoved(slug, true);
              setData((d) => ({
                ...d,
                catalogueSlugs: d.catalogueSlugs.filter((s) => s !== slug),
              }));
              if (catalogueFocusedSlug === slug) {
                setCatalogueFocusedSlug(null);
              }
            }}
            onSkip={() => {
              markCatalogueSlugsRemoved(data.catalogueSlugs);
              setData((d) => ({ ...d, catalogueSlugs: [] }));
              setStep("ai");
            }}
            practiceJurisdictions={data.practiceJurisdictions}
            selectedSlugs={data.catalogueSlugs}
            unavailableNativeToolBackendSlugs={
              unavailableNativeToolBackendSlugs
            }
          />
        </OnboardingLayout>
      );
    }

    if (step === "invite") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.invite}
          preview={preview}
          totalSteps={TOTAL_STEPS}
          {...(isCreating ? {} : { onBack: () => setStep("ai") })}
        >
          <InviteStep
            isSubmitting={isCreating}
            onEmailCountChange={setPreviewEmailCount}
            userEmail={userEmail}
            onNext={({ emails }) => {
              const finalData = { ...data, emails };
              setData(finalData);
              detached(
                executeSetup(finalData),
                "onboarding-wizard.execute-setup",
              );
            }}
          />
        </OnboardingLayout>
      );
    }

    if (step === "ai") {
      return (
        <OnboardingLayout
          currentStep={STEP_TO_PROGRESS.ai}
          onBack={() => setStep("catalogue")}
          preview={preview}
          totalSteps={TOTAL_STEPS}
        >
          <AIStep
            onNext={() => setStep("invite")}
            onPreviewChange={setPreviewAiProviders}
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
          />
        </OnboardingLayout>
      );
    }

    // step === "download": the org already exists by this point, so there
    // is no back affordance and no further setup to run — the buttons just
    // land the user in the app.
    return (
      <OnboardingLayout
        currentStep={STEP_TO_PROGRESS.download}
        preview={preview}
        totalSteps={TOTAL_STEPS}
      >
        <DownloadStep
          onSelect={setDownloadTarget}
          selected={downloadTarget}
          onNext={() => {
            detached(
              navigate({ to: "/chat", replace: true }),
              "onboarding-wizard.navigate",
            );
          }}
          onSkip={() => {
            detached(
              navigate({ to: "/chat", replace: true }),
              "onboarding-wizard.navigate",
            );
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
