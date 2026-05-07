import { useEffect, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { env } from "@/env";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  knowledgeKeys,
  mcpConnectionsOptions,
  mcpConnectorsOptions,
} from "@/routes/_protected.knowledge/-queries";

export const Route = createFileRoute("/_protected/knowledge/mcp")({
  component: McpPage,
});

type McpConnector = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  url: string;
  authType: "none" | "bearer" | "oauth2";
  isCurated: boolean;
  isRecommended: boolean;
  recommendedJurisdictions: string[];
  documentationUrl: string | null;
  iconUrl: string | null;
  tokenHelpUrl: string | null;
};

type McpConnection = {
  id: string;
  connectorSlug: string;
  enabled: boolean;
  status: "connected" | "needs_reauth" | "revoked";
  lastUsedAt: Date | null;
  updatedAt: Date;
};

type NativeToolCatalogItem = {
  slug: string;
  displayName: string;
  description: string;
  url: string;
  documentationUrl: string | null;
  iconUrl: string | null;
  isRecommended: boolean;
  recommendedJurisdictions: string[];
};

type ProbeResult =
  | {
      authType: "oauth2";
      authorizationServerUrl: string;
      resourceUrl: string;
      scopes: string[];
    }
  | { authType: "bearer" }
  | { authType: "none" };

function McpPage() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const apiOrigin = new URL(env.VITE_API_URL).origin;

  const { data: connectorsData, isLoading: connectorsLoading } = useQuery(
    mcpConnectorsOptions(),
  );
  const { data: connectionsData } = useQuery(mcpConnectionsOptions());

  const connectors = connectorsData?.connectors ?? [];
  const nativeTools = connectorsData?.nativeTools ?? [];
  const connections = connectionsData?.connections ?? [];
  const canManageCustomConnectors =
    connectorsData?.canManageCustomConnectors ?? false;
  const recommendedConnectors = connectors.filter(
    (connector) => connector.isRecommended,
  );
  const recommendedNativeTools = nativeTools.filter(
    (tool) => tool.isRecommended,
  );
  const otherConnectors = connectors.filter(
    (connector) => !connector.isRecommended,
  );
  const otherNativeTools = nativeTools.filter((tool) => !tool.isRecommended);
  const hasRecommendedItems =
    recommendedConnectors.length > 0 || recommendedNativeTools.length > 0;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== apiOrigin) {
        return;
      }

      if (
        typeof event.data !== "string" ||
        !event.data.startsWith("mcp:connected:")
      ) {
        return;
      }

      stellaToast.add({
        title: t("knowledge.mcp.connectedToast"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.mcp.all });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [apiOrigin, queryClient, t]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-foreground text-xl font-semibold">
          {t("knowledge.sections.mcp.title")}
        </h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          {t("knowledge.mcp.description")}
        </p>
      </div>

      {hasRecommendedItems && (
        <ConnectorSection
          connections={connections}
          connectors={recommendedConnectors}
          nativeTools={recommendedNativeTools}
          onChanged={() => {
            void queryClient.invalidateQueries({
              queryKey: knowledgeKeys.mcp.all,
            });
          }}
          title={t("knowledge.mcp.recommendedTitle")}
        />
      )}

      <ConnectorSection
        connections={connections}
        connectors={otherConnectors}
        nativeTools={otherNativeTools}
        onChanged={() => {
          void queryClient.invalidateQueries({
            queryKey: knowledgeKeys.mcp.all,
          });
        }}
        title={hasRecommendedItems ? t("knowledge.mcp.otherTitle") : undefined}
      />

      {connectors.length === 0 &&
        nativeTools.length === 0 &&
        !connectorsLoading && (
          <div className="border-border bg-muted/20 flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
            <PlugZapIcon className="text-muted-foreground size-8" />
            <h2 className="mt-3 text-sm font-semibold">
              {t("knowledge.mcp.emptyTitle")}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              {t("knowledge.mcp.emptyDescription")}
            </p>
          </div>
        )}

      {canManageCustomConnectors && (
        <CustomServerPanel
          onCreated={() => {
            void queryClient.invalidateQueries({
              queryKey: knowledgeKeys.mcp.all,
            });
          }}
        />
      )}
    </div>
  );
}

