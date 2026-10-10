import { useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import type { AnswerEditProposal } from "@/features/chat/answer-edit/answer-edit-api";
import {
  AnswerEditNotice,
  AnswerEditPanel,
  AnswerEditProposalReview,
} from "@/features/chat/answer-edit/answer-edit-panel";
import { createAppQueryClient } from "@/lib/react-query";

import { answerEditStates } from "../-visual-metadata";

export const AnswerEditPlayground = () => {
  const [queryClient] = useState(createAppQueryClient);
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
                      onAnswerEdited={async () => undefined}
                      request={async () => Result.ok(proposal)}
                      accept={async () =>
                        Result.ok({ revision: 1, edited: true })
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
      </div>
    </QueryClientProvider>
  );
};
