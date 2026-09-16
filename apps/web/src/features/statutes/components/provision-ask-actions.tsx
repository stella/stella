import { useState } from "react";

import { ArrowUpIcon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Textarea } from "@stll/ui/textarea";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { ACCOUNT_GATE_OUTCOME } from "@/components/auth/require-account.logic";
import type { AccountGateOutcome } from "@/components/auth/require-account.logic";
import { openPublicLawChat } from "@/components/public-law-ask";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";
import {
  clearProvisionQuestionDraft,
  provisionQuestionDraftKey,
  provisionTabLabel,
  readProvisionQuestionDraft,
  submitsOnEnter,
  writeProvisionQuestionDraft,
} from "@/features/statutes/provision-inspector.logic";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { useFormatter } from "@/i18n/formatting-context";

const QUESTION_MAX_LENGTH = 2000;

type AskPassage = {
  caseNumber: string;
  court: string;
  decisionDate: string | null;
  sentenceText: string | null;
};

type ProvisionAskActionsProps = {
  /**
   * The consolidation the pane is bound to. The pane already floats a composer
   * on that document's conversation, so a question asked here joins it instead
   * of opening a second one beside it.
   */
  activeLegal: ActiveLegalDocument;
  /**
   * Whether the question may be sent. Anything but `allowed` stops here: the
   * gate has either opened, or the session is still being read. What the
   * reader wrote is kept either way.
   */
  ensureAccount: () => AccountGateOutcome;
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
  activeLegal,
  ensureAccount,
  passages,
  payload,
}: ProvisionAskActionsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const storage = useSessionStorage();
  const draftKey = provisionQuestionDraftKey(payload);
  const [question, setQuestion] = useState("");
  // Storage reads null through the server and hydration passes, so the saved
  // draft is adopted on the first render that can see it rather than in an
  // effect. Latching on the key also re-seeds when the reader moves to another
  // provision, which carries its own unsent question.
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (storage !== null && seededKey !== draftKey) {
    setSeededKey(draftKey);
    setQuestion(readProvisionQuestionDraft(storage, draftKey));
  }

  const editQuestion = (next: string) => {
    setQuestion(next);
    if (storage !== null) {
      writeProvisionQuestionDraft(storage, draftKey, next);
    }
  };

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
  const passageLines = passages.flatMap((passage) => {
    if (passage.sentenceText === null) {
      return [];
    }
    const decided = formatValidityDate(passage.decisionDate, format);
    const source =
      decided === null
        ? `${passage.caseNumber} (${passage.court})`
        : `${passage.caseNumber} (${passage.court}, ${decided})`;
    return [`- ${source}: ${passage.sentenceText}`];
  });
  const context =
    passageLines.length === 0
      ? ""
      : t("statutes.provisionAskContextPrompt", {
          passages: passageLines.join("\n"),
        });

  const summarize = () => {
    if (ensureAccount() !== ACCOUNT_GATE_OUTCOME.allowed) {
      return;
    }
    openPublicLawChat({
      document: activeLegal,
      label,
      prompt: `${t("statutes.provisionAskSummarizePrompt", { subject })}${context}`,
    });
  };

  const ask = () => {
    const trimmed = question.trim();
    if (trimmed === "") {
      return;
    }
    // The draft is already in the tab's storage, so the account round trip
    // brings the reader back to this provision with their question intact.
    if (ensureAccount() !== ACCOUNT_GATE_OUTCOME.allowed) {
      return;
    }
    openPublicLawChat({
      document: activeLegal,
      label,
      prompt: `${t("statutes.provisionAskQuestionPrompt", {
        question: trimmed,
        subject,
      })}${context}`,
    });
    setQuestion("");
    if (storage !== null) {
      clearProvisionQuestionDraft(storage, draftKey);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="h-auto justify-start px-2 py-1.5 whitespace-normal"
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
          onChange={(event) => editQuestion(event.target.value)}
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
          className="self-end"
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
