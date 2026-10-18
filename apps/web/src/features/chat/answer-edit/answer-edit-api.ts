import { Result } from "better-result";
import type { InferOk } from "better-result";

import type { ChatMessageAcceptedEdit } from "@stll/api-contract/chat-message-revisions";
import { sha256Hex } from "@stll/sha256/browser";

import { api } from "@/lib/api";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";

export type AnswerEditAnchor = {
  messageId: string;
  baseRevision: number;
  start: number;
  end: number;
  selectedSource: string;
};

type RequestAnswerEditOptions = {
  threadId: string;
  anchor: AnswerEditAnchor;
  instruction: string;
  signal: AbortSignal;
};

export const requestAnswerEdit = async ({
  threadId,
  anchor,
  instruction,
  signal,
}: RequestAnswerEditOptions) =>
  await Result.tryPromise({
    try: async () => {
      const selectedTextHash = await sha256Hex(anchor.selectedSource);
      const messageResource = api.chat
        .threads({ threadId })
        .messages({ messageId: anchor.messageId });
      return unwrapEden(
        await messageResource["span-edit"].post(
          {
            baseRevision: anchor.baseRevision,
            start: anchor.start,
            end: anchor.end,
            selectedTextHash,
            instruction,
          },
          { fetch: { signal } },
        ),
      );
    },
    catch: (error) =>
      APIError.is(error) ? error : toAPIError({ status: 500, value: error }),
  });

export type AnswerEditProposal = {
  content: InferOk<Awaited<ReturnType<typeof requestAnswerEdit>>>["content"];
  replacement: string;
  edit: ChatMessageAcceptedEdit;
};

type AcceptAnswerEditOptions = {
  threadId: string;
  anchor: AnswerEditAnchor;
  proposal: AnswerEditProposal;
};

export const acceptAnswerEdit = async ({
  threadId,
  anchor,
  proposal,
}: AcceptAnswerEditOptions) =>
  await Result.tryPromise({
    try: async () =>
      unwrapEden(
        await api.chat
          .threads({ threadId })
          .messages({ messageId: anchor.messageId })
          .revisions.post({
            baseRevision: anchor.baseRevision,
            selectedTextHash: await sha256Hex(anchor.selectedSource),
            content: proposal.content,
            edit: proposal.edit,
          }),
      ),
    catch: (error) =>
      APIError.is(error) ? error : toAPIError({ status: 500, value: error }),
  });
