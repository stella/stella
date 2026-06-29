import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";

import type { TranslationKey } from "@/i18n/types";
import {
  type Position,
  type PositionAskContent,
  type PositionRule,
  type PositionSeverity,
  type PositionStandard,
  withFallbackRank,
} from "@/routes/_protected.knowledge/-components/playbook-types";
import {
  clauseDetailOptions,
  clausesOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── Option metadata (typed translation keys) ──────────

type AskContentType = "text" | "date" | "int" | "single-select";

// The schema groups single- and multi-select into one content member
// (`type: "single-select" | "multi-select"`), so extract it by that union.
type SelectAskContent = Extract<
  PositionAskContent,
  { type: "single-select" | "multi-select" }
>;

const ASK_CONTENT_TYPES = ["text", "date", "int", "single-select"] as const;

const ASK_CONTENT_LABEL_KEYS = {
  text: "knowledge.playbooks.contentType.text",
  date: "common.date",
  int: "knowledge.playbooks.contentType.int",
  "single-select": "knowledge.playbooks.contentType.singleSelect",
} as const satisfies Record<AskContentType, TranslationKey>;

type SourceKind = PositionStandard["source"];

const SOURCE_KINDS = ["none", "inline", "clause"] as const;

const SOURCE_LABEL_KEYS = {
  none: "knowledge.playbooks.source.none",
  inline: "knowledge.playbooks.source.inline",
  clause: "knowledge.playbooks.source.clause",
} as const satisfies Record<SourceKind, TranslationKey>;

type RuleKind = PositionRule["kind"];

const RULE_KINDS = [
  "extractOnly",
  "presence",
  "propertyConstraint",
  "positionMatch",
] as const;

const RULE_LABEL_KEYS = {
  extractOnly: "knowledge.playbooks.rule.extractOnly",
  presence: "knowledge.playbooks.rule.presence",
  propertyConstraint: "knowledge.playbooks.rule.propertyConstraint",
  positionMatch: "knowledge.playbooks.rule.positionMatch",
} as const satisfies Record<RuleKind, TranslationKey>;

type Expectation = Extract<PositionRule, { kind: "presence" }>["expectation"];

const EXPECTATIONS = ["required", "restricted"] as const;

const EXPECTATION_LABEL_KEYS = {
  required: "common.required",
  restricted: "knowledge.playbooks.expectation.restricted",
} as const satisfies Record<Expectation, TranslationKey>;

const SEVERITIES = [
  "blocker",
  "high",
  "medium",
  "low",
] as const satisfies readonly PositionSeverity[];

const SEVERITY_LABEL_KEYS = {
  blocker: "knowledge.playbooks.severity.blocker",
  high: "knowledge.playbooks.severity.high",
  medium: "knowledge.playbooks.severity.medium",
  low: "knowledge.playbooks.severity.low",
} as const satisfies Record<PositionSeverity, TranslationKey>;

// Named option colors cycled for single-select choices. All members of the
// schema's named-color enum, so the produced content always validates.
const OPTION_COLORS = [
  "blue",
  "green",
  "amber",
  "violet",
  "red",
  "teal",
  "fuchsia",
  "sky",
] as const;

const isAskContentType = (value: string): value is AskContentType =>
  (ASK_CONTENT_TYPES as readonly string[]).includes(value);

const isSourceKind = (value: string): value is SourceKind =>
  (SOURCE_KINDS as readonly string[]).includes(value);

const isRuleKind = (value: string): value is RuleKind =>
  (RULE_KINDS as readonly string[]).includes(value);

const isExpectation = (value: string): value is Expectation =>
  (EXPECTATIONS as readonly string[]).includes(value);

const isSeverity = (value: string): value is PositionSeverity =>
  (SEVERITIES as readonly string[]).includes(value);

// ── Discriminated-union builders (explicit construction) ──

const contentForType = (
  type: AskContentType,
  prev: PositionAskContent,
): PositionAskContent => {
  if (type === "single-select") {
    if (prev.type === "single-select") {
      return prev;
    }
    return { version: 1, type: "single-select", options: [], fallback: null };
  }
  if (type === "date") {
    return { version: 1, type: "date" };
  }
  if (type === "int") {
    return { version: 1, type: "int" };
  }
  return { version: 1, type: "text" };
};

const standardForSource = (
  source: SourceKind,
  prev: PositionStandard,
): PositionStandard => {
  if (source === "clause") {
    return prev.source === "clause" ? prev : { source: "clause", clauseId: "" };
  }
  if (source === "inline") {
    return prev.source === "inline" ? prev : { source: "inline" };
  }
  return { source: "none" };
};

const ruleForKind = (kind: RuleKind, prev: PositionRule): PositionRule => {
  if (kind === "presence") {
    return {
      kind: "presence",
      expectation: prev.kind === "presence" ? prev.expectation : "required",
    };
  }
  if (kind === "propertyConstraint") {
    return {
      kind: "propertyConstraint",
      condition:
        prev.kind === "propertyConstraint"
          ? prev.condition
          : { type: "group", combinator: "and", children: [] },
    };
  }
  if (kind === "positionMatch") {
    return { kind: "positionMatch" };
  }
  return { kind: "extractOnly" };
};

// ── Root component ────────────────────────────────────

type PositionEditorProps = {
  organizationId: string;
  position: Position;
  index: number;
  total: number;
  onChange: (position: Position) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

export const PositionEditor = ({
  organizationId,
  position,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: PositionEditorProps) => {
  const t = useTranslations();

  return (
    <li className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("knowledge.playbooks.positionLabel", { index: String(index + 1) })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("common.moveUp")}
            disabled={index === 0}
            onClick={onMoveUp}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label={t("common.moveDown")}
            disabled={index === total - 1}
            onClick={onMoveDown}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <Button
            aria-label={t("common.remove")}
            onClick={onRemove}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`position-issue-${position.sourceId}`}>
          {t("knowledge.playbooks.issueLabel")}
        </Label>
        <Input
          id={`position-issue-${position.sourceId}`}
          onChange={(e) => onChange({ ...position, issue: e.target.value })}
          placeholder={t("knowledge.playbooks.issuePlaceholder")}
          value={position.issue}
        />
      </div>

      <AskSection onChange={onChange} position={position} />

      <ExpectSection
        onChange={onChange}
        organizationId={organizationId}
        position={position}
      />

      <GradeSection onChange={onChange} position={position} />

      <div className="grid gap-1.5">
        <Label htmlFor={`position-guidance-${position.sourceId}`}>
          {t("knowledge.playbooks.guidanceLabel")}
        </Label>
        <Textarea
          className="min-h-[60px]"
          id={`position-guidance-${position.sourceId}`}
          onChange={(e) => onChange({ ...position, guidance: e.target.value })}
          placeholder={t("knowledge.playbooks.guidancePlaceholder")}
          value={position.guidance ?? ""}
        />
      </div>
    </li>
  );
};

// ── ASK ───────────────────────────────────────────────

const AskSection = ({
  position,
  onChange,
}: {
  position: Position;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const content = position.ask.content;

  return (
    <fieldset className="bg-muted/30 grid gap-3 rounded-md border p-3">
      <legend className="px-1 text-xs font-semibold">
        {t("knowledge.playbooks.ask")}
      </legend>

      <div className="grid gap-1.5">
        <Label htmlFor={`position-question-${position.sourceId}`}>
          {t("knowledge.playbooks.askQuestionLabel")}
        </Label>
        <Textarea
          className="min-h-[60px]"
          id={`position-question-${position.sourceId}`}
          onChange={(e) =>
            onChange({
              ...position,
              ask: { ...position.ask, question: e.target.value },
            })
          }
          placeholder={t("knowledge.playbooks.askQuestionPlaceholder")}
          value={position.ask.question}
        />
      </div>

      <div className="grid gap-1.5">
        <Label>{t("knowledge.playbooks.askContentLabel")}</Label>
        <Select
          onValueChange={(val) => {
            if (val && isAskContentType(val)) {
              onChange({
                ...position,
                ask: { ...position.ask, content: contentForType(val, content) },
              });
            }
          }}
          value={content.type}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {ASK_CONTENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(ASK_CONTENT_LABEL_KEYS[type])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {content.type === "single-select" && (
        <SingleSelectOptions
          content={content}
          onChange={(next) =>
            onChange({
              ...position,
              ask: { ...position.ask, content: next },
            })
          }
          sourceId={position.sourceId}
        />
      )}
    </fieldset>
  );
};

const SingleSelectOptions = ({
  content,
  sourceId,
  onChange,
}: {
  content: SelectAskContent;
  sourceId: string;
  onChange: (content: PositionAskContent) => void;
}) => {
  const t = useTranslations();
  const [text, setText] = useState(() =>
    content.options.map((option) => option.value).join("\n"),
  );

  const handleChange = (value: string) => {
    setText(value);
    const values = value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const options = values.map((optionValue, i) => ({
      color: OPTION_COLORS[i % OPTION_COLORS.length] ?? "gray",
      value: optionValue,
    }));
    onChange({
      version: 1,
      type: "single-select",
      options,
      fallback: content.fallback ?? null,
    });
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`position-options-${sourceId}`}>
        {t("knowledge.playbooks.optionsLabel")}
      </Label>
      <Textarea
        className="min-h-[60px]"
        id={`position-options-${sourceId}`}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={t("knowledge.playbooks.optionsPlaceholder")}
        value={text}
      />
    </div>
  );
};

// ── EXPECT ────────────────────────────────────────────

const ExpectSection = ({
  organizationId,
  position,
  onChange,
}: {
  organizationId: string;
  position: Position;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const standard = position.standard;

  return (
    <fieldset className="bg-muted/30 grid gap-3 rounded-md border p-3">
      <legend className="px-1 text-xs font-semibold">
        {t("knowledge.playbooks.expect")}
      </legend>

      <div className="grid gap-1.5">
        <Label>{t("knowledge.playbooks.expectSourceLabel")}</Label>
        <Select
          onValueChange={(val) => {
            if (val && isSourceKind(val)) {
              onChange({
                ...position,
                standard: standardForSource(val, standard),
              });
            }
          }}
          value={standard.source}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {SOURCE_KINDS.map((source) => (
              <SelectItem key={source} value={source}>
                {t(SOURCE_LABEL_KEYS[source])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {standard.source === "clause" && (
        <div className="grid gap-1.5">
          <Label>{t("knowledge.playbooks.clauseLabel")}</Label>
          <ClausePicker
            clauseId={standard.clauseId}
            onSelect={(clauseId) =>
              onChange({
                ...position,
                standard: { source: "clause", clauseId },
              })
            }
            organizationId={organizationId}
          />
        </div>
      )}

      {standard.source === "inline" && (
        <InlineStandard
          onChange={(next) => onChange({ ...position, standard: next })}
          sourceId={position.sourceId}
          standard={standard}
        />
      )}
    </fieldset>
  );
};

type ClauseOption = {
  id: string;
  title: string;
};

const ClausePicker = ({
  organizationId,
  clauseId,
  onSelect,
}: {
  organizationId: string;
  clauseId: string;
  onSelect: (clauseId: string) => void;
}) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const debouncedSetSearch = useDebouncedCallback(
    (value: string) => setSearch(value),
    300,
  );

  const { data } = useQuery(clausesOptions(organizationId, { search }));
  const items: ClauseOption[] =
    data && "items" in data
      ? data.items.map((clause) => ({ id: clause.id, title: clause.title }))
      : [];

  const detailQuery = useQuery({
    ...clauseDetailOptions(organizationId, clauseId),
    enabled: clauseId !== "",
  });

  const resolvedTitle = (() => {
    const detail = detailQuery.data;
    if (detail && "title" in detail && typeof detail.title === "string") {
      return detail.title;
    }
    return items.find((item) => item.id === clauseId)?.title ?? "";
  })();

  const selected: ClauseOption | null =
    clauseId === "" ? null : { id: clauseId, title: resolvedTitle };

  return (
    <Combobox<ClauseOption>
      autoHighlight
      isItemEqualToValue={(a, b) => a.id === b.id}
      itemToStringLabel={(item) => item.title}
      onInputValueChange={(value) => debouncedSetSearch(value)}
      onValueChange={(item) => onSelect(item?.id ?? "")}
      value={selected}
    >
      <ComboboxInput
        placeholder={t("knowledge.playbooks.clausePlaceholder")}
        startAddon={<SearchIcon />}
      />
      <ComboboxPopup>
        <ComboboxList>
          {items.map((item) => (
            <ComboboxItem dir="auto" key={item.id} value={item}>
              {item.title}
            </ComboboxItem>
          ))}
        </ComboboxList>
        <ComboboxEmpty>
          {t("knowledge.playbooks.clauseSearchEmpty")}
        </ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
};

const InlineStandard = ({
  standard,
  sourceId,
  onChange,
}: {
  standard: Extract<PositionStandard, { source: "inline" }>;
  sourceId: string;
  onChange: (standard: PositionStandard) => void;
}) => {
  const t = useTranslations();
  const fallbacks = standard.fallbacks ?? [];

  const setFallbackField = (
    fallbackIndex: number,
    field: "label" | "text",
    value: string,
  ) => {
    const next = fallbacks.map((fallback, i) => {
      if (i !== fallbackIndex) {
        return fallback;
      }
      return field === "label"
        ? { ...fallback, label: value }
        : { ...fallback, text: value };
    });
    onChange({ ...standard, fallbacks: next });
  };

  const addFallback = () => {
    onChange({
      ...standard,
      fallbacks: [
        ...fallbacks,
        { rank: fallbacks.length, label: "", text: "" },
      ],
    });
  };

  const removeFallback = (fallbackIndex: number) => {
    const next = fallbacks
      .filter((_, i) => i !== fallbackIndex)
      .map(withFallbackRank);
    onChange({ ...standard, fallbacks: next });
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`position-preferred-${sourceId}`}>
          {t("knowledge.playbooks.preferredLabel")}
        </Label>
        <Textarea
          className="min-h-[60px]"
          id={`position-preferred-${sourceId}`}
          onChange={(e) => onChange({ ...standard, preferred: e.target.value })}
          placeholder={t("knowledge.playbooks.preferredPlaceholder")}
          value={standard.preferred ?? ""}
        />
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>{t("knowledge.playbooks.fallbacksLabel")}</Label>
          <Button
            onClick={addFallback}
            size="xs"
            type="button"
            variant="outline"
          >
            <PlusIcon />
            {t("knowledge.playbooks.addFallback")}
          </Button>
        </div>
        {fallbacks.map((fallback, fallbackIndex) => (
          <div
            className="grid gap-1.5 rounded-md border p-2"
            // The fallback list has no stable id; rank tracks position and is
            // re-derived on add/remove, so it is a valid key here.
            key={fallback.rank}
          >
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                onChange={(e) =>
                  setFallbackField(fallbackIndex, "label", e.target.value)
                }
                placeholder={t("knowledge.playbooks.fallbackLabelPlaceholder")}
                value={fallback.label ?? ""}
              />
              <Button
                aria-label={t("common.remove")}
                onClick={() => removeFallback(fallbackIndex)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </div>
            <Textarea
              className="min-h-[44px]"
              onChange={(e) =>
                setFallbackField(fallbackIndex, "text", e.target.value)
              }
              placeholder={t("knowledge.playbooks.fallbackTextPlaceholder")}
              value={fallback.text}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// ── GRADE ─────────────────────────────────────────────

const GradeSection = ({
  position,
  onChange,
}: {
  position: Position;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const rule = position.rule;

  return (
    <fieldset className="bg-muted/30 grid gap-3 rounded-md border p-3">
      <legend className="px-1 text-xs font-semibold">
        {t("knowledge.playbooks.grade")}
      </legend>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>{t("knowledge.playbooks.gradeRuleLabel")}</Label>
          <Select
            onValueChange={(val) => {
              if (val && isRuleKind(val)) {
                onChange({ ...position, rule: ruleForKind(val, rule) });
              }
            }}
            value={rule.kind}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {RULE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(RULE_LABEL_KEYS[kind])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label>{t("knowledge.playbooks.severityLabel")}</Label>
          <Select
            onValueChange={(val) => {
              if (val && isSeverity(val)) {
                onChange({ ...position, severity: val });
              }
            }}
            value={position.severity}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {t(SEVERITY_LABEL_KEYS[severity])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {rule.kind === "presence" && (
        <div className="grid gap-1.5">
          <Label>{t("knowledge.playbooks.expectationLabel")}</Label>
          <Select
            onValueChange={(val) => {
              if (val && isExpectation(val)) {
                onChange({
                  ...position,
                  rule: { kind: "presence", expectation: val },
                });
              }
            }}
            value={rule.expectation}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {EXPECTATIONS.map((expectation) => (
                <SelectItem key={expectation} value={expectation}>
                  {t(EXPECTATION_LABEL_KEYS[expectation])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

      {rule.kind === "propertyConstraint" && (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
          {t("knowledge.playbooks.conditionPlaceholder")}
        </p>
      )}
    </fieldset>
  );
};
