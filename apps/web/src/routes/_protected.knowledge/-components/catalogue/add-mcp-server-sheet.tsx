import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, LoaderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/components/sheet";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";

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
  | { step: "token"; createdConnector: CreatedConnector; token: string };

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
    void queryClient.invalidateQueries({
      queryKey: catalogueKeys.list(organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.mcp.all(organizationId),
    });
  };

  const close = () => {
    setWizard(initialWizard());
    onOpenChange(false);
  };

  const handleApiError = (error: unknown) => {
    stellaToast.add({
      title: t("knowledge.mcp.errorTitle"),
      description: userErrorFromThrown(
        error,
        t("knowledge.mcp.errorDescription"),
      ),
      type: "error",
    });
  };

  const connectMutation = useMutation({
    mutationFn: async (connector: CreatedConnector) => {
      const response = await api.mcp
        .connectors({ slug: connector.slug })
        .connect.post({ queryKey: ["mcp"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { connector, data: response.data };
    },
    onSuccess: ({ connector, data }) => {
      if (data.type === "bearer") {
        setWizard({ step: "token", createdConnector: connector, token: "" });
        return;
      }
      if (data.type === "oauth2") {
        const popup = window.open(
          data.authorizeUrl,
          "_blank",
          "width=560,height=720",
        );
        if (!popup) {
          window.location.assign(data.authorizeUrl);
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
    mutationFn: async (trimmedUrl: string) => {
      const response = await api.mcp.connectors.post({
        url: trimmedUrl,
        queryKey: ["mcp"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      invalidate();
      connectMutation.mutate(data.connector);
    },
    onError: handleApiError,
  });

  const saveTokenMutation = useMutation({
    mutationFn: async (payload: { connectorSlug: string; token: string }) => {
      const response = await api.mcp.connections.post({
        connectorSlug: payload.connectorSlug,
        token: payload.token,
        queryKey: ["mcp"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
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
    addServerMutation.mutate(trimmedUrl);
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
      <SheetPopup className="w-full sm:max-w-[460px]" side="right">
        <SheetHeader>
          <SheetTitle>{t("knowledge.mcp.addServerCardTitle")}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          {wizard.step === "url" ? (
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
          ) : (
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
              <Input
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
                type="password"
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
          {wizard.step === "url" ? (
            <Button
              disabled={busy || !wizard.url.trim()}
              onClick={submitUrl}
              type="button"
            >
              {busy && <LoaderIcon className="size-4 animate-spin" />}
              {t("knowledge.mcp.addAndConnect")}
            </Button>
          ) : (
            <Button
              disabled={busy || !wizard.token.trim()}
              onClick={submitToken}
              type="button"
            >
              {busy ? (
                <LoaderIcon className="size-4 animate-spin" />
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
