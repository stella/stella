import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";

import {
  McpReconnectButton,
  useMcpConnectionOAuthRefresh,
} from "@/components/mcp-reconnect-button";
import {
  canMentionMcpConnection,
  matchBrokenMcpConnections,
  type McpReconnectCandidate,
  mcpReconnectDismissKey,
} from "@/features/chat/lib/mcp-reconnect.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useUserStorageState } from "@/lib/account/use-user-storage-state";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  mcpConnectionsOptions,
  mcpConnectorsOptions,
  type McpConnectorsResponse,
} from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

const COMPOSER_MATCH_DELAY_MS = 250;
const dismissedSchema = v.array(v.string());
const decodeDismissed = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  // Storage can be edited outside this tab; malformed values carry no dismissal.
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), dismissedSchema),
    raw,
  );
  return parsed.success ? parsed.output : [];
};
const encodeDismissed = (keys: string[]) => JSON.stringify(keys);

type NamedConnection = McpReconnectCandidate & {
  authType: McpConnectorsResponse["connectors"][number]["authType"];
};

export const McpReconnectNotice = ({ editor }: { editor: Editor | null }) => {
  const { id: userId, activeOrganizationId } = useAuthenticatedUser();
  const text = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      // Tiptap clears its schema on destroy; an unmounted editor can also
      // retain its document while no longer being usable by this composer.
      if (!current || current.isDestroyed) {
        return "";
      }
      return current.getText();
    },
  });
  const [debouncedText] = useDebounce(text ?? "", COMPOSER_MATCH_DELAY_MS);
  // Opening a chat costs no integration requests; they load once the
  // composer holds enough text to name one.
  const enabled = canMentionMcpConnection(debouncedText);
  const connectionsQuery = useQuery({
    ...mcpConnectionsOptions(activeOrganizationId, userId),
    enabled,
  });
  const connectorsQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled,
  });
  const connectionsView = queryView(connectionsQuery);
  const connectorsView = queryView(connectorsQuery);
  useQueryViewError(connectionsView, "McpReconnectNotice:connections");
  useQueryViewError(connectorsView, "McpReconnectNotice:connectors");
  const connectors =
    connectorsView.type === "items" ? connectorsView.items.connectors : [];
  const connectorsBySlug = new Map(
    connectors.map((connector) => [connector.slug, connector]),
  );
  const candidates: NamedConnection[] = [];
  if (connectionsView.type === "items") {
    for (const connection of connectionsView.items.connections) {
      const connector = connectorsBySlug.get(connection.connectorSlug);
      // Connections may outlive a deleted connector or a partial query result.
      if (!connector) {
        continue;
      }
      candidates.push({
        id: connection.id,
        status: connection.status,
        expiresAt: connection.expiresAt,
        slug: connector.slug,
        displayName: connector.displayName,
        authType: connector.authType,
      });
    }
  }
  return (
    <McpReconnectNoticeContent
      key={`${activeOrganizationId}:${userId}`}
      candidates={candidates}
      text={debouncedText}
    />
  );
};

export const McpReconnectNoticeContent = ({
  candidates,
  text,
}: {
  candidates: readonly NamedConnection[];
  text: string;
}) => {
  const t = useTranslations();
  useMcpConnectionOAuthRefresh();
  const { value: dismissed, updateValue } = useUserStorageState({
    baseKey: "stella:mcp-reconnect-dismissed:",
    area: "local",
    decode: decodeDismissed,
    encode: encodeDismissed,
  });
  const recoveredIds = candidates
    .filter(({ status }) => status === "connected")
    .map(({ id }) => id);
  useExternalSyncEffect(() => {
    // A recovered connection with no expiry can later break with the same key.
    // Remove its persisted dismissal when that recovery is actually observed.
    if (
      dismissed.some((key) =>
        recoveredIds.some((id) => key.startsWith(`${id}:`)),
      )
    ) {
      updateValue((previous) =>
        previous.filter(
          (key) => !recoveredIds.some((id) => key.startsWith(`${id}:`)),
        ),
      );
    }
  }, [dismissed, recoveredIds, updateValue]);
  const matches = matchBrokenMcpConnections(text, candidates).filter(
    (candidate) => !dismissed.includes(mcpReconnectDismissKey(candidate)),
  );
  const [announced, setAnnounced] = useState<readonly NamedConnection[]>([]);
  const retainedAnnouncements = announced.filter(
    ({ id }) => !recoveredIds.includes(id),
  );
  const newAnnouncements = matches.filter(
    (candidate) =>
      !retainedAnnouncements.some(
        (previous) =>
          mcpReconnectDismissKey(previous) ===
          mcpReconnectDismissKey(candidate),
      ),
  );
  if (
    newAnnouncements.length > 0 ||
    retainedAnnouncements.length !== announced.length
  ) {
    setAnnounced([...retainedAnnouncements, ...newAnnouncements]);
  }
  const message = (candidate: NamedConnection): ReactNode =>
    t.rich(
      candidate.status === "needs_approval"
        ? "chat.mcpReconnect.waitingApproval"
        : "chat.mcpReconnect.stoppedWorking",
      {
        server: candidate.displayName,
        name: (chunks) => <BidiText>{chunks}</BidiText>,
      },
    );

  return (
    <>
      {/* Keep announcements mounted when the mention disappears, so typing the
        same name again does not announce the same connection break twice. */}
      <div aria-live="polite" aria-atomic="false" className="sr-only">
        {announced.map((candidate) => (
          <p key={mcpReconnectDismissKey(candidate)}>{message(candidate)}</p>
        ))}
      </div>
      {matches.length > 0 && (
        <div className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              {matches.slice(0, 2).map((candidate) => (
                <div
                  className="flex flex-wrap items-center gap-2"
                  key={mcpReconnectDismissKey(candidate)}
                >
                  <span>{message(candidate)}</span>
                  {candidate.status !== "needs_approval" && (
                    <McpReconnectButton
                      oauthRefresh="owner"
                      authType={candidate.authType}
                      slug={candidate.slug}
                    />
                  )}
                </div>
              ))}
              {matches.length > 2 && (
                <span>
                  {t("chat.mcpReconnect.additional", {
                    count: matches.length - 2,
                  })}
                </span>
              )}
            </div>
            <Button
              aria-label={t("chat.mcpReconnect.dismiss")}
              className="min-h-11 min-w-11"
              onClick={() =>
                updateValue((previous) => [
                  ...new Set([
                    ...previous,
                    ...matches.map(mcpReconnectDismissKey),
                  ]),
                ])
              }
              size="icon-sm"
              variant="ghost"
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
};
