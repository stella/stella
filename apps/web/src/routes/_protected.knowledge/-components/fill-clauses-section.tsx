import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

import type { ClauseBody } from "./clause-editor-types";

type ClauseSlot = { patchKey: string; name: string; body: ClauseBody };

type FillClausesSectionProps = {
  templateId: string;
  /** Per-fill clause overrides, keyed by slot patch key. */
  overrides: Record<string, ClauseBody>;
  onChange: (overrides: Record<string, ClauseBody>) => void;
};

/** Lists the clauses a template inserts and lets the filler tweak each one with
 *  AI for this fill only (the edit rides along as a `clauseOverrides` entry; the
 *  stored clause is untouched). Renders nothing when the template has no
 *  resolvable clause slots. */
export const FillClausesSection = ({
  templateId,
  overrides,
  onChange,
}: FillClausesSectionProps) => {
  const t = useTranslations();

  const { data } = useQuery({
    queryKey: ["template-clause-slots", templateId],
    queryFn: async () => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        ["clause-slots"].get();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

  const slots = data?.slots ?? [];
  if (slots.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-foreground text-sm font-semibold">
        {t("common.clauses")}
      </h3>
      <ul className="flex flex-col gap-2">
        {slots.map((slot) => (
          <ClauseFillItem
            key={slot.patchKey}
            onChange={(body) =>
              onChange({ ...overrides, [slot.patchKey]: body })
            }
            onReset={() =>
              onChange(
                Object.fromEntries(
                  Object.entries(overrides).filter(
                    ([key]) => key !== slot.patchKey,
                  ),
                ),
              )
            }
            override={overrides[slot.patchKey]}
            slot={slot}
          />
        ))}
      </ul>
    </section>
  );
};

const bodyToText = (body: ClauseBody): string =>
  body
    .filter((paragraph) => paragraph.isDirective !== true)
    .map((paragraph) => paragraph.text)
    .join("\n")
    .trim();

type ClauseFillItemProps = {
  slot: ClauseSlot;
  override: ClauseBody | undefined;
  onChange: (body: ClauseBody) => void;
  onReset: () => void;
};

const ClauseFillItem = ({
  slot,
  override,
  onChange,
  onReset,
}: ClauseFillItemProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [adjusting, setAdjusting] = useState(false);

  const body = override ?? slot.body;
  const edited = override !== undefined;

  const handleAdjust = async () => {
    const trimmed = instruction.trim();
    if (trimmed === "") {
      return;
    }
    setAdjusting(true);
    const response = await api.clauses["ai-rewrite"].post({
      body,
      instruction: trimmed,
    });
    setAdjusting(false);
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    onChange(response.data.body);
    setOpen(false);
    setInstruction("");
  };

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{slot.name}</span>
          {edited && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
              {t("common.edited")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {edited && (
            <Button onClick={onReset} size="xs" type="button" variant="ghost">
              {t("common.reset")}
            </Button>
          )}
          <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger
              render={
                <Button
                  aria-label={t("ai.editWithAI")}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <WandSparklesIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-80" side="bottom">
              <div className="flex flex-col gap-2 p-1">
                <Textarea
                  autoFocus
                  className="min-h-16 text-sm"
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={t("ai.refinePlaceholder")}
                  value={instruction}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => setOpen(false)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={adjusting || instruction.trim() === ""}
                    onClick={() => void handleAdjust()}
                    size="sm"
                    type="button"
                  >
                    <WandSparklesIcon className="size-3.5" />
                    {t("ai.editWithAI")}
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      <p className="text-muted-foreground mt-2 line-clamp-4 text-xs whitespace-pre-wrap">
        {bodyToText(body)}
      </p>
    </li>
  );
};
