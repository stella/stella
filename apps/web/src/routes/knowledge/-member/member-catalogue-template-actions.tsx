import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { memberKnowledgeActions } from "@/features/knowledge/member/member-knowledge";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { TemplateIntent } from "@/lib/knowledge/catalogue-intent";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { organizationListOptions } from "@/lib/organization/queries";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";
import { UseTemplateDialog } from "@/routes/knowledge/-components/use-template-dialog";

type MemberCatalogueTemplateActionsProps = {
  /** The organization the page's gate selected; the install lands there. */
  organizationId: string;
  packId: string;
  templateSlug: string;
  templateName: string;
  /** The act named in the page's query on return from sign-in, if any. */
  intent: TemplateIntent | undefined;
  /** Drops the act from the page's query once it is confirmed or cancelled. */
  onIntentSettled: () => void;
};

const CONFIRM_TITLE_KEY = {
  use: "knowledge.catalogue.confirmUseTitle",
  add: "knowledge.catalogue.confirmAddTitle",
  download: "knowledge.catalogue.confirmDownloadTitle",
} as const satisfies Record<TemplateIntent, string>;

/**
 * A member's actions on a catalogue template. Each one is confirmed first,
 * naming the template and the organization it will land in, then copies the
 * template into that library through the existing install endpoint and
 * carries on: the fill dialog, a note that it was added, or the download.
 * An act named in the page's query opens the same confirmation.
 */
export const MemberCatalogueTemplateActions = ({
  organizationId: activeOrganizationId,
  packId,
  templateSlug,
  templateName,
  intent,
  onIntentSettled,
}: MemberCatalogueTemplateActionsProps) => {
  const t = useTranslations();
  const { id: userId } = useAuthenticatedUser();
  const organizationsQuery = useQuery(organizationListOptions(userId));
  const organizationsView = useQueryView(organizationsQuery);
  useQueryViewError(organizationsView);
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;
  const organizationName =
    organizations?.find(({ id }) => id === activeOrganizationId)?.name ?? "";
  const templateActions =
    memberKnowledgeActions.useTemplateActions(activeOrganizationId);
  const [confirming, setConfirming] = useState<TemplateIntent | null>(
    intent ?? null,
  );
  const [running, setRunning] = useState(false);
  const [fillTemplateId, setFillTemplateId] = useState<string | null>(null);

  const settle = () => {
    setConfirming(null);
    if (intent !== undefined) {
      onIntentSettled();
    }
  };

  const install = async (): Promise<string | null> => {
    const response = await templateActions.installFromCatalogue(
      packId,
      templateSlug,
    );
    if (response.error) {
      notifyUserError(
        toAPIError(response.error),
        t("knowledge.catalogue.installFailed"),
        {
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        },
      );
      return null;
    }
    // A deployment without bundled packs answers its gate's marker instead.
    const installed =
      "items" in response.data
        ? response.data.items.find(({ slug }) => slug === templateSlug)
        : undefined;
    if (installed === undefined) {
      notifyUserError(undefined, t("knowledge.catalogue.installFailed"));
      return null;
    }
    templateActions.invalidateTemplates();
    return installed.templateId;
  };

  const run = async (act: TemplateIntent) => {
    setRunning(true);
    const templateId = await install().finally(() => {
      setRunning(false);
    });
    if (templateId === null) {
      return;
    }
    switch (act) {
      case "use":
        setFillTemplateId(templateId);
        return;
      case "add":
        stellaToast.add({
          type: "success",
          title: t("knowledge.catalogue.added", { name: templateName }),
        });
        return;
      case "download": {
        const sourceUrl = await templateActions.readSourceUrl(templateId);
        if (sourceUrl === null) {
          notifyUserError(undefined, t("common.unexpectedError"));
          return;
        }
        openIsolatedWindow(sourceUrl);
        return;
      }
      default: {
        act satisfies never;
        panic(`Unhandled template act: ${String(act)}`);
      }
    }
  };

  return (
    <>
      <Button disabled={running} onClick={() => setConfirming("use")} size="sm">
        {t("templates.useTemplate")}
      </Button>
      <Button
        disabled={running}
        onClick={() => setConfirming("add")}
        size="sm"
        variant="outline"
      >
        {t("knowledge.catalogue.addToLibrary")}
      </Button>
      <Button
        disabled={running}
        onClick={() => setConfirming("download")}
        size="sm"
        variant="outline"
      >
        {t("common.download")}
      </Button>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            settle();
          }
        }}
        open={confirming !== null}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirming === null
                ? ""
                : t(CONFIRM_TITLE_KEY[confirming], {
                    name: templateName,
                    organization: organizationName,
                  })}
            </DialogTitle>
            <DialogDescription>
              {t("knowledge.catalogue.confirmDescription", {
                organization: organizationName,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              disabled={confirming === null}
              onClick={() => {
                const act = confirming;
                settle();
                if (act !== null) {
                  detached(run(act), "knowledge-catalogue.run");
                }
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {fillTemplateId !== null && (
        <UseTemplateDialog
          onOpenChange={(open) => {
            if (!open) {
              setFillTemplateId(null);
            }
          }}
          open
          templateId={fillTemplateId}
          templateName={templateName}
        />
      )}
    </>
  );
};
