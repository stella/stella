import { createStellaEdenClient } from "@stll/api-client";
import type { MemoriesAPI, WebAPI } from "@stll/api/eden-contract";

import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { browserApiBaseUrl } from "@/lib/api-url";

export type WebApiRoutes = WebAPI["~Routes"]["v1"];

// Types the API owns and the browser reads by name, re-exported through the
// one module allowed to import the API's Eden contract.
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
} from "@stll/api/eden-contract";

const clientOptions = {
  async onRequest() {
    await waitForSimulatedApiDelay();
  },
  headers: getApiRequestHeaders,
};

const eden = createStellaEdenClient<WebAPI>(browserApiBaseUrl(), clientOptions);
const memoriesEden = createStellaEdenClient<MemoriesAPI>(
  browserApiBaseUrl(),
  clientOptions,
);

export const api = eden.v1;
export const memoriesApi = memoriesEden.v1.memories;
