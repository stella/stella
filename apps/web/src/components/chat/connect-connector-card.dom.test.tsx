import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { CONNECT_CONNECTOR_NOT_CONNECTED_CODE } from "@stll/api-contract/chat-connector";
import type {
  ConnectConnectorDecision,
  ConnectConnectorInput,
  ConnectConnectorOutput,
} from "@stll/api-contract/chat-connector";
import { toSafeId } from "@stll/api-contract/safe-id";

import messages from "@/i18n/langs/en.json";
import type { McpConnectorsResponse } from "@/lib/knowledge/queries";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const authorizeUrl = "https://sign-in.example.test/authorize";
const connectorSlug = "sample-connector";
const catalog = {
  canManageCustomConnectors: false,
  connectors: [
    {
      id: toSafeId<"mcpConnector">("018f0000-0000-7000-8000-000000000010"),
      slug: connectorSlug,
      organizationId: null,
      displayName: "Sample source",
      description: "",
      url: "https://connector.example.test/mcp",
      authType: "oauth2" as const,
      isCurated: true,
      oauthRequestedScopes: ["read:documents"],
      allowedTools: null,
      documentationUrl: null,
      tokenHelpUrl: null,
      iconUrl: null,
      authorizationStatus: "approved" as const,
      authorizationReview: null,
      isRecommended: false,
      recommendedJurisdictions: [],
    },
  ],
  nativeTools: [],
} satisfies McpConnectorsResponse;

const requests: { method: string; url: string }[] = [];
let catalogResponse: Promise<Response> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      input instanceof Request ? input.method : (init?.method ?? "GET");
    requests.push({ method, url });
    if (url.endsWith(`/mcp/connectors/${connectorSlug}/connect`)) {
      return await Promise.resolve(
        Response.json({ type: "oauth2", authorizeUrl }),
      );
    }
    return await (catalogResponse ?? Promise.resolve(Response.json(catalog)));
  },
  { preconnect: () => undefined },
);
const opened: string[] = [];
window.open = (url?: string | URL) => {
  opened.push(String(url));
  return window;
};

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { testChatApprovalContextValue } =
  await import("@/components/chat/chat-approval-context.test-fixtures");
const { ConnectConnectorCard } =
  await import("@/components/chat/connect-connector-card");
const { mcpConnectorsOptions } = await import("@/lib/knowledge/queries");
const { APIError } = await import("@/lib/errors/api");
const { broadcastMcpOAuthOutcome } = await import("@/lib/mcp-oauth-channel");

type ConnectConnectorPart = Parameters<typeof ConnectConnectorCard>[0]["part"];

const input = {
  connectorSlug,
  purpose: "Search the sample source for the cited decision",
} satisfies ConnectConnectorInput;

const pendingPart = (): ConnectConnectorPart => ({
  arguments: JSON.stringify(input),
  id: "sample-connector-call",
  input,
  name: "connect_connector",
  state: "input-complete",
  type: "tool-call",
});

