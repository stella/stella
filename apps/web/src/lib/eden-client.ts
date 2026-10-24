import { createStellaEdenClient } from "@stll/api-client";
import type { EdenRoutesApp, StellaEdenClientOptions } from "@stll/api-client";

import type {
  CorrespondenceRoutes,
  MemoriesRoutes,
  MyTimeEntriesRoutes,
  WebRoutes,
} from "@/generated/api-routes.gen";
import { getTranslator } from "@/i18n/translator";
import { reportUnhandledMeResponse } from "@/lib/account/auth-code-report";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { browserApiBaseUrl } from "@/lib/api-url";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { observeActionAdmissionResponse } from "@/lib/errors/action-admission-response";
import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";

export type WebApiRoutes = WebRoutes["v1"];

// Types the API owns and the browser reads by name, re-exported through the
// generated API types.
export type {
  AskManual,
  CapabilityId,
  DeterministicCheck,
  FallbackEntry,
  GlobalSearchHit,
  GradedPosition,
  IdealLanguage,
  LegalListSourceLocator,
  Negotiation,
  PlaybookScope,
  PlaybookTrigger,
  Position,
  PositionDecisionSummary,
  PositionSeverity,
  PositionStandard,
  PositionStandardSource,
  ReferencePassage,
  TierRule,
  ViewLayout,
  ViewSort,
  ViewTemplateProperty,
} from "@/generated/api-routes.gen";

export const webApiClientOptions = {
  async onRequest() {
    await waitForSimulatedApiDelay();
  },
  headers: getApiRequestHeaders,
  async onScopedResponse({ response, scope }) {
    await reportUnhandledMeResponse(response, reportUserVisibleError);
    await observeActionAdmissionResponse(response, {
      // Only a refusal is announced here; the caller's own handler owns every
      // other failed response.
      notifyRefusal: (error) =>
        actionAdmissionOutcome(error) !== undefined &&
        notifyUserError(error, getTranslator()("errors.actionFailed")),
      captureError: (error) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "onResponse:failure",
          scope,
        });
      },
    });
  },
} satisfies StellaEdenClientOptions;

const eden = createStellaEdenClient<EdenRoutesApp<WebRoutes>>(
  browserApiBaseUrl(),
  webApiClientOptions,
);
const linkIconsEden = createStellaEdenClient<EdenRoutesApp<WebRoutes>>(
  browserApiBaseUrl(),
  {
    ...webApiClientOptions,
    async onResponse(response) {
      const mime = response.headers.get("content-type")?.split(";").at(0);
      if (response.ok && (mime === "image/png" || mime === "image/x-icon")) {
        return await response.blob();
      }
      return undefined;
    },
  },
);
const memoriesEden = createStellaEdenClient<EdenRoutesApp<MemoriesRoutes>>(
  browserApiBaseUrl(),
  webApiClientOptions,
);
const correspondenceEden = createStellaEdenClient<
  EdenRoutesApp<CorrespondenceRoutes>
>(browserApiBaseUrl(), webApiClientOptions);
const myTimeEntriesEden = createStellaEdenClient<
  EdenRoutesApp<MyTimeEntriesRoutes>
>(browserApiBaseUrl(), webApiClientOptions);

export const api = eden.v1;
export const linkIconsApi = linkIconsEden.v1.chat["link-icons"];
export const publicFeedbackApi = eden.public.feedback;
export const memoriesApi = memoriesEden.v1.memories;
export const correspondenceApi = correspondenceEden.v1;
export const myTimeEntriesApi = myTimeEntriesEden.v1["time-entries"].me;
