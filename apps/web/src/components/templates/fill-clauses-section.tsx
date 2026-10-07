import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { ClauseBody } from "@/components/templates/clause-editor-types";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

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

  const dataQuery = useQuery({
    queryKey: ["template-clause-slots", templateId],
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        ["clause-slots"].get({ fetch: { signal } });
      return unwrapEden(response);
    },
  });
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data = dataView.type === "items" ? dataView.items : undefined;

  const slots = data ? data.slots : [];
  if (slots.length === 0) {
    return <QueryViewFeedback view={dataView} />;
  }

  return (
    <section className="flex flex-col gap-2">
      <QueryViewFeedback view={dataView} />
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

const bodyToText = (body: ClauseBody): string => {
  const lines: string[] = [];
  for (const paragraph of body) {
    if (paragraph.isDirective !== true) {
      lines.push(paragraph.text);
    }
  }
  return lines.join("\n").trim();
};

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
  const [adjusting, setAdjusting] = useState(false);

  const body = override ?? slot.body;
  const edited = override !== undefined;

  const handleAdjust = async (instruction: string) => {
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
      notifyUserError(toAPIError(response.error), t("ai.editWithAI"));
      return;
    }
    onChange(response.data.body);
  };

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" dir="auto">
            {slot.name}
          </span>
          {edited && (
            <span className="bg-muted text-muted-foreground text-3xs rounded px-1.5 py-0.5 font-medium">
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
          <AiRewriteControl
            isPending={adjusting}
            onRewrite={(instruction) => {
              detached(
                handleAdjust(instruction),
                "fill-clauses-section.adjust",
              );
            }}
          />
        </div>
      </div>
      <p className="text-muted-foreground mt-2 line-clamp-4 text-xs whitespace-pre-wrap">
        {bodyToText(body)}
      </p>
    </li>
  );
};