const mountCard = ({
  handleConnectConnector,
  continueConnectConnector = async () => {},
}: {
  handleConnectConnector: (
    toolCallId: string,
    decision: ConnectConnectorDecision,
  ) => Promise<ConnectConnectorOutput>;
  continueConnectConnector?: (
    toolCallId: string,
    receipt: ConnectConnectorOutput,
  ) => Promise<void>;
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const organizationId = testChatApprovalContextValue.activeOrganizationId;
  queryClient.setQueryData(
    mcpConnectorsOptions(organizationId).queryKey,
    catalog,
  );
  const renderCard = (part: ConnectConnectorPart) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext
          value={{
            ...testChatApprovalContextValue,
            handleConnectConnector,
            continueConnectConnector,
          }}
        >
          <ConnectConnectorCard isAwaitingUser part={part} />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(renderCard(pendingPart()));
  return { queryClient, renderCard, view };
};

const text = (template: string, values: Record<string, string>) =>
  template.replaceAll(
    /\{(\w+)\}/gu,
    (_match, name: string) => values[name] ?? "",
  );

afterEach(async () => {
  requests.length = 0;
  opened.length = 0;
  catalogResponse = undefined;
  await act(async () => cleanup());
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("connect connector card", () => {
  test("shows the connector, the assistant's purpose and the requested access", () => {
    const { queryClient } = mountCard({
      handleConnectConnector: async () =>
        await Promise.resolve({ status: "declined", connectorSlug }),
    });

    expect(
      screen.getByText(
        text(messages.chat.connectConnector.description, {
          connector: "Sample source",
        }),
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        text(messages.chat.requestSecret.purposeByAi, {
          purpose: input.purpose,
        }),
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        text(messages.chat.connectConnector.scopes, {
          scopes: "read:documents",
        }),
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: messages.common.connect }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: messages.common.notNow,
      }),
    ).not.toBeNull();
    queryClient.clear();
  });

  test("not now answers declined and continues with the receipt", async () => {
    const decisions: ConnectConnectorDecision[] = [];
    const continuations: ConnectConnectorOutput[] = [];
    const declined = { status: "declined", connectorSlug } as const;
    const { queryClient, renderCard, view } = mountCard({
      handleConnectConnector: async (_toolCallId, decision) => {
        decisions.push(decision);
        return await Promise.resolve(declined);
      },
      continueConnectConnector: async (_toolCallId, receipt) => {
        continuations.push(receipt);
        await Promise.resolve();
      },
    });

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.common.notNow,
        }),
      ),
    );
    expect(decisions).toEqual(["declined"]);
    expect(continuations).toEqual([declined]);
    expect(requests).toEqual([]);

    await act(async () =>
      view.rerender(
        renderCard({ ...pendingPart(), output: declined, state: "complete" }),
      ),
    );
    expect(screen.getByText(messages.common.notConnected)).not.toBeNull();
    queryClient.clear();
  });

  test("a sign-in outcome asks the server to confirm the connection", async () => {
    const decisions: ConnectConnectorDecision[] = [];
    const connected = { status: "connected", connectorSlug } as const;
    const continuations: ConnectConnectorOutput[] = [];
    const { queryClient } = mountCard({
      handleConnectConnector: async (_toolCallId, decision) => {
        decisions.push(decision);
        return await Promise.resolve(connected);
      },
      continueConnectConnector: async (_toolCallId, receipt) => {
        continuations.push(receipt);
        await Promise.resolve();
      },
    });

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.connect }),
      ),
    );
    await screen.findByText(messages.chat.connectConnector.waiting);
    expect(opened).toEqual([authorizeUrl]);
    expect(requests).toContainEqual({
      method: "POST",
      url: `http://localhost:3001/v1/mcp/connectors/${connectorSlug}/connect`,
    });
    expect(decisions).toEqual([]);

    await act(async () => broadcastMcpOAuthOutcome({ status: "connected" }));
    await waitFor(() => expect(continuations).toEqual([connected]));
    expect(decisions).toEqual(["connected"]);
    queryClient.clear();
  });

  test("a failed catalog refresh leaves the connector request answerable", async () => {
    const decisions: ConnectConnectorDecision[] = [];
    const declined = { status: "declined", connectorSlug } as const;
    const continuations: ConnectConnectorOutput[] = [];
    const { queryClient } = mountCard({
      handleConnectConnector: async (_toolCallId, decision) => {
        decisions.push(decision);
        return await Promise.resolve(declined);
      },
      continueConnectConnector: async (_toolCallId, receipt) => {
        continuations.push(receipt);
        await Promise.resolve();
      },
    });
    const invalidation = spyOn(
      queryClient,
      "invalidateQueries",
    ).mockRejectedValueOnce(new Error("Catalog refresh failed"));
    try {
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.connect }),
        ),
      );
      await screen.findByText(messages.chat.connectConnector.waiting);
      await act(async () => broadcastMcpOAuthOutcome({ status: "connected" }));
      await screen.findByText(messages.common.somethingWentWrong);
      expect(invalidation).toHaveBeenCalledTimes(1);
      expect(decisions).toEqual([]);

      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.notNow }),
        ),
      );
      await waitFor(() => expect(continuations).toEqual([declined]));
      expect(decisions).toEqual(["declined"]);
    } finally {
      invalidation.mockRestore();
      queryClient.clear();
    }
  });

  test("the first answer wins while connection confirmation refreshes", async () => {
    const decisions: ConnectConnectorDecision[] = [];
    const connected = { status: "connected", connectorSlug } as const;
    const continuations: ConnectConnectorOutput[] = [];
    const { queryClient } = mountCard({
      handleConnectConnector: async (_toolCallId, decision) => {
        decisions.push(decision);
        return await Promise.resolve(connected);
      },
      continueConnectConnector: async (_toolCallId, receipt) => {
        continuations.push(receipt);
        await Promise.resolve();
      },
    });

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.connect }),
      ),
    );
    await screen.findByText(messages.chat.connectConnector.waiting);

    const invalidation = Promise.withResolvers<Response>();
    catalogResponse = invalidation.promise;
    await act(async () => broadcastMcpOAuthOutcome({ status: "connected" }));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.notNow }),
      ),
    );
    expect(decisions).toEqual([]);

    invalidation.resolve(Response.json(catalog));
    await waitFor(() => expect(continuations).toEqual([connected]));
    expect(decisions).toEqual(["connected"]);
    expect(continuations).toEqual([connected]);
    queryClient.clear();
  });

  test.each([
    {
      error: new APIError({
        status: 409,
        code: CONNECT_CONNECTOR_NOT_CONNECTED_CODE,
        message: "Not connected",
      }),
      message: messages.chat.connectConnector.notConnected,
    },
    {
      error: new APIError({ status: 503, message: "Unavailable" }),
      message: messages.common.somethingWentWrong,
    },
  ])(
    "a failed confirmation keeps the card answerable: $error.status",
    async ({ error, message }) => {
      const decisions: ConnectConnectorDecision[] = [];
      const { queryClient } = mountCard({
        handleConnectConnector: async (_toolCallId, decision) => {
          decisions.push(decision);
          return await Promise.reject(error);
        },
      });

      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.connect }),
        ),
      );
      await screen.findByText(messages.chat.connectConnector.waiting);
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.chat.connectConnector.checkAction,
          }),
        ),
      );
      await screen.findByText(message);
      expect(decisions).toEqual(["connected"]);
      expect(
        screen.getByRole("button", {
          name: messages.common.notNow,
        }),
      ).not.toBeNull();
      queryClient.clear();
    },
  );
});
