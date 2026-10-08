import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type {
  RequestSecretInput,
  RequestSecretOutput,
} from "@stll/api-contract/chat-secret";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import type {
  RequestSecretDecision,
  SecretTargetResolution,
} from "@/components/chat/chat-approval-context";
import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";
import { RequestSecretCard } from "@/components/chat/request-secret-card";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");

type RequestSecretPart = Extract<
  RegisteredChatUIToolCallPart,
  { name: "request_secret" }
>;

const input = {
  purpose: "Authenticate the sample connector",
  kind: "token",
  target: { type: "mcp-connector", connectorSlug: "sample-connector" },
} satisfies RequestSecretInput;

const pendingPart = (): RequestSecretPart => ({
  arguments: JSON.stringify(input),
  id: "sample-request-call",
  input,
  name: "request_secret",
  state: "input-complete",
  type: "tool-call",
});

const providedOutput = {
  status: "provided",
  secretRef: "00000000-0000-4000-8000-000000000001",
  target: input.target,
} satisfies RequestSecretOutput;

const declineOutput = {
  status: "declined",
  target: input.target,
} satisfies RequestSecretOutput;

const mountCard = ({
  resolveSecretTarget = async () => ({
    available: false,
    connector: {
      connectionId: "sample-connection",
      displayName: "Sample connector",
      host: "sample.test",
      responseDisposition: "normal",
    },
  }),
  handleRequestSecret = async () => declineOutput,
  continueRequestSecret = async () => {},
}: {
  resolveSecretTarget?: (
    connectorSlug: string,
    signal: AbortSignal,
  ) => Promise<SecretTargetResolution>;
  handleRequestSecret?: (
    toolCallId: string,
    decision: RequestSecretDecision,
  ) => Promise<RequestSecretOutput>;
  continueRequestSecret?: (
    toolCallId: string,
    receipt: RequestSecretOutput,
  ) => Promise<void>;
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const renderCard = (part: RequestSecretPart) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatApprovalContext
          value={{
            activeOrganizationId: "sample-organization",
            alwaysApprovedTools: new Set(),
            conversationApprovedTools: new Set(),
            handleAllowInConversation: () => {},
            handleAlwaysAllow: () => {},
            handleApprove: () => {},
            handleDeny: () => {},
            handleRequestSecret,
            continueRequestSecret,
            secretAvailabilityKey: "sample-thread",
            resolveSecretTarget,
          }}
        >
          <RequestSecretCard isAwaitingUser part={part} />
        </ChatApprovalContext>
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = render(renderCard(pendingPart()));
  return { queryClient, renderCard, view };
};

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("request secret card", () => {
  test("provides the entered value and renders the completed status", async () => {
    const submissions: {
      toolCallId: string;
      decision: unknown;
    }[] = [];
    const { queryClient, renderCard, view } = mountCard({
      handleRequestSecret: async (toolCallId, decision) => {
        submissions.push({ toolCallId, decision });
        return providedOutput;
      },
    });

    const credentialField = await screen.findByLabelText(
      messages.chat.requestSecret.valueLabel,
    );
    expect(
      screen.getByText(
        messages.chat.requestSecret.purposeByAi.replace(
          "{purpose}",
          () => input.purpose,
        ),
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Target: Sample connector (sample.test)"),
    ).not.toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: messages.chat.requestSecret.saveForFuture,
      }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: messages.chat.requestSecret.replaceOrdinaryConnection,
      }),
    ).toBeNull();
    expect(credentialField.getAttribute("type")).toBe("password");
    fireEvent.change(credentialField, { target: { value: "sample-value" } });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.chat.requestSecret.provideAction,
        }),
      ),
    );

    expect(submissions).toEqual([
      {
        toolCallId: "sample-request-call",
        decision: {
          decision: "provide",
          value: "sample-value",
          saveForFuture: false,
          normalConnectionAction: "preserve",
          targetConnection: {
            connectionId: "sample-connection",
            host: "sample.test",
          },
        },
      },
    ]);

    const completedPart: RequestSecretPart = {
      arguments: JSON.stringify(input),
      id: "sample-request-call",
      input,
      name: "request_secret",
      output: providedOutput,
      state: "complete",
      type: "tool-call",
    };
    await act(async () => view.rerender(renderCard(completedPart)));
    expect(
      screen.getByText(messages.chat.requestSecret.provided),
    ).not.toBeNull();
    queryClient.clear();
  });

  test("retries only the chat continuation after the credential was accepted", async () => {
    const submissions: RequestSecretDecision[] = [];
    const continuations: {
      toolCallId: string;
      receipt: RequestSecretOutput;
    }[] = [];
    const { queryClient } = mountCard({
      handleRequestSecret: async (_toolCallId, decision) => {
        submissions.push(decision);
        return providedOutput;
      },
      continueRequestSecret: async (toolCallId, receipt) => {
        continuations.push({ toolCallId, receipt });
        if (continuations.length === 1) {
          throw new Error("continuation unavailable");
        }
      },
    });

    const credentialField = await screen.findByLabelText(
      messages.chat.requestSecret.valueLabel,
    );
    fireEvent.change(credentialField, { target: { value: "sample-value" } });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.chat.requestSecret.provideAction,
        }),
      ),
    );

    expect(
      await screen.findByText(messages.chat.requestSecret.continuationError),
    ).not.toBeNull();
    expect(
      screen.getByText(messages.chat.requestSecret.provided),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: messages.common.decline }),
    ).toBeNull();
    expect(
      screen.queryByLabelText(messages.chat.requestSecret.valueLabel),
    ).toBeNull();

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.chat.requestSecret.retryContinuationAction,
        }),
      ),
    );

    expect(submissions).toHaveLength(1);
    expect(continuations).toEqual([
      { toolCallId: "sample-request-call", receipt: providedOutput },
      { toolCallId: "sample-request-call", receipt: providedOutput },
    ]);
    expect(
      screen.queryByText(messages.chat.requestSecret.continuationError),
    ).toBeNull();
    queryClient.clear();
  });

  test("keeps the continuation retry after the tool part completed", async () => {
    const submissions: RequestSecretDecision[] = [];
    const continuations: RequestSecretOutput[] = [];
    let rejectFirst: (reason: Error) => void = () => {
      throw new Error("continuation not started");
    };
    const { queryClient, renderCard, view } = mountCard({
      handleRequestSecret: async (_toolCallId, decision) => {
        submissions.push(decision);
        return providedOutput;
      },
      continueRequestSecret: (_toolCallId, receipt) => {
        continuations.push(receipt);
        if (continuations.length > 1) {
          return Promise.resolve();
        }
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      },
    });

    const credentialField = await screen.findByLabelText(
      messages.chat.requestSecret.valueLabel,
    );
    fireEvent.change(credentialField, { target: { value: "sample-value" } });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.chat.requestSecret.provideAction,
        }),
      ),
    );
    // addToolResult completes the part before the chat resumes.
    const completedPart: RequestSecretPart = {
      ...pendingPart(),
      output: providedOutput,
      state: "complete",
    };
    await act(async () => view.rerender(renderCard(completedPart)));
    await act(async () => rejectFirst(new Error("continuation unavailable")));

    expect(
      await screen.findByText(messages.chat.requestSecret.continuationError),
    ).not.toBeNull();
    expect(
      screen.getByText(messages.chat.requestSecret.provided),
    ).not.toBeNull();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.chat.requestSecret.retryContinuationAction,
        }),
      ),
    );

    expect(submissions).toHaveLength(1);
    expect(continuations).toEqual([providedOutput, providedOutput]);
    expect(
      screen.queryByRole("button", {
        name: messages.chat.requestSecret.retryContinuationAction,
      }),
    ).toBeNull();
    expect(
      screen.getByText(messages.chat.requestSecret.provided),
    ).not.toBeNull();
    queryClient.clear();
  });

  test("requires confirmation before replacing a normal connection", async () => {
    const submissions: RequestSecretDecision[] = [];
    const { queryClient } = mountCard({
      handleRequestSecret: async (_toolCallId, decision) => {
        submissions.push(decision);
        return providedOutput;
      },
    });

    const credentialField = await screen.findByLabelText(
      messages.chat.requestSecret.valueLabel,
    );
    fireEvent.change(credentialField, { target: { value: "sample-value" } });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: messages.chat.requestSecret.saveForFuture,
      }),
    );
    const provideButton = screen.getByRole("button", {
      name: messages.chat.requestSecret.provideAction,
    });
    expect(provideButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: messages.chat.requestSecret.replaceOrdinaryConnection,
      }),
    );
    expect(provideButton.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(provideButton));

    expect(submissions).toEqual([
      {
        decision: "provide",
        value: "sample-value",
        saveForFuture: true,
        normalConnectionAction: "replace-with-receipt-only",
        targetConnection: {
          connectionId: "sample-connection",
          host: "sample.test",
        },
      },
    ]);
    queryClient.clear();
  });

  test("submits a decline decision", async () => {
    const submissions: unknown[] = [];
    const { queryClient } = mountCard({
      handleRequestSecret: async (_toolCallId, decision) => {
        submissions.push(decision);
        return declineOutput;
      },
    });

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.decline }),
      ),
    );

    expect(submissions).toEqual([{ decision: "decline" }]);
    queryClient.clear();
  });

  test("offers an available saved credential and submits that choice", async () => {
    const submissions: unknown[] = [];
    const { queryClient } = mountCard({
      resolveSecretTarget: async () => ({
        available: true,
        connector: {
          connectionId: "sample-connection",
          displayName: "Sample connector",
          host: "sample.test",
          responseDisposition: "receipt-only",
        },
      }),
      handleRequestSecret: async (_toolCallId, decision) => {
        submissions.push(decision);
        return providedOutput;
      },
    });

    const useSavedButton = await screen.findByRole("button", {
      name: messages.chat.requestSecret.useSavedAction,
    });
    expect(
      screen.getByRole("checkbox", {
        name: messages.chat.requestSecret.saveForFuture,
      }),
    ).not.toBeNull();
    await act(async () => fireEvent.click(useSavedButton));

    expect(submissions).toEqual([
      {
        decision: "use-saved",
        targetConnection: {
          connectionId: "sample-connection",
          host: "sample.test",
        },
      },
    ]);
    queryClient.clear();
  });

  test("shows a generic alert when saved credential availability fails", async () => {
    const { queryClient } = mountCard({
      resolveSecretTarget: async () => {
        throw new Error("availability unavailable");
      },
    });

    expect(
      await screen.findByText(
        messages.chat.requestSecret.savedAvailabilityError,
      ),
    ).not.toBeNull();
    queryClient.clear();
  });
});
