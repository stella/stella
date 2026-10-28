import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { CONNECT_CONNECTOR_NOT_CONNECTED_CODE } from "@stll/api-contract/chat-connector";
import type {
  ConnectConnectorDecision,
  ConnectConnectorInput,
  ConnectConnectorOutput,
} from "@stll/api-contract/chat-connector";
import { Button } from "@stll/ui/button";
import { CheckIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { useChatApproval } from "@/components/chat/chat-approval-context";
import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { TranslationKey } from "@/i18n/types";
import { mcpConnectorConnection } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { knowledgeKeys, mcpConnectorsOptions } from "@/lib/knowledge/queries";
import {
  openMcpOAuthWindow,
  subscribeToMcpOAuthOutcome,
} from "@/lib/mcp-oauth-channel";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

type ConnectConnectorPart = Extract<
  RegisteredChatUIToolCallPart,
  { name: "connect_connector" }
>;

type ConnectConnectorCardProps = {
  isAwaitingUser: boolean;
  part: ConnectConnectorPart;
};

/**
 * Where the card is in the connect flow. `waiting` means a sign-in window is
 * open and the card listens for its outcome; `token-required` means the
 * connector takes a token, which the user adds on the tools page.
 */
type ConnectPhase =
  | { type: "idle" }
  | { type: "connecting" }
  | { type: "waiting" }
  | { type: "token-required" }
  | { type: "confirming" }
  | { type: "failed"; reason: "start" | "not-connected" | "submit" };

const FAILURE_MESSAGE_KEYS = {
  start: "chat.connectConnector.error",
  "not-connected": "chat.connectConnector.notConnected",
  submit: "common.somethingWentWrong",
} as const satisfies Record<
  Extract<ConnectPhase, { type: "failed" }>["reason"],
  TranslationKey
>;

type ConnectorSummary = {
  name: string;
  iconUrl: string | null;
  requestedScopes: readonly string[];
};

/** The catalog entry the card names; the slug stands in until it loads. */
const useConnectorSummary = (
  organizationId: string,
  connectorSlug: string | undefined,
): ConnectorSummary => {
  const catalogQuery = useQuery({
    ...mcpConnectorsOptions(organizationId),
    enabled: connectorSlug !== undefined,
  });
  const catalogView = queryView(catalogQuery);
  useQueryViewError(catalogView, "ConnectConnectorCard:catalogue");
  const connector =
    catalogView.type === "items"
      ? catalogView.items.connectors.find(
          (candidate) => candidate.slug === connectorSlug,
        )
      : undefined;
  return {
    name: connector?.displayName ?? connectorSlug ?? "",
    iconUrl: connector?.iconUrl ?? null,
    // Only an OAuth sign-in requests scopes; none are shown when unknown.
    requestedScopes:
      connector?.authType !== "oauth2" ||
      connector.oauthRequestedScopes === null
        ? []
        : connector.oauthRequestedScopes,
  };
};

type ConnectConnectorDetailsProps = {
  connector: ConnectorSummary;
  input: ConnectConnectorInput;
};

const ConnectConnectorDetails = ({
  connector,
  input,
}: ConnectConnectorDetailsProps) => {
  const t = useTranslations();
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p>
        {t("chat.connectConnector.description", { connector: connector.name })}
      </p>
      <p className="text-muted-foreground">
        {t("chat.requestSecret.purposeByAi", { purpose: input.purpose })}
      </p>
      {connector.requestedScopes.length > 0 ? (
        <p className="text-muted-foreground">
          {t("chat.connectConnector.scopes", {
            scopes: connector.requestedScopes.join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
};

type ContinuationRetryProps = {
  isContinuing: boolean;
  onRetry: () => void;
};

const ContinuationRetry = ({
  isContinuing,
  onRetry,
}: ContinuationRetryProps) => {
  const t = useTranslations();
  return (
    <div className="mt-4 space-y-3">
      <p className="text-destructive text-sm" role="alert">
        {t("chat.requestSecret.continuationError")}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={isContinuing} onClick={onRetry} type="button">
          {isContinuing ? (
            <Loader className="size-4" variant="decorative" />
          ) : null}
          {t("chat.requestSecret.retryContinuationAction")}
        </Button>
      </div>
    </div>
  );
};

type PhaseStatusProps = {
  connectorName: string;
  phase: ConnectPhase;
};

const PhaseStatus = ({ connectorName, phase }: PhaseStatusProps) => {
  const t = useTranslations();
  switch (phase.type) {
    case "waiting":
      return (
        <p className="text-muted-foreground text-sm" role="status">
          {t("chat.connectConnector.waiting")}
        </p>
      );
    case "token-required":
      return (
        <p className="text-muted-foreground text-sm" role="status">
          {t("chat.connectConnector.tokenRequired", {
            connector: connectorName,
          })}
        </p>
      );
    case "failed":
      return (
        <p className="text-destructive text-sm" role="alert">
          {t(FAILURE_MESSAGE_KEYS[phase.reason])}
        </p>
      );
    case "idle":
    case "connecting":
    case "confirming":
      return null;
    default:
      phase satisfies never;
      return panic("Unhandled connect phase");
  }
};

type ConnectActionsProps = {
  connectorSlug: string;
  isBusy: boolean;
  phase: ConnectPhase;
  onCheck: () => void;
  onConnect: () => void;
  onDecline: () => void;
};

const ConnectActions = ({
  connectorSlug,
  isBusy,
  phase,
  onCheck,
  onConnect,
  onDecline,
}: ConnectActionsProps) => {
  const t = useTranslations();
  const isAwaitingSignIn =
    phase.type === "waiting" || phase.type === "token-required";
  const canCheck =
    isAwaitingSignIn ||
    (phase.type === "failed" && phase.reason === "not-connected");
  const isWorking = phase.type === "connecting" || phase.type === "confirming";
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        disabled={isBusy}
        onClick={onDecline}
        type="button"
        variant="ghost"
      >
        {t("common.notNow")}
      </Button>
      {phase.type === "token-required" ? (
        <Button
          render={
            <Link
              search={{ slug: connectorSlug }}
              target="_blank"
              to="/knowledge/tools"
            />
          }
          variant="outline"
        >
          {t("chat.connectConnector.openTools")}
        </Button>
      ) : null}
      {canCheck ? (
        <Button
          disabled={isBusy}
          onClick={onCheck}
          type="button"
          variant="outline"
        >
          {t("chat.connectConnector.checkAction")}
        </Button>
      ) : null}
      {isAwaitingSignIn ? null : (
        <Button disabled={isBusy} onClick={onConnect} type="button">
          {isWorking ? (
            <Loader className="size-4" variant="decorative" />
          ) : null}
          {phase.type === "failed" ? t("common.retry") : t("common.connect")}
        </Button>
      )}
    </div>
  );
};

export const ConnectConnectorCard = ({
  isAwaitingUser,
  part,
}: ConnectConnectorCardProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const {
    activeOrganizationId,
    handleConnectConnector,
    continueConnectConnector,
  } = useChatApproval();
  const [phase, setPhase] = useState<ConnectPhase>({ type: "idle" });
  // The server-confirmed receipt, held so a failed continuation retries only
  // the continuation.
  const [heldReceipt, setHeldReceipt] = useState<ConnectConnectorOutput>();
  const [hasContinuationError, setHasContinuationError] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const hasAnswered = useRef(false);
  const input = part.state === "input-streaming" ? null : part.input;
  const output = part.state === "complete" ? part.output : undefined;
  const shownOutput = output ?? heldReceipt;
  const isPending = isAwaitingUser && output === undefined;
  const connectorSlug = input?.connectorSlug;
  const connector = useConnectorSummary(activeOrganizationId, connectorSlug);
  const isBusy =
    phase.type === "connecting" || phase.type === "confirming" || isContinuing;

  const continueWithReceipt = async (receipt: ConnectConnectorOutput) => {
    setIsContinuing(true);
    const result = await Result.tryPromise(
      async () => await continueConnectConnector(part.id, receipt),
    );
    setHasContinuationError(Result.isError(result));
    setIsContinuing(false);
  };

  // The server decides: `connected` is confirmed against the stored
  // connection, and refused while there is none.
  const submit = async (
    decision: ConnectConnectorDecision,
    beforeSubmit?: () => Promise<void>,
  ) => {
    if (!isPending || heldReceipt !== undefined || hasAnswered.current) {
      return;
    }
    hasAnswered.current = true;
    setPhase({ type: "confirming" });
    const result = await Result.tryPromise({
      try: async () => {
        await beforeSubmit?.();
        return await handleConnectConnector(part.id, decision);
      },
      catch: (error: unknown) => error,
    });
    if (Result.isError(result)) {
      hasAnswered.current = false;
      setPhase({
        type: "failed",
        reason:
          APIError.is(result.error) &&
          result.error.code === CONNECT_CONNECTOR_NOT_CONNECTED_CODE
            ? "not-connected"
            : "submit",
      });
      return;
    }
    setHeldReceipt(result.value);
    await continueWithReceipt(result.value);
  };

  const confirmConnected = async () => {
    await submit("connected", async () => {
      await queryClient.invalidateQueries({
        queryKey: knowledgeKeys.mcp.all(activeOrganizationId),
      });
    });
  };

  const startConnect = async () => {
    if (connectorSlug === undefined || !isPending || isBusy) {
      return;
    }
    setPhase({ type: "connecting" });
    const started = await Result.tryPromise(async () =>
      mcpConnectorConnection.start(connectorSlug),
    );
    if (Result.isError(started)) {
      setPhase({ type: "failed", reason: "start" });
      return;
    }
    switch (started.value.type) {
      case "bearer":
        setPhase({ type: "token-required" });
        return;
      case "none":
        await confirmConnected();
        return;
      case "oauth2": {
        // A blocked popup falls back to navigating this tab; the turn keeps
        // waiting, so the card is answerable again after the sign-in.
        const opened = openMcpOAuthWindow(started.value.authorizeUrl);
        setPhase(
          opened === "invalid"
            ? { type: "failed", reason: "start" }
            : { type: "waiting" },
        );
        return;
      }
      default:
        started.value satisfies never;
        panic("Unhandled connector connect response");
    }
  };

  // Sign-in completes in another window, which broadcasts its outcome. Any
  // outcome is checked with the server, which knows whether it connected.
  const onSignInOutcome = useLatestCallback(() => {
    detached(confirmConnected(), "connect-connector-card.sign-in-outcome");
  });
  const isWaitingForSignIn = phase.type === "waiting";
  useExternalSyncEffect(
    () =>
      isWaitingForSignIn
        ? subscribeToMcpOAuthOutcome(onSignInOutcome)
        : undefined,
    [isWaitingForSignIn, onSignInOutcome],
  );

  return (
    <section
      aria-label={t("chat.connectConnector.title")}
      className="bg-muted/40 my-3 max-w-xl rounded-xl p-4"
      data-slot="connect-connector-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {shownOutput?.status === "connected" ? (
          <CheckIcon aria-hidden="true" className="size-4" />
        ) : (
          <CatalogueEntryIcon
            className="text-muted-foreground"
            iconUrl={connector.iconUrl}
            size={16}
            {...(connectorSlug === undefined ? {} : { slug: connectorSlug })}
          />
        )}
        {t("chat.connectConnector.title")}
      </div>
      {input && shownOutput === undefined ? (
        <ConnectConnectorDetails connector={connector} input={input} />
      ) : null}
      {shownOutput ? (
        <p className="text-muted-foreground mt-3 text-sm">
          {shownOutput.status === "connected"
            ? t("common.connected")
            : t("common.notConnected")}
        </p>
      ) : null}
      {heldReceipt !== undefined && hasContinuationError ? (
        <ContinuationRetry
          isContinuing={isContinuing}
          onRetry={() =>
            detached(
              continueWithReceipt(heldReceipt),
              "connect-connector-card.retry-continuation",
            )
          }
        />
      ) : null}
      {isPending && connectorSlug !== undefined && heldReceipt === undefined ? (
        <div className="mt-4 space-y-3">
          <PhaseStatus connectorName={connector.name} phase={phase} />
          <ConnectActions
            connectorSlug={connectorSlug}
            isBusy={isBusy}
            onCheck={() =>
              detached(confirmConnected(), "connect-connector-card.check")
            }
            onConnect={() =>
              detached(startConnect(), "connect-connector-card.connect")
            }
            onDecline={() =>
              detached(submit("declined"), "connect-connector-card.decline")
            }
            phase={phase}
          />
        </div>
      ) : null}
    </section>
  );
};
