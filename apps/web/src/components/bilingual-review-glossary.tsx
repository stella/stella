/**
 * The glossary half of the bilingual-translation review: the rendering every
 * row must use for each defined term. Editable, because a proposed rendering
 * is a suggestion and the endpoint refuses a term with no translation.
 */

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";

import {
  BILINGUAL_FORMS_MAX,
  BILINGUAL_GLOSSARY_MAX,
  BILINGUAL_GLOSSARY_ORIGIN_LABEL_KEYS,
  BILINGUAL_TERM_MAX,
  type BilingualGlossaryEntry,
} from "@/components/bilingual-translate-queries";

/** One glossary entry while it is being edited: the inflected forms are one
 *  comma-separated text field rather than a list the reviewer must manage. */
export type GlossaryDraft = {
  id: string;
  source: string;
  target: string;
  sourceForms: string;
  targetForms: string;
  origin: BilingualGlossaryEntry["origin"];
};

type BilingualReviewGlossaryProps = {
  drafts: GlossaryDraft[];
  disabled: boolean;
  onChange: (drafts: GlossaryDraft[]) => void;
};

export const BilingualReviewGlossary = ({
  drafts,
  disabled,
  onChange,
}: BilingualReviewGlossaryProps) => {
  const t = useTranslations();

  const replaceDraft = (id: string, patch: Partial<GlossaryDraft>) => {
    onChange(
      drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {drafts.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("bilingualTranslate.glossary.empty")}
        </p>
      )}
      {drafts.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {drafts.map((draft) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 border-b p-2 last:border-b-0"
              key={draft.id}
            >
              <Input
                aria-label={t("bilingualTranslate.glossary.term")}
                disabled={disabled}
                maxLength={BILINGUAL_TERM_MAX}
                onChange={(event) =>
                  replaceDraft(draft.id, { source: event.target.value })
                }
                placeholder={t("bilingualTranslate.glossary.term")}
                size="sm"
                value={draft.source}
              />
              <Input
                aria-invalid={draft.target.trim().length === 0}
                aria-label={t("bilingualTranslate.glossary.translation")}
                disabled={disabled}
                maxLength={BILINGUAL_TERM_MAX}
                onChange={(event) =>
                  replaceDraft(draft.id, { target: event.target.value })
                }
                placeholder={t("bilingualTranslate.glossary.translation")}
                size="sm"
                value={draft.target}
              />
              <div className="flex items-center gap-1">
                <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
                  {t(BILINGUAL_GLOSSARY_ORIGIN_LABEL_KEYS[draft.origin])}
                </span>
                <Button
                  aria-label={t("common.remove")}
                  disabled={disabled}
                  onClick={() =>
                    onChange(drafts.filter((entry) => entry.id !== draft.id))
                  }
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <Input
                aria-label={t("bilingualTranslate.glossary.formsSource")}
                className="col-start-1"
                disabled={disabled}
                onChange={(event) =>
                  replaceDraft(draft.id, { sourceForms: event.target.value })
                }
                placeholder={t("bilingualTranslate.glossary.formsSource")}
                size="sm"
                value={draft.sourceForms}
              />
              <Input
                aria-label={t("bilingualTranslate.glossary.formsTarget")}
                disabled={disabled}
                onChange={(event) =>
                  replaceDraft(draft.id, { targetForms: event.target.value })
                }
                placeholder={t("bilingualTranslate.glossary.formsTarget")}
                size="sm"
                value={draft.targetForms}
              />
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {t("bilingualTranslate.glossary.formsHint")}
        </p>
        <Button
          disabled={disabled || drafts.length >= BILINGUAL_GLOSSARY_MAX}
          onClick={() => onChange([...drafts, newGlossaryDraft()])}
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
          {t("bilingualTranslate.glossary.add")}
        </Button>
      </div>
    </div>
  );
};

const newGlossaryDraft = (): GlossaryDraft => ({
  id: crypto.randomUUID(),
  source: "",
  target: "",
  sourceForms: "",
  targetForms: "",
  origin: "user",
});

const parseForms = (value: string): string[] =>
  value
    .split(",")
    .map((form) => form.trim())
    .filter((form) => form.length > 0);

export const glossaryDraftsFrom = (
  entries: readonly BilingualGlossaryEntry[],
): GlossaryDraft[] =>
  entries.map((entry) => ({
    id: crypto.randomUUID(),
    source: entry.source,
    target: entry.target,
    sourceForms: entry.sourceForms.join(", "),
    targetForms: entry.targetForms.join(", "),
    origin: entry.origin,
  }));

/** What blocks the run, or `null` when the glossary is startable. Every term
 *  needs both halves: the endpoint's schema rejects an empty one. */
export type GlossaryIssue = "incomplete" | "tooManyForms";

export const glossaryIssue = (
  drafts: readonly GlossaryDraft[],
): GlossaryIssue | null => {
  const incomplete = drafts.some(
    (draft) =>
      draft.source.trim().length === 0 || draft.target.trim().length === 0,
  );
  if (incomplete) {
    return "incomplete";
  }
  const overflowing = drafts.some(
    (draft) =>
      parseForms(draft.sourceForms).length > BILINGUAL_FORMS_MAX ||
      parseForms(draft.targetForms).length > BILINGUAL_FORMS_MAX,
  );
  return overflowing ? "tooManyForms" : null;
};

export const toGlossaryEntries = (
  drafts: readonly GlossaryDraft[],
): BilingualGlossaryEntry[] =>
  drafts.map((draft) => ({
    source: draft.source.trim(),
    target: draft.target.trim(),
    sourceForms: parseForms(draft.sourceForms),
    targetForms: parseForms(draft.targetForms),
    origin: draft.origin,
  }));
