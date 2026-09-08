import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader, LoaderState } from "@stll/ui/loader";
import { stellaToast } from "@stll/ui/toast";

import { toFileTab } from "@/components/inspector/open-entities.logic";
import { MattersNavIcon } from "@/components/matter-icon";
import { getEntityDocumentRoute } from "@/components/search-dialog.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import { isVerificationCode } from "@/lib/document-reference";

/**
 * Where the verification code printed in a document leads. The API answers
 * the same 404 for a code that belongs to another organization as for one
 * that was never minted, and this route says no more than that back: a reader
 * outside the firm learns nothing about documents they cannot see.
 */
type ReferenceLookup =
  | { status: "not-found" }
  | {
      status: "match";
      currentVersionNumber: number;
      entityId: string;
      /** The document's file field, or null when the entity carries none. */
      fileFieldId: string | null;
      /** The reference frozen onto the version the code names. */
      stamp: string;
      versionNumber: number;
      workspaceId: string;
      workspaceName: string;
    };

const NOT_FOUND = { status: "not-found" } as const satisfies ReferenceLookup;

export const Route = createFileRoute("/_protected/verify/$code")({
  component: VerifyReferenceRoute,
  pendingComponent: VerifyReferencePending,
  loader: async ({
    abortController,
    context,
    params,
  }): Promise<ReferenceLookup> => {
    if (!isVerificationCode(params.code)) {
      return NOT_FOUND;
    }

    const response = await api
      .verify({ code: params.code })
      .get({ fetch: { signal: abortController.signal } });

    // 404 is the only answer this route reads: everything else is a genuine
    // failure and belongs to the route's error boundary.
    if (response.error && response.error.status === 404) {
      return NOT_FOUND;
    }

    const match = unwrapEden(response);
    // The document opens on its file field, so resolve which one through the
    // owner of the entity-to-file projection rather than picking a field here;
    // only its id is needed, the tab itself is the inspector's business.
    const entity = await ensureRouteQueryData(
      context.queryClient,
      entityOptions(match.workspaceId, match.entityId),
    );
    const fileTab = toFileTab({
      entityId: match.entityId,
      fields: entity.fields,
      label: "",
      workspaceId: match.workspaceId,
    });

    return {
      status: "match",
      currentVersionNumber: match.currentVersionNumber,
      entityId: match.entityId,
      fileFieldId: fileTab?.id ?? null,
      stamp: match.stamp,
      versionNumber: match.versionNumber,
      workspaceId: match.workspaceId,
      workspaceName: match.workspaceName,
    };
  },
});

function VerifyReferenceRoute() {
  const lookup = Route.useLoaderData();

  if (lookup.status === "not-found") {
    return <ReferenceNotFound />;
  }

  return <ReferenceOpener match={lookup} />;
}

function VerifyReferencePending() {
  const t = useTranslations();

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Loader label={t("common.loading")} size="lg" />
    </div>
  );
}

type ReferenceOpenerProps = {
  match: Extract<ReferenceLookup, { status: "match" }>;
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
  const documentRoute = getEntityDocumentRoute({
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
        params: { workspaceId: match.workspaceId, viewId: "all" },
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
    const title = t.rich("verify.opened", {
      bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
      reference: match.stamp,
    });

    if (isSuperseded) {
      stellaToast.add({
        title,
        description: t("verify.superseded", {
          currentVersion: match.currentVersionNumber,
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
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <LoaderState label={t("common.loading")} detail={match.workspaceName} />
    </div>
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
