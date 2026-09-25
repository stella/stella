import { createStellaEdenClient } from "@stll/api-client";
import type { EdenRoutesApp } from "@stll/api-client";

import type { MemoriesRoutes, WebRoutes } from "@/generated/api-routes.gen";
import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { browserApiBaseUrl } from "@/lib/api-url";

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
};

const eden = createStellaEdenClient<EdenRoutesApp<WebRoutes>>(
  browserApiBaseUrl(),
  clientOptions,
);
const memoriesEden = createStellaEdenClient<EdenRoutesApp<MemoriesRoutes>>(
  browserApiBaseUrl(),
  clientOptions,
);

export const api = eden.v1;
export const publicFeedbackApi = eden.public.feedback;
export const memoriesApi = memoriesEden.v1.memories;
