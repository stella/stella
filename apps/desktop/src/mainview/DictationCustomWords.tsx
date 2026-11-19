import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "@stll/api-contract/transcription";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { TruncatedText } from "@stll/ui/truncated-text";

import { SettingsGroup, SettingsRow, settingsRowIds } from "./settings-layout";

type Problem = "duplicate" | "failed" | "full";

const ROW_ID = "dictation-custom-words";

/** Whether the list holds `word` already, whatever its case, the way the
 *  native side keeps each word once. */
const listed = (words: readonly string[], word: string): boolean => {
  const key = word.toLocaleLowerCase();
  return words.some((known) => known.toLocaleLowerCase() === key);
};

/**
 * The speaker's custom words: names and terms stella should spell the way
 * they do. The native side keeps them on this computer for the dictation
 * account; stella AI transcription and AI cleanup get them, the speech
 * model on this computer does not. `onChange` resolves to whether the
 * native side stored the new list.
 */
export const DictationCustomWords = ({
  onChange,
  words,
}: {
  onChange: (words: string[]) => Promise<boolean>;
  words: readonly string[];
}) => {
  const t = useTranslations("dictation.customWords");
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const ids = settingsRowIds(ROW_ID);
  const full = words.length >= MAX_TRANSCRIPTION_VOCABULARY_TERMS;

  const save = async (next: string[]): Promise<boolean> => {
    const saved = await onChange(next);
    setProblem(saved ? null : "failed");
    return saved;
  };

  const add = async () => {
    const word = draft.trim();
    if (word === "") {
      return;
    }
    if (listed(words, word)) {
      setProblem("duplicate");
      return;
    }
    if (full) {
      setProblem("full");
      return;
    }
    if (await save([...words, word])) {
      setDraft("");
    }
  };

  const problemText = (shown: Problem) => {
    switch (shown) {
      case "duplicate":
        return t("duplicate");
      case "full":
        return t("full", { limit: MAX_TRANSCRIPTION_VOCABULARY_TERMS });
      case "failed":
        return t("failed");
      default:
        shown satisfies never;
        return panic("Unhandled custom words problem");
    }
  };

  return (
    <SettingsGroup title={t("group")}>
      <SettingsRow
        description={t("description")}
        footer={
          problem === null ? null : (
            <p className="text-destructive-foreground text-xs" role="alert">
              {problemText(problem)}
            </p>
          )
        }
        id={ROW_ID}
        title={t("title")}
      >
        <span className="text-muted-foreground text-sm tabular-nums">
          {t("count", {
            count: words.length,
            limit: MAX_TRANSCRIPTION_VOCABULARY_TERMS,
          })}
        </span>
      </SettingsRow>
      <li className="px-4 py-2.5">
        <Form
          density="compact"
          layout="inline"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            aria-describedby={ids.description}
            aria-label={t("input")}
            autoComplete="off"
            className="min-w-0 flex-1"
            maxLength={MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value);
              if (problem !== "failed") {
                setProblem(null);
              }
            }}
            placeholder={t("input")}
            spellCheck={false}
            value={draft}
          />
          <Button
            disabled={draft.trim() === "" || full}
            type="submit"
            variant="outline"
          >
            {t("add")}
          </Button>
        </Form>
      </li>
      {words.length > 0 && (
        <li className="px-4 pb-3">
          <ul aria-label={t("group")} className="flex flex-wrap gap-1.5">
            {words.map((word) => (
              <li
                className="bg-muted flex max-w-full items-center gap-0.5 rounded-lg ps-2.5 text-sm"
                key={word}
              >
                <TruncatedText className="min-w-0">{word}</TruncatedText>
                <Button
                  aria-label={t("remove", { word })}
                  onClick={() => {
                    void save(words.filter((known) => known !== word));
                  }}
                  // The page's controls share one height.
                  size="icon"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        </li>
      )}
    </SettingsGroup>
  );
};
