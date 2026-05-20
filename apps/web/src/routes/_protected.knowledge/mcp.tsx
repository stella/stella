import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import {
  CircleHelpIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCcwIcon,
  Trash2Icon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { McpIcon } from "@/components/mcp-icon";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { subscribeToMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
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

const protectedRouteApi = getRouteApi("/_protected");

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
  enabled: boolean;
};

type CreatedConnector = {
  slug: string;
  authType: McpConnector["authType"];
};

const sortCatalogItems = <
  TItem extends { displayName: string; isRecommended: boolean },
>(
  items: readonly TItem[],
) =>
  [...items].sort((left, right) => {
    if (left.isRecommended !== right.isRecommended) {
      return left.isRecommended ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });

function McpPage() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: connectorsData, isLoading: connectorsLoading } = useQuery(
    mcpConnectorsOptions(activeOrganizationId),
  );
  const { data: connectionsData } = useQuery(
    mcpConnectionsOptions(activeOrganizationId),
  );

  const connectors = connectorsData?.connectors ?? [];
  const nativeTools = connectorsData?.nativeTools ?? [];
  const connections = connectionsData?.connections ?? [];
  const canManageCustomConnectors =
    connectorsData?.canManageCustomConnectors ?? false;

  useEffect(
    () =>
      subscribeToMcpOAuthOutcome((outcome) => {
        if (outcome.status === "connected") {
          stellaToast.add({
            title: t("knowledge.mcp.connectedToast"),
            type: "success",
          });
          void queryClient.invalidateQueries({
            queryKey: knowledgeKeys.mcp.all(activeOrganizationId),
          });
          return;
        }
        stellaToast.add({
          title: t("knowledge.mcp.errorTitle"),
          description: t("knowledge.mcp.errorDescription"),
          type: "error",
        });
      }),
    [activeOrganizationId, queryClient, t],
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-foreground text-xl font-semibold">
            {t("knowledge.sections.mcp.title")}
          </h1>
          <Popover>
            <PopoverTrigger
              aria-label={t("knowledge.mcp.whatIsAnMcpServer")}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
            >
              <CircleHelpIcon className="size-4" />
            </PopoverTrigger>
            <PopoverPopup
              align="start"
              className="max-w-sm text-xs"
              sideOffset={6}
            >
              {t("knowledge.mcp.mcpExplainer")}
            </PopoverPopup>
          </Popover>
        </div>
      </div>

      <ConnectorSection
        addServerCard={
          canManageCustomConnectors ? (
            <AddServerCard
              onChanged={() => {
                void queryClient.invalidateQueries({
                  queryKey: knowledgeKeys.mcp.all(activeOrganizationId),
                });
              }}
            />
          ) : undefined
        }
        connections={connections}
        connectors={sortCatalogItems(connectors)}
        nativeTools={sortCatalogItems(nativeTools)}
        onChanged={() => {
          void queryClient.invalidateQueries({
            queryKey: knowledgeKeys.mcp.all(activeOrganizationId),
          });
        }}
        userCanManageCustomConnectors={canManageCustomConnectors}
      />

      {connectors.length === 0 &&
        nativeTools.length === 0 &&
        !canManageCustomConnectors &&
        !connectorsLoading && (
          <div className="border-border bg-muted/20 flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
            <McpIcon className="text-muted-foreground size-8" />
            <h2 className="mt-3 text-sm font-semibold">
              {t("knowledge.mcp.emptyTitle")}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              {t("knowledge.mcp.emptyDescription")}
            </p>
          </div>
        )}
    </div>
  );
}

