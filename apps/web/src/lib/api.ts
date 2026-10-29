import { createApiClient } from "@stll/api-client";
import type { ApiClientOptions } from "@stll/api-client";
import type { ConnectConnectorDecision } from "@stll/api-contract/chat-connector";
import { INTERNAL_UI_TRANSPORT_ROUTES } from "@stll/api-contract/internal-ui-transport";
import type { Microsoft365Capability } from "@stll/api-contract/microsoft365";
import { fetchWithTimeout } from "@stll/fetch";

import type { WebRoutes } from "@/generated/api-routes.gen";
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
import { apiResponseResult, unwrapApiResponse } from "@/lib/errors/api";
import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";
import type { SafeId } from "@/lib/safe-id";

export type WebApiRoutes = WebRoutes["v1"];

const WEB_API_REQUEST_TIMEOUT_MS = 30_000;

type WebApiFetcherOwner = typeof fetchWithTimeout;
type ApiClientFetcher = NonNullable<ApiClientOptions["fetcher"]>;

export const createWebApiFetcher =
  (fetcher: WebApiFetcherOwner) =>
  async (
    url: Parameters<WebApiFetcherOwner>[0],
    { timeoutMs, signal, ...init }: Parameters<ApiClientFetcher>[1],
  ) =>
    await fetcher(url, {
      ...init,
      signal: signal ?? undefined,
      timeout: {
        type: "total",
        ms: timeoutMs ?? WEB_API_REQUEST_TIMEOUT_MS,
      },
    });

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
  fetcher: createWebApiFetcher(fetchWithTimeout),
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
} satisfies ApiClientOptions;

/** The whole API, from its origin: `apiClient.public.feedback`, `apiClient.v1`. */
export const apiClient = createApiClient<WebRoutes>(
  browserApiBaseUrl(),
  webApiClientOptions,
);

/** The versioned API every product call goes through. */
export const api = apiClient.v1;

/** Browser dispatches to mounted internal routes; the API authorizes each request. */
export const mcpConnectorConnection = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.mcpConnectorConnect,
  start: async (slug: string) =>
    unwrapApiResponse(await api.mcp.connectors({ slug }).connect.post({})),
} as const;

type SubmitChatConnectorReceiptOptions = {
  threadId: SafeId<"chatThread">;
  toolCallId: string;
  decision: ConnectConnectorDecision;
};

export const chatConnectorReceipt = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.chatConnectorReceipt,
  submit: async ({
    threadId,
    toolCallId,
    decision,
  }: SubmitChatConnectorReceiptOptions) =>
    unwrapApiResponse(
      await api.chat
        .threads({ threadId })
        .connectors({ toolCallId })
        .post({ decision }),
    ),
} as const;

export const sharepointConnect = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.sharepointConnect,
  start: async (capability: Microsoft365Capability) =>
    apiResponseResult(
      await api.sharepoint.connect.post({ capabilities: [capability] }),
    ),
} as const;

export const sharepointCapabilities = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.sharepointCapabilities,
  update: async (capabilities: Microsoft365Capability[]) =>
    apiResponseResult(await api.sharepoint.capabilities.put({ capabilities })),
} as const;

export const sharepointDisable = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.sharepointDisable,
  disable: async () =>
    apiResponseResult(await api.sharepoint.enablement.put({ enabled: false })),
} as const;

export const sharepointDisconnect = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.sharepointDisconnect,
  disconnect: async () =>
    apiResponseResult(await api.sharepoint.connection.delete()),
} as const;
