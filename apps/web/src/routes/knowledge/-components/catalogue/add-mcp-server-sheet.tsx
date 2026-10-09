import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { KeyRoundIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { stellaToast } from "@stll/ui/toast";

import { McpAuthorizationReview } from "@/components/mcp-authorization-review";
import { SecretInput } from "@/components/secret-input";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";
import { openMcpOAuthWindow } from "@/lib/mcp-oauth-channel";

type CreatedConnector = {
  slug: string;
  authType: "none" | "bearer" | "oauth2";
};

type AddMcpServerSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
};

type WizardState =
  | { step: "url"; url: string }
  | {
      step: "confirmation";
      url: string;
      issuer: string;
      endpointOrigins: string[];
    }
  | { step: "token"; createdConnector: CreatedConnector; token: string };

type AddServerParams = {
  url: string;
  confirmedIssuer?: string;
  confirmedEndpointOrigins?: string[];
};

const initialWizard = (): WizardState => ({ step: "url", url: "" });

export const AddMcpServerSheet = ({
  open,
  onOpenChange,
  organizationId,
}: AddMcpServerSheetProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [wizard, setWizard] = useState<WizardState>(initialWizard);

  const invalidate = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: catalogueKeys.all(organizationId),
      }),
      "add-mcp-server-sheet.invalidate",
    );
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.mcp.all(organizationId),
      }),
      "add-mcp-server-sheet.invalidate",
    );
  };

  const close = () => {
    setWizard(initialWizard());
    onOpenChange(false);
  };

  const handleApiError = (error: unknown) => {
    notifyUserError(error, t("knowledge.mcp.errorTitle"), {
      description: userErrorFromThrown(
        error,
        t("knowledge.mcp.errorDescription"),
      ),
    });
  };

  const connectMutation = useMutation({
    mutationFn: async (connector: CreatedConnector) => {
      const response = await api.mcp
        .connectors({ slug: connector.slug })
        .connect.post({});
      return { connector, data: unwrapEden(response) };
    },
    onSuccess: ({ connector, data }) => {
      if (data.type === "bearer") {
        setWizard({ step: "token", createdConnector: connector, token: "" });
        return;
      }
      if (data.type === "oauth2") {
        const openStatus = openMcpOAuthWindow(data.authorizeUrl);
        if (openStatus === "invalid") {
          notifyUserError(undefined, t("knowledge.mcp.errorTitle"), {
            description: t("knowledge.mcp.errorDescription"),
          });
          return;
        }
        invalidate();
        close();
        return;
      }
      stellaToast.add({
        title: t("knowledge.mcp.connectedToast"),
        type: "success",
      });
      invalidate();
      close();
    },
    onError: handleApiError,
  });

  const addServerMutation = useMutation({
    mutationFn: async (params: AddServerParams) => {
      const response = await api.mcp.connectors.post(params);
      return unwrapEden(response);
    },
    onSuccess: (data, { url }) => {
      switch (data.type) {
        case "confirmation_required":
          setWizard({
            step: "confirmation",
            url,
            issuer: data.issuer,
            endpointOrigins: data.endpointOrigins,
          });
          return;
        case "created":
          invalidate();
          connectMutation.mutate(data.connector);
          return;
        default:
          panic(data satisfies never);
      }
    },
    onError: handleApiError,
  });

  const saveTokenMutation = useMutation({
    mutationFn: async (payload: { connectorSlug: string; token: string }) => {
      const response = await api.mcp.connections.post({
        connectorSlug: payload.connectorSlug,
        token: payload.token,
      });
      return unwrapEden(response);
    },
    onSuccess: () => {
      stellaToast.add({
        title: t("knowledge.mcp.connectedToast"),
        type: "success",
      });
      invalidate();
      close();
    },
    onError: handleApiError,
  });

  const busy =
    connectMutation.isPending ||
    addServerMutation.isPending ||
    saveTokenMutation.isPending;

  const submitUrl = () => {
    if (wizard.step !== "url") {
      return;
    }
    const trimmedUrl = wizard.url.trim();
    if (!trimmedUrl || busy) {
      return;
    }
    addServerMutation.mutate({ url: trimmedUrl });
  };

  const confirmAuthorization = () => {
    if (wizard.step !== "confirmation" || busy) {
      return;
    }
    addServerMutation.mutate({
      url: wizard.url,
      confirmedIssuer: wizard.issuer,
      confirmedEndpointOrigins: wizard.endpointOrigins,
    });
  };

  const submitToken = () => {
    if (wizard.step !== "token") {
      return;
    }
    const trimmedToken = wizard.token.trim();
    if (!trimmedToken || busy) {
      return;
    }
    saveTokenMutation.mutate({
      connectorSlug: wizard.createdConnector.slug,
      token: trimmedToken,
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
          return;
        }
        onOpenChange(next);
      }}
    >
      <SheetPopup className="w-full sm:max-w-[460px]" side="inline-end">
        <SheetHeader>
          <SheetTitle>{t("knowledge.mcp.addServerCardTitle")}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          {wizard.step === "url" && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                submitUrl();
              }}
            >
              <label className="text-sm font-medium" htmlFor="mcp-url">
                {t("knowledge.mcp.urlLabel")}
              </label>
              <Input
                autoComplete="url"
                autoFocus
                dir="ltr"
                id="mcp-url"
                inputMode="url"
                onChange={(event) =>
                  setWizard({ step: "url", url: event.target.value })
                }
                placeholder={t("knowledge.mcp.urlPlaceholder")}
                type="text"
                value={wizard.url}
              />
              <p className="text-muted-foreground text-xs">
                {t("knowledge.mcp.bearerTokenDescription")}
              </p>
            </form>
          )}
          {wizard.step === "confirmation" && (
            <McpAuthorizationReview
              issuer={wizard.issuer}
              endpointOrigins={wizard.endpointOrigins}
            />
          )}
          {wizard.step === "token" && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                submitToken();
              }}
            >
              <label className="text-sm font-medium" htmlFor="mcp-token">
                {t("knowledge.mcp.tokenLabel")}
              </label>
              <SecretInput
                autoComplete="off"
                autoFocus
                className="font-mono"
                id="mcp-token"
                onChange={(event) =>
                  setWizard((prev) =>
                    prev.step === "token"
                      ? { ...prev, token: event.target.value }
                      : prev,
                  )
                }
                placeholder={t("knowledge.mcp.tokenPlaceholder")}
                value={wizard.token}
              />
              <p className="text-muted-foreground text-xs">
                {t("knowledge.mcp.bearerTokenDescription")}
              </p>
            </form>
          )}
        </SheetPanel>
        <SheetFooter>
          <Button onClick={close} type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
          {wizard.step === "url" && (
            <Button
              disabled={busy || !wizard.url.trim()}
              onClick={submitUrl}
              type="button"
            >
              {busy && (
                <Loader
                  className="size-4"
                  label={t("common.loading")}
                  size="sm"
                />
              )}
              {t("knowledge.mcp.addAndConnect")}
            </Button>
          )}
          {wizard.step === "confirmation" && (
            <Button
              disabled={busy}
              onClick={confirmAuthorization}
              type="button"
            >
              {busy && (
                <Loader
                  className="size-4"
                  label={t("common.loading")}
                  size="sm"
                />
              )}
              {t("common.approve")}
            </Button>
          )}
          {wizard.step === "token" && (
            <Button
              disabled={busy || !wizard.token.trim()}
              onClick={submitToken}
              type="button"
            >
              {busy ? (
                <Loader
                  className="size-4"
                  label={t("common.loading")}
                  size="sm"
                />
              ) : (
                <KeyRoundIcon className="size-4" />
              )}
              {t("knowledge.mcp.saveToken")}
            </Button>
          )}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
};
