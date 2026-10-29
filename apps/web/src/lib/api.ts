import { panic } from "better-result";

import { createApiClient } from "@stll/api-client";
import type { ApiClientOptions } from "@stll/api-client";
import type { ConnectConnectorDecision } from "@stll/api-contract/chat-connector";
import { INTERNAL_UI_TRANSPORT_ROUTES } from "@stll/api-contract/internal-ui-transport";

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
import { unwrapApiResponse } from "@/lib/errors/api";
import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";
import type { SafeId } from "@/lib/safe-id";

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
} satisfies ApiClientOptions;

/** The whole API, from its origin: `apiClient.public.feedback`, `apiClient.v1`. */
export const apiClient = createApiClient<WebRoutes>(
  browserApiBaseUrl(),
  webApiClientOptions,
);

/** The versioned API every product call goes through. */
export const api = apiClient.v1;

/** POST keeps the link credential out of URLs; the token authorizes a document read. */
export const invoiceLinkView = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.invoiceLinkView,
  open: async (token: string) =>
    unwrapApiResponse(
      await apiClient.public["invoice-links"].view.post(
        { token },
        { fetch: { credentials: "omit" } },
      ),
    ),
} as const;

type InvoiceLinkDownloadOptions = Parameters<
  (typeof apiClient)["public"]["invoice-links"]["download"]["post"]
>[0];

/** The typed client decodes document media as a Blob, text, or ArrayBuffer. */
export const invoiceLinkDownload = {
  route: INTERNAL_UI_TRANSPORT_ROUTES.invoiceLinkDownload,
  open: async ({ token, file }: InvoiceLinkDownloadOptions) => {
    const response = await apiClient.public["invoice-links"].download.post(
      { token, file },
      { fetch: { credentials: "omit", signal: AbortSignal.timeout(60_000) } },
    );
    const content: unknown = unwrapApiResponse(response);
    if (content instanceof Blob) {
      return content;
    }
    if (typeof content === "string" || content instanceof ArrayBuffer) {
      return new Blob([content], {
        type:
          response.headers.get("content-type") ?? "application/octet-stream",
      });
    }
    return panic(
      "Invoice document transport returned an unexpected media body",
    );
  },
} as const;

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