function ConnectorSection({
  connections,
  connectors,
  nativeTools = [],
  onChanged,
  title,
}: {
  connections: McpConnection[];
  connectors: McpConnector[];
  nativeTools?: NativeToolCatalogItem[] | undefined;
  onChanged: () => void;
  title: string | undefined;
}) {
  if (connectors.length === 0 && nativeTools.length === 0) {
    return null;
  }

  return (
    <section className="mb-6">
      {title && <h2 className="mb-3 text-sm font-semibold">{title}</h2>}
      <div className="grid gap-3 xl:grid-cols-2">
        {nativeTools.map((tool) => (
          <NativeToolCard key={tool.slug} tool={tool} />
        ))}
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            connection={connections.find(
              (item) => item.connectorSlug === connector.slug,
            )}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectorCard({
  connector,
  connection,
  onChanged,
}: {
  connector: McpConnector;
  connection: McpConnection | undefined;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(
    connector.authType === "bearer" && connection?.status === "needs_reauth",
  );

  const connect = async () => {
    setBusy(true);
    const response = await api.mcp
      .connectors({ slug: connector.slug })
      .connect.post({ queryKey: ["mcp"] });
    setBusy(false);

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    if (response.data.type === "bearer") {
      setShowTokenInput(true);
      return;
    }

    if (response.data.type === "oauth2") {
      const popup = window.open(
        response.data.authorizeUrl,
        "_blank",
        "width=560,height=720",
      );

      if (!popup) {
        window.location.assign(response.data.authorizeUrl);
      }
      return;
    }

    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
  };

  const saveToken = async () => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      return;
    }

    setBusy(true);
    const response = await api.mcp.connections.post({
      connectorSlug: connector.slug,
      token: trimmedToken,
      queryKey: ["mcp"],
    });
    setBusy(false);

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    setToken("");
    setShowTokenInput(false);
    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
  };

  const disconnect = async () => {
    if (!connection) {
      return;
    }

    setBusy(true);
    const response = await api.mcp
      .connections({
        connectionId: toSafeId<"mcpUserConnection">(connection.id),
      })
      .delete({ queryKey: ["mcp"] });
    setBusy(false);

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    onChanged();
  };

  const setEnabled = async (enabled: boolean) => {
    if (!connection) {
      return;
    }

    setBusy(true);
    const response = await api.mcp
      .connections({
        connectionId: toSafeId<"mcpUserConnection">(connection.id),
      })
      .patch({
        enabled,
        queryKey: ["mcp"],
      });
    setBusy(false);

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    onChanged();
  };

  const connected = connection?.status === "connected";
  const enabled = connected && connection.enabled;
  const needsReauth = connection?.status === "needs_reauth";
  const documentationHref =
    connector.documentationUrl === null
      ? undefined
      : sanitizeHref(connector.documentationUrl);
  const tokenHelpHref =
    connector.tokenHelpUrl === null
      ? undefined
      : sanitizeHref(connector.tokenHelpUrl);
  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  const safeIconHref =
    iconHref === undefined ? undefined : sanitizeHref(iconHref);

  return (
    <section className="bg-card rounded-lg border p-5">
      <div className="flex items-start gap-4">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
          {safeIconHref ? (
            <img
              alt=""
              className="size-5 rounded-sm object-contain"
              height={20}
              src={safeIconHref}
              width={20}
            />
          ) : (
            <PlugZapIcon className="size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{connector.displayName}</h2>
            {connector.isRecommended && (
              <span className="bg-success/10 text-success rounded-md px-2 py-0.5 text-xs font-medium">
                {t("knowledge.mcp.recommendedBadge")}
              </span>
            )}
            <ConnectionStatusBadge connection={connection} />
            <AuthBadge authType={connector.authType} />
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {connector.description}
          </p>
          {connector.recommendedJurisdictions.length > 0 && (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("knowledge.mcp.recommendedFor", {
                jurisdictions: formatJurisdictions(
                  connector.recommendedJurisdictions,
                  locale,
                ),
              })}
            </p>
          )}
          <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="truncate">{connector.url}</span>
            {documentationHref && (
              <a
                className="hover:text-foreground inline-flex items-center gap-1"
                href={documentationHref}
                rel="noreferrer"
                target="_blank"
              >
                {t("knowledge.mcp.docsLink")}
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {connected ? (
          <ChatUseSwitchButton
            busy={busy}
            enabled={enabled}
            onToggle={() => void setEnabled(!enabled)}
          />
        ) : (
          <Button disabled={busy} onClick={() => void connect()} size="sm">
            {needsReauth ? (
              <RefreshCcwIcon className="me-1.5 size-4" />
            ) : (
              <PlugZapIcon className="me-1.5 size-4" />
            )}
            {needsReauth
              ? t("knowledge.mcp.reconnect")
              : t("knowledge.mcp.connect")}
          </Button>
        )}
        {connection && (
          <Button
            disabled={busy}
            onClick={() => void disconnect()}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="me-1.5 size-4" />
            {t("knowledge.mcp.disconnect")}
          </Button>
        )}
      </div>

      {showTokenInput && (
        <div className="border-border bg-muted/20 mt-4 rounded-lg border p-3">
          <label
            className="text-sm font-medium"
            htmlFor={`${connector.slug}-token`}
          >
            {t("knowledge.mcp.tokenLabel")}
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${connector.slug}-token`}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => setToken(event.target.value)}
              placeholder={t("knowledge.mcp.tokenPlaceholder")}
              type="password"
              value={token}
            />
            <Button
              disabled={busy || !token.trim()}
              onClick={() => void saveToken()}
            >
              <KeyRoundIcon className="me-1.5 size-4" />
              {t("knowledge.mcp.saveToken")}
            </Button>
          </div>
          {tokenHelpHref && (
            <a
              className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs"
              href={tokenHelpHref}
              rel="noreferrer"
              target="_blank"
            >
              {t("knowledge.mcp.tokenHelp")}
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function NativeToolCard({ tool }: { tool: NativeToolCatalogItem }) {
  const t = useTranslations();
  const locale = useLocale();
  const documentationHref =
    tool.documentationUrl === null
      ? undefined
      : sanitizeHref(tool.documentationUrl);
  const iconHref = tool.iconUrl ?? fallbackIconUrl(tool.url);
  const safeIconHref =
    iconHref === undefined ? undefined : sanitizeHref(iconHref);

  return (
    <section className="bg-card rounded-lg border p-5">
      <div className="flex items-start gap-4">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
          {safeIconHref ? (
            <img
              alt=""
              className="size-5 rounded-sm object-contain"
              height={20}
              src={safeIconHref}
              width={20}
            />
          ) : (
            <PlugZapIcon className="size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{tool.displayName}</h2>
            {tool.isRecommended && (
              <span className="bg-success/10 text-success rounded-md px-2 py-0.5 text-xs font-medium">
                {t("knowledge.mcp.recommendedBadge")}
              </span>
            )}
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
              {t("knowledge.mcp.builtInBadge")}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {tool.description}
          </p>
          {tool.recommendedJurisdictions.length > 0 && (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("knowledge.mcp.recommendedFor", {
                jurisdictions: formatJurisdictions(
                  tool.recommendedJurisdictions,
                  locale,
                ),
              })}
            </p>
          )}
          <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span className="truncate">{tool.url}</span>
            {documentationHref && (
              <a
                className="hover:text-foreground inline-flex items-center gap-1"
                href={documentationHref}
                rel="noreferrer"
                target="_blank"
              >
                {t("knowledge.mcp.docsLink")}
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <span className="bg-success/10 text-success inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium">
          <CheckIcon className="size-4" />
          {t("knowledge.mcp.availableInChat")}
        </span>
      </div>
    </section>
  );
}

function ChatUseSwitchButton({
  busy,
  enabled,
  onToggle,
}: {
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations();

  return (
    <Button
      aria-checked={enabled}
      disabled={busy}
      onClick={onToggle}
      role="switch"
      size="sm"
      variant="outline"
    >
      <span>{t("knowledge.mcp.useInChat")}</span>
      <span
        className={cn(
          "flex h-4 w-7 items-center rounded-full border px-0.5 transition-colors",
          enabled
            ? "border-success/40 bg-success/20 justify-end"
            : "bg-muted justify-start",
        )}
      >
        <span
          className={cn(
            "size-2.5 rounded-full transition-colors",
            enabled ? "bg-success" : "bg-muted-foreground",
          )}
        />
      </span>
      <span className={enabled ? "text-success" : "text-muted-foreground"}>
        {enabled ? t("knowledge.mcp.on") : t("knowledge.mcp.off")}
      </span>
    </Button>
  );
}

function ConnectionStatusBadge({
  connection,
}: {
  connection: McpConnection | undefined;
}) {
  const t = useTranslations();

  if (!connection) {
    return (
      <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
        {t("knowledge.mcp.notConnected")}
      </span>
    );
  }

  if (connection.status === "needs_reauth") {
    return (
      <span className="bg-warning/10 text-warning rounded-md px-2 py-0.5 text-xs font-medium">
        {t("knowledge.mcp.needsReauth")}
      </span>
    );
  }

  return (
    <span className="bg-success/10 text-success rounded-md px-2 py-0.5 text-xs font-medium">
      {t("knowledge.mcp.connected")}
    </span>
  );
}

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};

function formatJurisdictions(countryCodes: readonly string[], locale: string) {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const formatter = new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  });

  return formatter.format(
    countryCodes.map((countryCode) => names.of(countryCode) ?? countryCode),
  );
}

function AuthBadge({ authType }: { authType: McpConnector["authType"] }) {
  const t = useTranslations();

  return (
    <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
      {t(`knowledge.mcp.auth.${authType}`)}
    </span>
  );
}

function CustomServerPanel({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations();
  const [url, setUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [probe, setProbe] = useState<ProbeResult | undefined>();
  const [busy, setBusy] = useState(false);

  const probeServer = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      return;
    }

    setBusy(true);
    const response = await api.mcp.connectors.probe.post({ url: trimmedUrl });
    setBusy(false);

    if (response.error) {
      setProbe(undefined);
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    setProbe(response.data);
  };

  const createServer = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      return;
    }

    setBusy(true);
    const response = await api.mcp.connectors.post({
      url: trimmedUrl,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      queryKey: ["mcp"],
    });
    setBusy(false);

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    setUrl("");
    setDisplayName("");
    setProbe(undefined);
    onCreated();
  };

  return (
    <section className="border-border mt-8 border-t pt-6">
      <div className="max-w-2xl">
        <h2 className="text-sm font-semibold">
          {t("knowledge.mcp.customTitle")}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("knowledge.mcp.customDescription")}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_220px_auto]">
          <Input
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("knowledge.mcp.urlPlaceholder")}
            value={url}
          />
          <Input
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t("knowledge.mcp.namePlaceholder")}
            value={displayName}
          />
          <Button
            disabled={busy || !url.trim()}
            onClick={() => void probeServer()}
          >
            {t("knowledge.mcp.probe")}
          </Button>
        </div>

        {probe && (
          <div className="border-border bg-muted/20 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">
                {t("knowledge.mcp.detected", {
                  authType: t(`knowledge.mcp.auth.${probe.authType}`),
                })}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {probe.authType === "oauth2" ? probe.resourceUrl : url.trim()}
              </p>
            </div>
            <Button
              disabled={busy}
              onClick={() => void createServer()}
              size="sm"
            >
              <PlusIcon className="me-1.5 size-4" />
              {t("knowledge.mcp.addServer")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function showApiError({
  error,
  fallback,
  title,
}: {
  error: Parameters<typeof userErrorMessage>[0];
  fallback: string;
  title: string;
}) {
  stellaToast.add({
    title,
    description: userErrorMessage(error, fallback),
    type: "error",
  });
}
