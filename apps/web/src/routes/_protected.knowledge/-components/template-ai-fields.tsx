import { useState } from "react";

import { CheckIcon, Loader2Icon, WandSparklesIcon, XIcon } from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverPanel,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { useTemplateStudioStore } from "@/routes/_protected.knowledge/-components/template-studio-store";
import {
  type EditableField,
  INPUT_TYPES,
  isInputType,
} from "@/routes/_protected.knowledge/-components/template-wizard";

type InputType = EditableField["inputType"];
type Scope = "document" | "selection";

// A returned suggestion the user can edit (name + type) before accepting.
type Proposal = {
  literalText: string;
  path: string;
  inputType: InputType;
  aiPrompt: string | undefined;
};

type AiSuggestFieldsProps = {
  getView: () => EditorView | null;
};

// Find the first single-text-node occurrence of `literal` and return its PM
// range. Mirrors the backend's single-run constraint: a literal split across
// formatting runs is reported as not-found rather than partially wrapped.
const findLiteralRange = (
  view: EditorView,
  literal: string,
): { from: number; to: number } | null => {
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found) {
      return false;
    }
    if (node.isText && node.text) {
      const idx = node.text.indexOf(literal);
      if (idx !== -1) {
        found = { from: pos + idx, to: pos + idx + literal.length };
        return false;
      }
    }
    return true;
  });
  return found;
};

// Derive a field path not already taken in the session (append _2, _3, …).
const uniquePath = (base: string): string => {
  const taken = useTemplateStudioStore.getState().fields;
  if (!taken.some((f) => f.path === base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.some((f) => f.path === candidate)) {
      return candidate;
    }
  }
};

/**
 * In-editor "AI suggests fields": the user picks the scope (whole document or
 * the current selection), optionally adds instructions, and the model proposes
 * fields. Each proposal's name + type stay editable; accepting wraps the matched
 * span as `{{field}}` and registers it in the session.
 */
export const AiSuggestFields = ({ getView }: AiSuggestFieldsProps) => {
  const t = useTranslations();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);

  const [open, setOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [scope, setScope] = useState<Scope>("document");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const view = getView();
      const selected = view ? !view.state.selection.empty : false;
      setHasSelection(selected);
      setScope(selected ? "selection" : "document");
    }
    setOpen(next);
  };

  const scopeText = (view: EditorView): string => {
    const { doc, selection } = view.state;
    if (scope === "selection") {
      return doc.textBetween(selection.from, selection.to, "\n", "\n");
    }
    return doc.textBetween(0, doc.content.size, "\n", "\n");
  };

  const handleSuggest = async () => {
    const view = getView();
    if (!view) {
      return;
    }
    const text = scopeText(view).trim();
    if (text.length === 0) {
      stellaToast.add({ type: "error", title: t("templates.studio.aiNoText") });
      return;
    }
    const trimmedInstructions = instructions.trim();
    setLoading(true);
    const { data, error } = await api.templates["suggest-fields"].post({
      text,
      ...(trimmedInstructions ? { instructions: trimmedInstructions } : {}),
    });
    setLoading(false);

    if (error) {
      stellaToast.add({
        type: "error",
        title: t("templates.studio.aiSuggestFailed"),
        description: userErrorMessage(error, t("common.unexpectedError")),
      });
      return;
    }

    const next: Proposal[] = data.suggestions.map((s) => ({
      literalText: s.literalText,
      path: s.fieldPath,
      inputType: s.inputType && isInputType(s.inputType) ? s.inputType : "text",
      aiPrompt: s.aiPrompt,
    }));
    setProposals(next);
    if (next.length === 0) {
      stellaToast.add({
        type: "info",
        title: t("templates.studio.aiNoFields"),
      });
    }
  };

  const updateProposal = (index: number, patch: Partial<Proposal>) => {
    setProposals((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
  };

  const dismiss = (index: number) => {
    setProposals((prev) => prev.filter((_, i) => i !== index));
  };

  const accept = (index: number) => {
    const proposal = proposals[index];
    const view = getView();
    if (!proposal || !view) {
      return;
    }
    const range = findLiteralRange(view, proposal.literalText);
    if (!range) {
      stellaToast.add({
        type: "error",
        title: t("templates.studio.aiSpanNotFound"),
      });
      return;
    }
    const path = uniquePath(proposal.path.trim() || "field");
    view.dispatch(
      view.state.tr
        .insertText(`{{${path}}}`, range.from, range.to)
        .scrollIntoView(),
    );
    view.focus();
    upsertField(path, {
      inputType: proposal.inputType,
      ...(proposal.aiPrompt ? { aiPrompt: proposal.aiPrompt } : {}),
    });
    dismiss(index);
  };

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger
        render={
          <Button size="sm" variant="outline">
            <WandSparklesIcon />
            {t("templates.studio.aiSuggest")}
          </Button>
        }
      />
      <PopoverPanel align="end" className="w-96">
        <div className="flex items-center gap-1">
          <Button
            className="flex-1"
            onClick={() => setScope("document")}
            size="sm"
            variant={scope === "document" ? "secondary" : "ghost"}
          >
            {t("templates.studio.aiScopeDocument")}
          </Button>
          <Button
            className="flex-1"
            disabled={!hasSelection}
            onClick={() => setScope("selection")}
            size="sm"
            variant={scope === "selection" ? "secondary" : "ghost"}
          >
            {t("templates.studio.aiScopeSelection")}
          </Button>
        </div>

        <Textarea
          className="min-h-16 text-sm"
          onChange={(e) => setInstructions(e.currentTarget.value)}
          placeholder={t("templates.studio.aiInstructionsPlaceholder")}
          value={instructions}
        />

        <Button
          disabled={loading}
          onClick={() => void handleSuggest()}
          size="sm"
        >
          {loading ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <WandSparklesIcon />
          )}
          {loading
            ? t("templates.studio.aiAnalyzing")
            : t("templates.studio.aiSuggest")}
        </Button>

        {proposals.length > 0 && (
          <ScrollArea className="max-h-80">
            <ul className="flex flex-col gap-2">
              {proposals.map((proposal, index) => (
                <li
                  className="flex flex-col gap-1.5 rounded-md border p-2"
                  key={`${proposal.literalText}-${index}`}
                >
                  <p className="text-muted-foreground truncate text-xs italic">
                    {proposal.literalText}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-7 flex-1 text-xs"
                      onChange={(e) =>
                        updateProposal(index, { path: e.currentTarget.value })
                      }
                      value={proposal.path}
                    />
                    <Select
                      onValueChange={(value) => {
                        if (typeof value === "string" && isInputType(value)) {
                          updateProposal(index, { inputType: value });
                        }
                      }}
                      value={proposal.inputType}
                    >
                      <SelectTrigger className="h-7 w-28 text-xs" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {INPUT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`templates.inputTypes.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Button
                      aria-label={t("templates.studio.aiAccept")}
                      onClick={() => accept(index)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <CheckIcon />
                    </Button>
                    <Button
                      aria-label={t("templates.studio.aiReject")}
                      onClick={() => dismiss(index)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <XIcon />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverPanel>
    </Popover>
  );
};
