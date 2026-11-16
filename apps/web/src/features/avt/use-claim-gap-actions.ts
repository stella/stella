/**
 * What a reviewer does about a claim the record does not cover: add the fact
 * from a document, point the claim at a fact already on the list, then have
 * the claim checked again. Each step is its own request, in order; a re-check
 * that fails leaves the fact and the link in place, so it can be asked again.
 */

import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type {
  AddedFact,
  AddFactInput,
} from "@/features/avt/add-fact-progress-store";
import {
  addFactProgressKey,
  useAddFactProgress,
} from "@/features/avt/add-fact-progress-store";
import { avtKeys } from "@/features/avt/queries";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";
import {
  resourceMutation,
  resourceQueryOptions,
} from "@/lib/workspace-realtime";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

type GapScope = {
  workspaceId: string;
  runId: string;
  listId: string;
  claimId: string;
};

type LinkInput = { factEntityId: string; change: "link" | "unlink" };

const claimRecheckKey = ({ workspaceId, runId, claimId }: GapScope) => [
  "avt",
  workspaceId,
  "claim-recheck",
  runId,
  claimId,
];

/** Whether a re-check of the claim, from any of its buttons, is out. */
export const useClaimRecheckPending = (scope: GapScope) =>
  useIsMutating({ mutationKey: claimRecheckKey(scope) }) > 0;

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

  const postRecheck = async (requestKey: string) =>
    await invokeCapability(
      "lists.verifications.claim-rechecks.create",
      async (request) =>
        lists["claim-rechecks"].post({ ...ids, requestKey }, request),
    );
  // The key is kept while a re-check fails, so asking again cannot grade
  // the claim twice; a re-check that landed frees it for the next one.
  const recheckClaim = async () =>
    unwrapApiResponse(
      await submit.run({
        operation: `claim-recheck:${runId}:${claimId}`,
        body: ids,
        send: async (_body, replay) =>
          await postRecheck(replay.headers["Idempotency-Key"]),
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
        send: async (body, replay) =>
          await invokeCapability(
            "lists.verifications.claim-reviews.create",
            async (request) =>
              lists["claim-reviews"].post(body, {
                ...request,
                headers: {
                  "Idempotency-Key": replay.headers["Idempotency-Key"],
                  ...request.headers,
                },
              }),
          ),
      }),
    );

  const writeRecheck = resourceMutation({
    mutation: "recheckClaim",
    queryClient,
    mutationFn: async (_variables: { workspaceId: string }) =>
      await recheckClaim(),
  });
  const writeLink = resourceMutation({
    mutation: "recordClaimReview",
    queryClient,
    mutationFn: async ({ input }: { workspaceId: string; input: LinkInput }) =>
      await changeLink(input),
  });
  const recheckKey = claimRecheckKey({ workspaceId, runId, listId, claimId });
  const recheck = useMutation({
    mutationKey: recheckKey,
    mutationFn: async () => await writeRecheck({ workspaceId }),
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.recheckFailed")),
  });

  const link = useMutation({
    mutationKey: ["avt", workspaceId, "claim-link", runId, claimId],
    // A link or unlink only records what the reviewer points to; the grade
    // reads as out of date until they check the claim again, the one action
    // that calls the model.
    mutationFn: async (input: LinkInput) =>
      await writeLink({ workspaceId, input }),
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.linkFailed")),
  });

  // The steps a failed attempt already took, kept outside this panel, so
  // trying again (now or after visiting another claim) neither adds the
  // fact twice nor sources it twice. What it wrote is held fixed in the
  // sheet until it finishes: a retry completes that fact, never a changed
  // one.
  const progressKey = addFactProgressKey({ workspaceId, runId, claimId });
  const resume = useAddFactProgress(
    (state) => state.progress[progressKey]?.input ?? null,
  );
  const record = (added: AddedFact | null) => {
    useAddFactProgress.getState().record(progressKey, added);
  };

  const writeFact = resourceMutation({
    mutation: "addClaimFact",
    queryClient,
    mutationFn: async ({
      input: submitted,
    }: {
      workspaceId: string;
      input: AddFactInput;
    }) =>
      await useAddFactProgress.getState().runAttempt(progressKey, async () => {
        const previous: AddedFact | undefined =
          useAddFactProgress.getState().progress[progressKey];
        const { statement, source } = previous?.input ?? submitted;
        const createBody = {
          name: statement,
          listId: toSafeId<"legalList">(listId),
          listItemType: LIST_ITEM_TYPE.FACT,
        };
        const createOperation = `claim-add-fact:${runId}:${claimId}`;
        let pending: AddedFact = previous ?? {
          input: { statement, source },
          step: "creating",
          // Recorded before the create is sent: a retry whose response was
          // lost replays the first create instead of adding the fact twice.
          createRequest: submit.prepare({
            body: createBody,
            operation: createOperation,
          }),
          recheckKey: createUuid(),
        };
        const { input, createRequest, recheckKey: retryKey } = pending;
        const intent = { input, createRequest, recheckKey: retryKey };
        if (pending.step === "creating") {
          record(pending);
          const created = unwrapApiResponse(
            await submit.run({
              operation: createOperation,
              body: createBody,
              request: pending.createRequest,
              send: async (body, replay) =>
                await invokeCapability("tasks.create", async (request) =>
                  api
                    .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
                    .put(body, {
                      ...request,
                      headers: {
                        "Idempotency-Key": replay.headers["Idempotency-Key"],
                        ...request.headers,
                      },
                    }),
                ),
            }),
          );
          pending = { ...intent, step: "added", entityId: created.entityId };
        }
        let added = pending;
        const { entityId } = added;
        record(added);
        if (added.step === "added") {
          const sourceRequest = await prepareFactSource({
            queryClient,
            submit,
            workspaceId,
            listId,
            entityId,
            source,
          });
          added = { ...intent, step: "sourcing", entityId, sourceRequest };
          record(added);
        }
        if (added.step === "sourcing") {
          await submitFactSource({
            workspaceId,
            submit,
            sourceRequest: added.sourceRequest,
          });
          added = { ...intent, step: "sourced", entityId };
          record(added);
        }
        if (added.step === "sourced") {
          await changeLink({ factEntityId: entityId, change: "link" });
          added = { ...intent, step: "linked", entityId };
          record(added);
        }
        // The addition's own key, kept with it across claims and retries.
        unwrapApiResponse(await postRecheck(added.recheckKey));
        record(null);
      }),
  });
  const addFact = useMutation({
    mutationKey: ["avt", workspaceId, "claim-add-fact", runId, claimId],
    mutationFn: async (input: AddFactInput) =>
      await writeFact({ workspaceId, input }),
    onSettled: refresh,
    onError: (error) => notifyUserError(error, t("avt.gap.addFactFailed")),
  });

  // Every re-check button of the claim (its staleness notice, its linked
  // facts) holds its own instance of these actions; a re-check sent from
  // any of them keeps all of them busy, so none sends a second one.
  const recheckPending = useClaimRecheckPending({
    workspaceId,
    runId,
    listId,
    claimId,
  });

  return { recheck, recheckPending, link, addFact, addFactResume: resume };
};

