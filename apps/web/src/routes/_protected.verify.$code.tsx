import { createFileRoute } from "@tanstack/react-router";

import { isVerificationCode } from "@stll/api-contract";

import { toFileTab } from "@/components/inspector/open-entities.logic";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { entityOptions } from "@/lib/workspaces/queries/entities";

import { VerifyPage } from "./-verify.page";
import { VerifyPending } from "./-verify.pending";

/**
 * Where the verification code printed in a document leads. The API answers
 * the same 404 for a code that belongs to another organization as for one
 * that was never minted, and this route says no more than that back: a reader
 * outside the firm learns nothing about documents they cannot see.
 */
export type ReferenceLookup =
  | { status: "not-found" }
  | {
      status: "match";
      currentVersionNumber: number;
      entityId: string;
      /** The document's file field, or null when the entity carries none. */
      fileFieldId: string | null;
      /** The reference frozen onto the version the code names. */
      stamp: string;
      /** The reference the document's current version carries, if any. */
      currentStamp: string | null;
      versionNumber: number;
      workspaceId: string;
      workspaceName: string;
    };

const NOT_FOUND = { status: "not-found" } as const satisfies ReferenceLookup;

export const Route = createFileRoute("/_protected/verify/$code")({
  component: VerifyPage,
  pendingComponent: VerifyPending,
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
    if (response.error?.status === 404) {
      return NOT_FOUND;
    }

    const match = unwrapApiResponse(response);
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
      currentStamp: match.currentStamp,
      versionNumber: match.versionNumber,
      workspaceId: match.workspaceId,
      workspaceName: match.workspaceName,
    };
  },
});
