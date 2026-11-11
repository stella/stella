/**
 * What a reviewer does about a claim the record does not cover: add the fact
 * from a document, point the claim at a fact already on the list, then have
 * the claim checked again. Each step is its own request, in order; a re-check
 * that fails leaves the fact and the link in place, so it can be asked again.
 */

import * as React from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { avtKeys } from "@/features/avt/queries";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

type GapScope = {
  workspaceId: string;
  runId: string;
  listId: string;
  claimId: string;
};

/** Where a new fact comes from: a document, a page of it, and the words.
 *  The document's live version is read when the source is written. */
export type FactSourceInput = {
  documentId: string;
  pageNumber: number | null;
  quote: string | null;
};

export type AddFactInput = { statement: string; source: FactSourceInput };

/** How far adding a fact got: added to the list, sourced, linked. */
type AddedFact = {
  input: AddFactInput;
  entityId: string;
  step: "added" | "sourced" | "linked";
};

type LinkInput = { factEntityId: string; change: "link" | "unlink" };

export const useClaimGapActions = ({
  workspaceId,
  runId,
  listId,
  claimId,
}: GapScope) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const submit = useIdempotentSubmit();
  const lists = api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) });
  const ids = {
    runId: toSafeId<"legalListVerificationRun">(runId),
    claimId: toSafeId<"legalListClaim">(claimId),
  };

  const refresh = async () => {
    await Promise.all(
      [
        avtKeys.run(workspaceId, runId),
        avtKeys.reviewHistoryOfRun(workspaceId, runId),
        legalListKeys.items(workspaceId, listId),
      ].map(
        async (queryKey) => await queryClient.invalidateQueries({ queryKey }),
      ),
    );
  };

  // The key is kept while a re-check fails, so asking again cannot grade
  // the claim twice; a re-check that landed frees it for the next one.
  const recheckClaim = async () =>
    unwrapApiResponse(
      await submit.run({
        operation: `claim-recheck:${runId}:${claimId}`,
        body: ids,
        send: async (body, request) =>
          lists["claim-rechecks"].post({
            ...body,
            requestKey: request.headers["Idempotency-Key"],
          }),
      }),
    );

  const changeLink = async ({ factEntityId, change }: LinkInput) =>
    unwrapApiResponse(
      await submit.run({
        operation: `claim-fact-link:${runId}:${claimId}`,
        body: {
          ...ids,
          event: {
            kind: "fact-link" as const,
            factEntityId: toSafeId<"entity">(factEntityId),
            change,
          },
        },
        send: async (body, request) =>
          lists["claim-reviews"].post(body, request),
      }),
    );

  const recheck = useMutation({
    mutationKey: ["avt", workspaceId, "claim-recheck", runId, claimId],
    mutationFn: recheckClaim,
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.recheckFailed")),
  });

  const link = useMutation({
    mutationKey: ["avt", workspaceId, "claim-link", runId, claimId],
    mutationFn: async (input: LinkInput) => {
      await changeLink(input);
      // A link changes no verdict until the claim is checked again.
      if (input.change === "link") {
        await recheckClaim();
      }
    },
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.linkFailed")),
  });

  // The steps a failed attempt already took, so trying again neither adds
  // the fact twice nor sources it twice.
  const added = React.useRef<AddedFact | null>(null);
  // What a started addition wrote, which the sheet holds fixed until it
  // finishes: trying again completes that fact, never a changed one.
  const [resume, setResume] = React.useState<AddFactInput | null>(null);

  const addFact = useMutation({
    mutationKey: ["avt", workspaceId, "claim-add-fact", runId, claimId],
    mutationFn: async (submitted: AddFactInput) => {
      const previous = added.current;
      const { statement, source } = previous?.input ?? submitted;
      // The task endpoint takes no idempotency key; the capability header
      // declares the write.
      const entityId =
        previous?.entityId ??
        (
          await invokeCapability("tasks.create", async (request) =>
            unwrapApiResponse(
              await api
                .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
                .put(
                  {
                    name: statement,
                    listId: toSafeId<"legalList">(listId),
                    listItemType: LIST_ITEM_TYPE.FACT,
                  },
                  request,
                ),
            ),
          )
        ).entityId;
      added.current = {
        input: { statement, source },
        entityId,
        step: previous?.step ?? "added",
      };
      setResume(added.current.input);
      if (added.current.step === "added") {
        // The live version at submission rather than a stale pick, read
        // inside the attempt so the sheet stays busy until it is written.
        const document = await queryClient.query({
          ...entityOptions(workspaceId, source.documentId),
          staleTime: 0,
        });
        unwrapApiResponse(
          await submit.run({
            operation: `list-source-create:${workspaceId}`,
            body: {
              listId: toSafeId<"legalList">(listId),
              itemEntityId: toSafeId<"entity">(entityId),
              sourceEntityId: toSafeId<"entity">(document.entityId),
              sourceEntityVersionId: toSafeId<"entityVersion">(
                document.currentVersionId,
              ),
              locator:
                source.pageNumber === null
                  ? { type: "document" as const }
                  : {
                      type: "pdf-page" as const,
                      pageNumber: source.pageNumber,
                    },
              quote: source.quote,
            },
            send: async (body) => lists["item-sources"].post(body),
          }),
        );
        added.current = { ...added.current, step: "sourced" };
      }
      if (added.current.step === "sourced") {
        await changeLink({ factEntityId: entityId, change: "link" });
        added.current = { ...added.current, step: "linked" };
      }
      await recheckClaim();
      added.current = null;
      setResume(null);
    },
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.addFactFailed")),
  });

  return { recheck, link, addFact, addFactResume: resume };
};