type PrepareFactSourceOptions = {
  queryClient: QueryClient;
  submit: ReturnType<typeof useIdempotentSubmit>;
  workspaceId: string;
  listId: string;
  entityId: string;
  source: AddFactInput["source"];
};

/** Pin the submitted source to its current version inside the resumable attempt. */
const prepareFactSource = async ({
  queryClient,
  submit,
  workspaceId,
  listId,
  entityId,
  source,
}: PrepareFactSourceOptions) => {
  const document = await queryClient.query(
    resourceQueryOptions(
      {
        ...entityOptions(workspaceId, source.documentId),
        staleTime: 0,
      },
      {
        resources: [RESOURCE_TYPE.ENTITY],
        scope: { type: "workspace", workspaceId },
      },
    ),
  );
  const body = {
    listId: toSafeId<"legalList">(listId),
    itemEntityId: toSafeId<"entity">(entityId),
    sourceEntityId: toSafeId<"entity">(document.entityId),
    sourceEntityVersionId: toSafeId<"entityVersion">(document.currentVersionId),
    locator:
      source.pageNumber === null
        ? { type: "document" as const }
        : { type: "pdf-page" as const, pageNumber: source.pageNumber },
    quote: source.quote,
  };
  return {
    body,
    request: submit.prepare({
      operation: `list-source-create:${workspaceId}`,
      body,
    }),
  };
};

type SubmitFactSourceOptions = {
  workspaceId: string;
  submit: ReturnType<typeof useIdempotentSubmit>;
  sourceRequest: Extract<AddedFact, { step: "sourcing" }>["sourceRequest"];
};

const submitFactSource = async ({
  workspaceId,
  submit,
  sourceRequest,
}: SubmitFactSourceOptions) => {
  const lists = api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) });
  return unwrapApiResponse(
    await submit.run({
      operation: `list-source-create:${workspaceId}`,
      ...sourceRequest,
      send: async (body, replay) =>
        await invokeCapability("lists.items.sources.create", async (request) =>
          lists["item-sources"].post(body, {
            ...request,
            headers: {
              "Idempotency-Key": replay.headers["Idempotency-Key"],
              ...request.headers,
            },
          }),
        ),
    }),
  );
};
