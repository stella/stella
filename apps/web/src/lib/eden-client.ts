import { createStellaEdenClient } from "@stll/api-client";
import type { EdenRoutesApp, StellaEdenClientOptions } from "@stll/api-client";

import { notifyActionAdmissionRefusal } from "@/components/action-admission-outcome";
import type {
  CorrespondenceRoutes,
  MemoriesRoutes,
  MyTimeEntriesRoutes,
  WebRoutes,
} from "@/generated/api-routes.gen";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { browserApiBaseUrl } from "@/lib/api-url";
import { observeActionAdmissionResponse } from "@/lib/errors/action-admission-response";

export type WebApiRoutes = WebRoutes["v1"];

// Types the API owns and the browser reads by name, re-exported through the
// generated API types.
export type {
  AskManual,
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

const clientOptions = {
  async onRequest() {
    await waitForSimulatedApiDelay();
  },
  headers: getApiRequestHeaders,
  async onResponse(response) {
    await observeActionAdmissionResponse(response, {
      notifyRefusal: notifyActionAdmissionRefusal,
      captureError: (error) => {
        getAnalytics().captureError(error);
      },
    });
  },
} satisfies StellaEdenClientOptions;

const eden = createStellaEdenClient<EdenRoutesApp<WebRoutes>>(
  browserApiBaseUrl(),
  clientOptions,
);
const memoriesEden = createStellaEdenClient<EdenRoutesApp<MemoriesRoutes>>(
  browserApiBaseUrl(),
  clientOptions,
);
const correspondenceEden = createStellaEdenClient<
  EdenRoutesApp<CorrespondenceRoutes>
>(browserApiBaseUrl(), clientOptions);
const myTimeEntriesEden = createStellaEdenClient<
  EdenRoutesApp<MyTimeEntriesRoutes>
>(browserApiBaseUrl(), clientOptions);

export const api = eden.v1;
export const publicFeedbackApi = eden.public.feedback;
export const memoriesApi = memoriesEden.v1.memories;
export const correspondenceApi = correspondenceEden.v1;
export const myTimeEntriesApi = myTimeEntriesEden.v1["time-entries"].me;
