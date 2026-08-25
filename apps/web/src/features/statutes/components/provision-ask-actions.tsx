import { useState } from "react";

import { ArrowUpIcon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Textarea } from "@stll/ui/textarea";

import { openProvisionChat } from "@/features/statutes/provision-ask";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import {
  provisionTabLabel,
  submitsOnEnter,
} from "@/features/statutes/provision-inspector.logic";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";

const QUESTION_MAX_LENGTH = 2000;

type AskPassage = {
  caseNumber: string;
  court: string;
  decisionDate: string | null;
  sentenceText: string;
};

type ProvisionAskActionsProps = {
  /** The passages applying the provision in its leading decisions. */
  passages: readonly AskPassage[];
  payload: ProvisionViewPayload;
};

/**
 * The two ways to ask about a provision: a canned request for how courts
 * apply it, and a question of the reader's own. Both open a chat with the
 * prompt in the composer. The prompt names the provision, which is what the
 * chat's corpus tools look it up by, and leads with the passages of the
 * leading decisions, so the answer starts from what the courts said and the
 * tools are reached for the rest.
 */
export const ProvisionAskActions = ({
  passages,
  payload,
}: ProvisionAskActionsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [question, setQuestion] = useState("");

  const validFrom = formatValidityDate(payload.versionValidFrom, format);
  const subject =
    validFrom === null
      ? t("statutes.provisionPromptSubjectUndated", {
          eli: payload.eli,
          provision: payload.provisionLabel,
          statute: payload.statuteTitle,
        })
      : t("statutes.provisionPromptSubject", {
          date: validFrom,
          eli: payload.eli,
          provision: payload.provisionLabel,
          statute: payload.statuteTitle,
        });
  const label = provisionTabLabel(payload);
  const context =
    passages.length === 0
      ? ""
      : t("statutes.provisionAskContextPrompt", {
          passages: passages
            .map((passage) => {
              const decided = formatValidityDate(passage.decisionDate, format);
              const source =
                decided === null
                  ? `${passage.caseNumber} (${passage.court})`
                  : `${passage.caseNumber} (${passage.court}, ${decided})`;
              return `- ${source}: ${passage.sentenceText}`;
            })
            .join("\n"),
        });

  const summarize = () => {
    openProvisionChat({
      label,
      prompt: `${t("statutes.provisionAskSummarizePrompt", { subject })}${context}`,
    });
  };

  const ask = () => {
    const trimmed = question.trim();
    if (trimmed === "") {
      return;
    }
    openProvisionChat({
      label,
      prompt: `${t("statutes.provisionAskQuestionPrompt", {
        question: trimmed,
        subject,
      })}${context}`,
    });
    setQuestion("");
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="h-auto justify-start px-2 py-1.5 text-xs font-normal whitespace-normal"
        onClick={summarize}
        size="sm"
        variant="outline"
      >
        <WandSparklesIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {t("statutes.provisionAskSummarize")}
      </Button>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <Textarea
          aria-label={t("statutes.provisionAskPlaceholder")}
          className="min-h-16 text-xs"
          maxLength={QUESTION_MAX_LENGTH}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // The native event, not the synthetic one: React does not carry
            // `isComposing`, and an IME confirming a candidate with Enter must
            // not send a half-written question.
            if (!submitsOnEnter(event.nativeEvent)) {
              return;
            }
            event.preventDefault();
            ask();
          }}
          placeholder={t("statutes.provisionAskPlaceholder")}
          value={question}
        />
        <Button
          className="self-end text-xs"
          disabled={question.trim() === ""}
          size="sm"
          type="submit"
          variant="ghost"
        >
          <ArrowUpIcon aria-hidden="true" className="size-3.5" />
          {t("common.ask")}
        </Button>
      </form>
    </div>
  );
};
