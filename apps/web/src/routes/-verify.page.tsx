import type { ReactNode } from "react";

import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { refiledStamp } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { useMountEffect } from "@stll/ui/effects";
import { LoaderState } from "@stll/ui/loader";
import { MattersNavIcon } from "@stll/ui/matter-icon";
import { stellaToast } from "@stll/ui/toast";

import { getEntityDocumentRoute } from "@/components/search-dialog.logic";
import { detached } from "@/lib/detached";
import { useWorkspaceStore } from "@/lib/workspaces/store";

import { VerifyShell } from "./-verify.pending";
import type { ReferenceLookup } from "./_protected.verify.$code";

const routeApi = getRouteApi("/_protected/verify/$code");

export function VerifyPage() {
  const lookup = routeApi.useLoaderData();
  const code = routeApi.useParams({ select: (params) => params.code });

  if (lookup.status === "not-found") {
    return <ReferenceNotFound />;
  }

  return <ReferenceOpener key={code} match={lookup} />;
}

type ReferenceOpenerProps = {
  match: Extract<ReferenceLookup, { status: "match" }>;
};

/**
 * Which sentences the toast owes the reader. The file in hand can be out of
 * date, filed under a reference the document no longer carries, or both; the
 * message renders them as one text so every language can order them itself.
 */
const referenceHistory = ({
  isSuperseded,
  refiledReference,
}: {
  isSuperseded: boolean;
  refiledReference: string | null;
}): "both" | "refiled" | "superseded" => {
  if (refiledReference === null) {
    return "superseded";
  }
  return isSuperseded ? "both" : "refiled";
};

/**
 * A resolved code goes straight to the document; the reference it was opened
 * by is reported in a toast rather than a page, so nothing stands between the
 * reader and what they came to check.
 */
const ReferenceOpener = ({ match }: ReferenceOpenerProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const isSuperseded = match.versionNumber < match.currentVersionNumber;
  const refiledReference = refiledStamp(match);
  // The verification page sits outside every matter view, so the document
  // opens under its matter's default view.
  const documentRoute = getEntityDocumentRoute({
    currentView: undefined,
    entityId: match.entityId,
    fileFieldId: match.fileFieldId,
    workspaceId: match.workspaceId,
  });
  const fileFieldId = match.fileFieldId;

  // Version history is the answer to "what am I holding, and what replaced
  // it", opened the same way the matter row opens it.
  const openVersionHistory = () => {
    if (fileFieldId === null) {
      return;
    }
    useWorkspaceStore.getState().setPdfViewerState({ sidebar: "versions" });
    detached(
      navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: documentRoute.params,
        search: {
          entity: match.entityId,
          field: fileFieldId,
          panel: "versions" as const,
        },
      }),
      "verify.open-version-history",
    );
  };

  useMountEffect(() => {
    const bdi = (chunks: ReactNode) => <BidiText>{chunks}</BidiText>;
    const title = t.rich("verify.opened", { bdi, reference: match.stamp });

    if (isSuperseded || refiledReference !== null) {
      stellaToast.add({
        title,
        description: t.rich("verify.history", {
          bdi,
          currentReference: refiledReference ?? "",
          currentVersion: match.currentVersionNumber,
          history: referenceHistory({ isSuperseded, refiledReference }),
          matterName: match.workspaceName,
          reference: match.stamp,
          version: match.versionNumber,
        }),
        // Long enough to read a two-line notice and reach the action.
        timeout: 15_000,
        type: "info",
        ...(fileFieldId === null
          ? {}
          : {
              action: {
                label: t("fileDetail.versionHistory"),
                onClick: openVersionHistory,
              },
            }),
      });
    } else {
      stellaToast.add({ title, type: "info" });
    }

    detached(navigate(documentRoute), "verify.open-document");
  });

  return (
    <VerifyShell>
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <LoaderState label={t("common.loading")} detail={match.workspaceName} />
      </div>
    </VerifyShell>
  );
};

/** Reads the same for a code that never existed and for one that belongs to
 *  another organization. */
const ReferenceNotFound = () => {
  const t = useTranslations();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      <p className="text-muted-foreground max-w-md text-sm leading-6 text-pretty">
        {t("verify.notFound")}
      </p>
      <Button render={<Link from="/" to="/workspaces" />} variant="outline">
        <MattersNavIcon /> {t("routeError.backToMatters")}
      </Button>
    </div>
  );
};
