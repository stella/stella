import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

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

  const { data: connectorsData, isLoading: connectorsLoading } = useQuery(
    mcpConnectorsOptions(),
  );
  const { data: connectionsData } = useQuery(mcpConnectionsOptions());

  const connectors = connectorsData?.connectors ?? [];
  const nativeTools = connectorsData?.nativeTools ?? [];
  const connections = connectionsData?.connections ?? [];
  const canManageCustomConnectors =
    connectorsData?.canManageCustomConnectors ?? false;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Popup terminal page lives on the SPA host, so it posts back
      // to its own origin. The previous flow posted from the API
      // host (api.stll.app), but CloudFront's CSP blocks the inline
      // postMessage script there.
      if (event.origin !== window.location.origin) {
        return;
      }

      if (typeof event.data !== "string") {
        return;
      }

      if (event.data.startsWith("mcp:connected:")) {
        stellaToast.add({
          title: t("knowledge.mcp.connectedToast"),
          type: "success",
        });
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.mcp.all });
        return;
      }

      if (event.data.startsWith("mcp:error:")) {
        stellaToast.add({
          title: t("knowledge.mcp.errorTitle"),
          description: t("knowledge.mcp.errorDescription"),
          type: "error",
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [queryClient, t]);

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

      <ConnectorSection
        addServerCard={
          canManageCustomConnectors ? (
            <AddServerCard
              onChanged={() => {
                void queryClient.invalidateQueries({
                  queryKey: knowledgeKeys.mcp.all,
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
            queryKey: knowledgeKeys.mcp.all,
          });
        }}
        userCanManageCustomConnectors={canManageCustomConnectors}
      />

      {connectors.length === 0 &&
        nativeTools.length === 0 &&
        !canManageCustomConnectors &&
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

  const deleteConnector = async () => {
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
                {t("knowledge.mcp.recommendedTitle")}
              </span>
            )}
            <ConnectionStatusBadge connection={connection} />
            <AuthBadge authType={connector.authType} />
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {connector.description}
          </p>
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
        {canDeleteConnector && (
          <Button
            disabled={busy}
            onClick={() => void deleteConnector()}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="me-1.5 size-4" />
            {t("common.delete")}
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
                {t("knowledge.mcp.recommendedTitle")}
              </span>
            )}
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
              {t("knowledge.mcp.builtInBadge")}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {tool.description}
          </p>
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

function AuthBadge({ authType }: { authType: McpConnector["authType"] }) {
  const t = useTranslations();

  return (
    <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium">
      {t(`knowledge.mcp.auth.${authType}`)}
    </span>
  );
}

function AddServerCard({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="bg-card hover:bg-muted/30 focus-visible:ring-ring flex min-h-[176px] flex-col items-start justify-between rounded-lg border border-dashed p-5 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
          <PlusIcon className="size-5" />
        </span>
        <span>
          <span className="block text-sm font-semibold">
            {t("knowledge.mcp.addServerCardTitle")}
          </span>
          <span className="text-muted-foreground mt-1 block text-sm">
            {t("knowledge.mcp.addServerCardDescription")}
          </span>
        </span>
      </button>
      <AddServerDialog
        onChanged={onChanged}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
}

function AddServerDialog({
  onChanged,
  onOpenChange,
  open,
}: {
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useTranslations();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [createdConnector, setCreatedConnector] = useState<
    CreatedConnector | undefined
  >();
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setUrl("");
    setToken("");
    setCreatedConnector(undefined);
    setBusy(false);
  };

  const close = () => {
    onOpenChange(false);
    reset();
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
      setCreatedConnector(connector);
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
      close();
      return;
    }

    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
    close();
  };

  const addServer = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl || busy) {
      return;
    }

    setBusy(true);
    const response = await api.mcp.connectors.post({
      url: trimmedUrl,
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
    const connector = response.data.connector;
    await connectConnector(connector);
  };

  const saveToken = async () => {
    const trimmedToken = token.trim();
    if (!createdConnector || !trimmedToken || busy) {
      return;
    }

    setBusy(true);
    const response = await api.mcp.connections.post({
      connectorSlug: createdConnector.slug,
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

    stellaToast.add({
      title: t("knowledge.mcp.connectedToast"),
      type: "success",
    });
    onChanged();
    close();
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
      open={open}
    >
      <DialogPopup>
        <Form
          className="gap-0"
          onSubmit={(event) => {
            event.preventDefault();
            if (createdConnector) {
              void saveToken();
              return;
            }

            void addServer();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("knowledge.mcp.customTitle")}</DialogTitle>
            <DialogDescription>
              {t("knowledge.mcp.customDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {createdConnector
                  ? t("knowledge.mcp.tokenLabel")
                  : t("knowledge.mcp.urlLabel")}
              </span>
              <Input
                autoComplete={createdConnector ? "off" : "url"}
                autoFocus
                className={createdConnector ? "font-mono" : undefined}
                onChange={(event) =>
                  createdConnector
                    ? setToken(event.target.value)
                    : setUrl(event.target.value)
                }
                placeholder={
                  createdConnector
                    ? t("knowledge.mcp.tokenPlaceholder")
                    : t("knowledge.mcp.urlPlaceholder")
                }
                type={createdConnector ? "password" : "url"}
                value={createdConnector ? token : url}
              />
            </label>
            {createdConnector && (
              <p className="text-muted-foreground text-sm">
                {t("knowledge.mcp.bearerTokenDescription")}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              disabled={
                busy || (createdConnector ? !token.trim() : !url.trim())
              }
              type="submit"
            >
              {busy ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {createdConnector
                ? t("knowledge.mcp.saveToken")
                : t("knowledge.mcp.addAndConnect")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
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