function ConnectorSection({
  addServerCard,
  connections,
  connectors,
  nativeTools = [],
  onChanged,
  userCanManageCustomConnectors,
}: {
  addServerCard?: ReactNode;
  connections: McpConnection[];
  connectors: McpConnector[];
  nativeTools?: NativeToolCatalogItem[] | undefined;
  onChanged: () => void;
  userCanManageCustomConnectors: boolean;
}) {
  if (
    addServerCard === undefined &&
    connectors.length === 0 &&
    nativeTools.length === 0
  ) {
    return null;
  }

  return (
    <section className="mb-6">
      <div className="grid gap-3 xl:grid-cols-2">
        {addServerCard}
        {nativeTools.map((tool) => (
          <NativeToolCard
            key={tool.slug}
            canToggle={userCanManageCustomConnectors}
            onChanged={onChanged}
            tool={tool}
          />
        ))}
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            connection={connections.find(
              (item) => item.connectorSlug === connector.slug,
            )}
            onChanged={onChanged}
            userCanManageCustomConnectors={userCanManageCustomConnectors}
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
  userCanManageCustomConnectors,
}: {
  connector: McpConnector;
  connection: McpConnection | undefined;
  onChanged: () => void;
  userCanManageCustomConnectors: boolean;
}) {
  const t = useTranslations();
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
    if (!connection || busy) {
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
    if (!connection || busy) {
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

  const deleteConnector = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    const response = await api.mcp
      .connectors({ slug: connector.slug })
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

  const connected = connection?.status === "connected";
  const enabled = connected && connection.enabled;
  const needsReauth = connection?.status === "needs_reauth";
  const canDeleteConnector =
    !connector.isCurated && userCanManageCustomConnectors;
  const tokenHelpHref =
    connector.tokenHelpUrl === null
      ? undefined
      : sanitizeHref(connector.tokenHelpUrl);
  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  const safeIconHref =
    iconHref === undefined ? undefined : sanitizeHref(iconHref);

  return (
    <section className="bg-card rounded-lg border">
      <div className="flex items-center gap-3 p-3">
        <div className="shrink-0">
          {safeIconHref ? (
            <img
              alt=""
              className="size-6 rounded-sm object-contain ring-1 ring-black/5 dark:ring-white/10"
              height={24}
              src={safeIconHref}
              width={24}
            />
          ) : (
            <McpIcon className="text-muted-foreground size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-tight font-medium">
            {connector.displayName}
          </div>
          <div className="text-muted-foreground truncate text-xs">
            {connector.url}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
              aria-busy={busy}
              aria-label={t("knowledge.mcp.disconnect")}
              onClick={() => void disconnect()}
              size="sm"
              variant="ghost"
            >
              <UnplugIcon className="size-4" />
            </Button>
          )}
          {canDeleteConnector && (
            <Button
              aria-busy={busy}
              aria-label={t("common.delete")}
              onClick={() => void deleteConnector()}
              size="sm"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          )}
        </div>
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

function NativeToolCard({
  tool,
  canToggle,
  onChanged,
}: {
  tool: NativeToolCatalogItem;
  canToggle: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const iconHref = tool.iconUrl ?? fallbackIconUrl(tool.url);
  const safeIconHref =
    iconHref === undefined ? undefined : sanitizeHref(iconHref);

  const setEnabled = async (enabled: boolean) => {
    if (busy) {
      return;
    }
    setBusy(true);
    const response = await api.mcp["native-tools"]({ slug: tool.slug }).patch({
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

  return (
    <section className="bg-card flex items-center gap-3 rounded-lg border p-3">
      <div className="shrink-0">
        {safeIconHref ? (
          <img
            alt=""
            className="size-6 rounded-sm object-contain ring-1 ring-black/5 dark:ring-white/10"
            height={24}
            src={safeIconHref}
            width={24}
          />
        ) : (
          <McpIcon className="text-muted-foreground size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-tight font-medium">
          {tool.displayName}
        </div>
        <div className="text-muted-foreground truncate text-xs">{tool.url}</div>
      </div>
      {canToggle ? (
        <ChatUseSwitchButton
          busy={busy}
          enabled={tool.enabled}
          onToggle={() => void setEnabled(!tool.enabled)}
        />
      ) : (
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium",
            tool.enabled
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          {tool.enabled
            ? t("knowledge.mcp.useInChat")
            : t("knowledge.mcp.disabled")}
        </span>
      )}
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
      aria-busy={busy}
      aria-checked={enabled}
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
    </Button>
  );
}

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};

type WizardState =
  | { step: "idle" }
  | { step: "url"; url: string; busy: boolean }
  | {
      step: "token";
      createdConnector: CreatedConnector;
      token: string;
      busy: boolean;
    };

const WIZARD_IDLE: WizardState = { step: "idle" };

function AddServerCard({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations();
  const [wizard, setWizard] = useState<WizardState>(WIZARD_IDLE);

  const reset = () => {
    setWizard(WIZARD_IDLE);
  };

  const connectConnector = async (connector: CreatedConnector) => {
    const response = await api.mcp
      .connectors({ slug: connector.slug })
      .connect.post({ queryKey: ["mcp"] });

    if (response.error) {
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    if (response.data.type === "bearer") {
      setWizard({
        step: "token",
        createdConnector: connector,
        token: "",
        busy: false,
      });
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
      reset();
      return;
    }

    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
    reset();
  };

  const addServer = async () => {
    if (wizard.step !== "url") {
      return;
    }
    const trimmedUrl = wizard.url.trim();
    if (!trimmedUrl || wizard.busy) {
      return;
    }

    setWizard({ ...wizard, busy: true });
    const response = await api.mcp.connectors.post({
      url: trimmedUrl,
      queryKey: ["mcp"],
    });

    if (response.error) {
      setWizard((prev) =>
        prev.step === "url" ? { ...prev, busy: false } : prev,
      );
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    setWizard((prev) =>
      prev.step === "url" ? { ...prev, busy: false } : prev,
    );
    onChanged();
    await connectConnector(response.data.connector);
  };

  const saveToken = async () => {
    if (wizard.step !== "token") {
      return;
    }
    const trimmedToken = wizard.token.trim();
    if (!trimmedToken || wizard.busy) {
      return;
    }

    const { createdConnector } = wizard;
    setWizard({ ...wizard, busy: true });
    const response = await api.mcp.connections.post({
      connectorSlug: createdConnector.slug,
      token: trimmedToken,
      queryKey: ["mcp"],
    });

    if (response.error) {
      setWizard((prev) =>
        prev.step === "token" ? { ...prev, busy: false } : prev,
      );
      showApiError({
        error: response.error,
        fallback: t("knowledge.mcp.errorDescription"),
        title: t("knowledge.mcp.errorTitle"),
      });
      return;
    }

    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
    reset();
  };

  if (wizard.step === "idle") {
    return (
      <button
        className="bg-card hover:bg-muted/30 focus-visible:ring-ring flex items-center gap-3 rounded-lg border border-dashed p-3 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => setWizard({ step: "url", url: "", busy: false })}
        type="button"
      >
        <PlusIcon className="text-muted-foreground size-5 shrink-0" />
        <span className="text-sm font-medium">
          {t("knowledge.mcp.addServerCardTitle")}
        </span>
      </button>
    );
  }

  if (wizard.step === "url") {
    return (
      <form
        className="bg-card flex items-center gap-2 rounded-lg border p-2 ps-3"
        onSubmit={(event) => {
          event.preventDefault();
          void addServer();
        }}
      >
        <PlusIcon className="text-muted-foreground size-5 shrink-0" />
        <Input
          aria-label={t("knowledge.mcp.urlLabel")}
          autoComplete="url"
          autoFocus
          className="border-0 shadow-none focus-visible:ring-0"
          onChange={(event) =>
            setWizard((prev) =>
              prev.step === "url" ? { ...prev, url: event.target.value } : prev,
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              reset();
            }
          }}
          placeholder={t("knowledge.mcp.urlPlaceholder")}
          type="url"
          value={wizard.url}
        />
        <Button
          disabled={wizard.busy || !wizard.url.trim()}
          size="sm"
          type="submit"
        >
          {wizard.busy ? (
            <LoaderIcon className="me-1.5 size-4 animate-spin" />
          ) : null}
          {t("knowledge.mcp.addAndConnect")}
        </Button>
        <Button
          aria-label={t("common.cancel")}
          onClick={reset}
          size="sm"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </form>
    );
  }

  return (
    <div className="bg-card rounded-lg border p-2 ps-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void saveToken();
        }}
      >
        <KeyRoundIcon className="text-muted-foreground size-5 shrink-0" />
        <Input
          aria-label={t("knowledge.mcp.tokenLabel")}
          autoComplete="off"
          autoFocus
          className="border-0 font-mono shadow-none focus-visible:ring-0"
          onChange={(event) =>
            setWizard((prev) =>
              prev.step === "token"
                ? { ...prev, token: event.target.value }
                : prev,
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              reset();
            }
          }}
          placeholder={t("knowledge.mcp.tokenPlaceholder")}
          type="password"
          value={wizard.token}
        />
        <Button
          disabled={wizard.busy || !wizard.token.trim()}
          size="sm"
          type="submit"
        >
          {wizard.busy ? (
            <LoaderIcon className="me-1.5 size-4 animate-spin" />
          ) : null}
          {t("knowledge.mcp.saveToken")}
        </Button>
        <Button
          aria-label={t("common.cancel")}
          onClick={reset}
          size="sm"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </form>
      <p className="text-muted-foreground mt-2 ps-7 text-xs">
        {t("knowledge.mcp.bearerTokenDescription")}
      </p>
    </div>
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
