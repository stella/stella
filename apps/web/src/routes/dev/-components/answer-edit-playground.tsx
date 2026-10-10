import { useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import type { AnswerEditProposal } from "@/features/chat/answer-edit/answer-edit-api";
import {
  AnswerEditNotice,
  AnswerEditPanel,
  AnswerEditProposalReview,
} from "@/features/chat/answer-edit/answer-edit-panel";
import { answerRevisionHistoryOptions } from "@/features/chat/answer-edit/answer-edit-queries";
import { AnswerFormattingControls } from "@/features/chat/answer-edit/answer-format-panel";
import { AnswerLinkForm } from "@/features/chat/answer-edit/answer-link-form";
import { AnswerRevisionHistoryContent } from "@/features/chat/answer-edit/answer-revision-history";
import { FormattingProvider } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createAppQueryClient } from "@/lib/react-query";

import { answerEditStates } from "../-visual-metadata";

export const AnswerEditPlayground = () => {
  const user = useAuthenticatedUser();
  const [queryClient] = useState(() => {
    const client = createAppQueryClient();
    client.setQueryData(
      answerRevisionHistoryOptions({
        activeOrganizationId: user.activeOrganizationId,
        userId: user.id,
        threadId: "fixture",
        messageId: "fixture",
        revision: 2,
      }).queryKey,
      {
        pages: [
          {
            items: [
              {
                id: "fixture-revision",
                revision: 1,
                messageId: "fixture",
                threadId: "fixture",
                workspaceId: null,
                createdBy: null,
                content: {
                  version: 3,
                  data: [
                    { type: "text", content: "Notice within thirty days." },
                  ],
                },
                createdAt: "2026-10-10T10:00:00Z",
                actorName: null,
                beforeText: "Notice within thirty days.",
                afterText: "**Notice within thirty days.**",
                edit: { type: "format", format: "bold", start: 0, end: 26 },
              },
            ],
            nextCursor: null,
            limit: 20,
          },
        ],
        pageParams: [undefined],
      },
    );
    return client;
  });
  const proposal = {
    replacement: "new text",
    content: { version: 3, data: [{ type: "text", content: "new text" }] },
    edit: {
      type: "ai_span",
      start: 0,
      end: 8,
      instruction: "Clarify",
      model: "fixture",
      keySource: "instance",
    },
  } as const satisfies AnswerEditProposal;
  return (
    <QueryClientProvider client={queryClient}>
      <FormattingProvider locale="en" timeZone="UTC">
        <div className="grid gap-4 p-6 sm:grid-cols-2">
          {answerEditStates.map((status) => (
            <section
              key={status}
              data-answer-edit-state={status}
              className="bg-popover text-popover-foreground space-y-3 rounded-md border p-3 shadow-md"
            >
              <h2 className="text-muted-foreground text-xs">{status}</h2>
              {(() => {
                switch (status) {
                  case "instruction":
                    return (
                      <AnswerEditPanel
                        anchor={{
                          messageId: "fixture",
                          baseRevision: 0,
                          start: 0,
                          end: 8,
                          selectedSource: "old text",
                        }}
                        threadId="fixture"
                        disabled={false}
                        onCancel={() => undefined}
                        onAnswerEdited={acknowledgeAnswerEdit}
                        request={async () => await Promise.resolve(Result.ok(proposal))}
                        accept={async () =>
                          await Promise.resolve(Result.ok({ revision: 1, edited: true }))
                        }
                      />
                    );
                  case "requesting":
                  case "stale":
                    return (
                      <AnswerEditNotice
                        status={status}
                        onCancel={() => undefined}
                      />
                    );
                  case "proposal":
                  case "accepting":
                    return (
                      <AnswerEditProposalReview
                        original="The notice must arrive within a reasonable period."
                        replacement="The notice must arrive within 30 days."
                        status={status}
                        disabled={false}
                        onAccept={() => undefined}
                        onCancel={() => undefined}
                      />
                    );
                  default:
                    status satisfies never;
                    return panic(
                      `Unhandled answer-edit fixture: ${String(status)}`,
                    );
                }
              })()}
            </section>
          ))}
          <section
            className="bg-popover space-y-3 rounded-md border p-3"
            data-answer-format-state="controls"
          >
            <AnswerFormattingControls
              disabled={false}
              onSelect={() => undefined}
            />
            <AnswerFormattingControls
              disabled={true}
              onSelect={() => undefined}
            />
            <AnswerLinkForm
              disabled={false}
              existingUrl="https://example.com"
              onAction={() => undefined}
              onCancel={() => undefined}
            />
          </section>
          <section
            className="bg-popover space-y-3 rounded-md border p-3"
            data-answer-format-state="proposal"
          >
            <AnswerEditPanel
              threadId="fixture"
              anchor={{
                messageId: "fixture",
                baseRevision: 1,
                start: 0,
                end: 8,
                selectedSource: "old text",
              }}
              disabled={false}
              onCancel={() => undefined}
              onAnswerEdited={acknowledgeAnswerEdit}
              initialProposal={{
                content: {
                  version: 3,
                  data: [{ type: "text", content: "**old text**" }],
                },
                replacement: "**old text**",
                edit: { type: "format", format: "bold", start: 0, end: 8 },
              }}
              accept={async () => await Promise.resolve(Result.ok({ revision: 2, edited: true }))}
            />
          </section>
          <section
            className="bg-popover rounded-md border p-3"
            data-answer-history-state="items"
          >
            <AnswerRevisionHistoryContent
              threadId="fixture"
              messageId="fixture"
              revision={2}
              disabled={false}
              enabled={false}
              onAnswerEdited={acknowledgeAnswerEdit}
            />
          </section>
        </div>
      </FormattingProvider>
    </QueryClientProvider>
  );
};

const acknowledgeAnswerEdit = async () => await Promise.resolve();
