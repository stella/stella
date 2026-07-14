import { useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/element/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FlagIcon,
  GripVerticalIcon,
  Link2Icon,
  MessageSquareIcon,
  PlusIcon,
  RepeatIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  emptyCondition,
  pruneIncomplete,
  type ConditionNode,
} from "@stll/conditions";
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
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { cn } from "@stll/ui/lib/utils";

import { ConditionBuilder } from "@/components/conditions/condition-builder";
import type { FieldOption } from "@/components/conditions/condition-builder-logic";
import { Switch } from "@/components/switch";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { TranslationKey } from "@/i18n/types";
import { optionalArray } from "@/lib/arrays";
import {
  type DeterministicCheck,
  type FallbackEntry,
  type GradedPosition,
  type IdealLanguage,
  moveAdjacent,
  type Negotiation,
  newFallbackEntry,
  newTierRule,
  type Position,
  type PositionAskContent,
  type PositionErrors,
  type PositionSeverity,
  type TierRule,
} from "@/routes/_protected.knowledge/-components/playbook-types";
import {
  clauseDetailOptions,
  clausesOptions,
} from "@/routes/_protected.knowledge/-queries";

// Drag payload shared by the position cards; the parent list interprets a drop
// as "move dragged sourceId to target sourceId's index".
export const POSITION_DRAG_TYPE = "stella/playbook-position";

// ── Option metadata (typed translation keys) ──────────

type AskContentType = "text" | "date" | "int" | "single-select";

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

// Static per-key so the hardcoded-colour lint treats each as a token reference.
const SEVERITY_CHIP_CLASS = {
  blocker: "bg-destructive/12 text-destructive",
  high: "bg-warning/15 text-warning-foreground",
  medium: "bg-primary/12 text-primary",
  low: "bg-muted text-muted-foreground",
} as const satisfies Record<PositionSeverity, string>;

// Cycled named colors for single-select choices; every member is in the schema's
// option-color enum, so the produced content always validates.
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

const CHECK_KINDS = ["presence", "constraint"] as const;

const CHECK_KIND_LABEL_KEYS = {
  presence: "knowledge.playbooks.checkKind.presence",
  constraint: "knowledge.playbooks.checkKind.constraint",
} as const satisfies Record<(typeof CHECK_KINDS)[number], TranslationKey>;

const EXPECTATIONS = ["required", "restricted"] as const;

const EXPECTATION_LABEL_KEYS = {
  required: "common.required",
  restricted: "knowledge.playbooks.expectation.restricted",
} as const satisfies Record<(typeof EXPECTATIONS)[number], TranslationKey>;

const isAskContentType = (value: string): value is AskContentType =>
  ASK_CONTENT_TYPES.some((contentType) => contentType === value);

const isSeverity = (value: string): value is PositionSeverity =>
  SEVERITIES.some((severity) => severity === value);

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

// ── Inline action (muted text-only ghost button) ──────
// Tier "+ add" affordances and the advanced-panel toggles read as plain muted
// text until hover, not filled controls. A ghost xs Button with a muted text
// override keeps focus rings, sizing, and keyboard behaviour consistent.
const InlineAction = ({
  className,
  ...props
}: React.ComponentProps<typeof Button>) => (
  <Button
    className={cn("text-muted-foreground hover:text-foreground", className)}
    size="xs"
    variant="ghost"
    {...props}
  />
);

// ── Root: position card ───────────────────────────────

type PositionEditorProps = {
  organizationId: string;
  position: Position;
  index: number;
  total: number;
  open: boolean;
  errors: PositionErrors;
  showErrors: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (position: Position) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onConvertMode: () => void;
  onReorder: (draggedSourceId: string, targetSourceId: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

export const PositionEditor = ({
  organizationId,
  position,
  index,
  total,
  open,
  errors,
  showErrors,
  onOpenChange,
  onChange,
  onRemove,
  onDuplicate,
  onConvertMode,
  onReorder,
  onMoveUp,
  onMoveDown,
}: PositionEditorProps) => {
  const t = useTranslations();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [cardRef, setCardRef] = useState<HTMLElement | null>(null);
  const [gripRef, setGripRef] = useState<HTMLButtonElement | null>(null);
  const { sourceId } = position;
  const bodyId = `position-body-${sourceId}`;
  const handleReorder = useLatestCallback(onReorder);

  useExternalSyncEffect(() => {
    if (!cardRef || !gripRef) {
      return undefined;
    }
    return combine(
      draggable({
        element: cardRef,
        dragHandle: gripRef,
        getInitialData: () => ({ type: POSITION_DRAG_TYPE, sourceId }),
        onGenerateDragPreview: ({ location, nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            // Anchor the ghost to where the grip was actually grabbed (the left
            // corner), instead of re-centering it under the pointer.
            getOffset: preserveOffsetOnSource({
              element: cardRef,
              input: location.current.input,
            }),
            render: ({ container }) => {
              // Preview the whole card at its rendered width, keeping its
              // border/background/shadow frame and full contents.
              const clone = cardRef.cloneNode(true);
              if (!(clone instanceof HTMLElement)) {
                return;
              }
              clone.style.width = `${cardRef.getBoundingClientRect().width}px`;
              container.append(clone);
            },
          });
        },
      }),
      dropTargetForElements({
        element: cardRef,
        canDrop: ({ source }) =>
          source.data["type"] === POSITION_DRAG_TYPE &&
          source.data["sourceId"] !== sourceId,
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const dragged = source.data["sourceId"];
          if (typeof dragged === "string") {
            handleReorder(dragged, sourceId);
          }
        },
      }),
    );
  }, [cardRef, gripRef, sourceId, handleReorder]);

  const handleGripKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMoveUp();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onMoveDown();
    }
  };

  return (
    <li
      className={cn(
        "bg-card overflow-hidden rounded-lg border shadow-xs transition-shadow",
        !position.enabled && "opacity-60",
        isDropTarget && "ring-primary ring-2",
      )}
      id={`position-${sourceId}`}
      ref={setCardRef}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Button
          aria-label={t("knowledge.playbooks.reorderPosition")}
          className="shrink-0 cursor-grab"
          onKeyDown={handleGripKeyDown}
          ref={setGripRef}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <GripVerticalIcon />
        </Button>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>

        <Input
          aria-invalid={showErrors && errors.issue !== undefined}
          className="hover:border-input focus-visible:bg-background h-8 flex-1 border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none"
          onChange={(e) => onChange({ ...position, issue: e.target.value })}
          onFocus={() => {
            if (!open) {
              onOpenChange(true);
            }
          }}
          placeholder={t("knowledge.playbooks.issuePlaceholder")}
          value={position.issue}
        />

        {position.mode === "graded" ? (
          <SeverityChip
            onChange={(severity) => onChange({ ...position, severity })}
            severity={position.severity}
          />
        ) : (
          <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
            {t("knowledge.playbooks.extractOnlyBadge")}
          </span>
        )}

        {!open && position.mode === "graded" && (
          <CollapsedTierDots position={position} />
        )}

        {!position.enabled && (
          <span className="bg-muted text-muted-foreground hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline">
            {t("knowledge.playbooks.disabledBadge")}
          </span>
        )}

        <Switch
          aria-label={t("knowledge.playbooks.enablePosition")}
          checked={position.enabled}
          className="shrink-0"
          onCheckedChange={(enabled) => onChange({ ...position, enabled })}
        />

        <Button
          aria-label={t("knowledge.playbooks.duplicatePosition")}
          onClick={onDuplicate}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <CopyIcon />
        </Button>
        <Button
          aria-label={t("knowledge.playbooks.deletePosition")}
          onClick={onRemove}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
        <Button
          aria-controls={bodyId}
          aria-expanded={open}
          aria-label={
            open
              ? t("knowledge.playbooks.collapsePosition")
              : t("knowledge.playbooks.expandPosition")
          }
          onClick={() => onOpenChange(!open)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ChevronDownIcon
            className={cn("transition-transform", open && "rotate-180")}
          />
        </Button>
      </div>

      {open && (
        <div className="space-y-3 px-3 pt-1 pb-3" id={bodyId}>
          {position.mode === "graded" ? (
            <GradedBody
              errors={errors}
              onChange={onChange}
              onConvertMode={onConvertMode}
              organizationId={organizationId}
              position={position}
              showErrors={showErrors}
            />
          ) : (
            <ExtractBody
              onChange={onChange}
              onConvertMode={onConvertMode}
              position={position}
            />
          )}
        </div>
      )}
      {/* index/total drive keyboard reorder guards below the header */}
      <span className="sr-only">
        {t("knowledge.playbooks.positionOfTotal", {
          index: String(index + 1),
          total: String(total),
        })}
      </span>
    </li>
  );
};

// ── Collapsed tier dots ───────────────────────────────

const CollapsedTierDots = ({ position }: { position: GradedPosition }) => {
  const { tiers } = position;
  const counts = [
    { key: "ok", value: tiers.acceptable.rules.length, cls: "bg-success" },
    { key: "warn", value: tiers.fallback.entries.length, cls: "bg-warning" },
    {
      key: "bad",
      value: tiers.notAcceptable.rules.length,
      cls: "bg-destructive",
    },
  ].filter((entry) => entry.value > 0);

  if (counts.length === 0) {
    return null;
  }

  return (
    <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
      {counts.map((entry) => (
        <span className="flex items-center gap-1" key={entry.key}>
          <span className={cn("size-1.5 rounded-full", entry.cls)} />
          <span className="text-muted-foreground text-[11px] tabular-nums">
            {entry.value}
          </span>
        </span>
      ))}
    </span>
  );
};

// ── Severity chip (menu picker) ───────────────────────

const SeverityChip = ({
  severity,
  onChange,
}: {
  severity: PositionSeverity;
  onChange: (severity: PositionSeverity) => void;
}) => {
  const t = useTranslations();
  return (
    <Menu>
      <MenuTrigger
        aria-label={t("knowledge.playbooks.severityLabel")}
        className={cn(
          "focus-visible:ring-ring shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold focus-visible:ring-2 focus-visible:outline-none",
          SEVERITY_CHIP_CLASS[severity],
        )}
      >
        {t(SEVERITY_LABEL_KEYS[severity])}
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup
          onValueChange={(value) => {
            if (typeof value === "string" && isSeverity(value)) {
              onChange(value);
            }
          }}
          value={severity}
        >
          {SEVERITIES.map((option) => (
            <MenuRadioItem key={option} value={option}>
              {t(SEVERITY_LABEL_KEYS[option])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};

// ── Graded body (tier ladder + footer) ────────────────

const GradedBody = ({
  organizationId,
  position,
  errors,
  showErrors,
  onChange,
  onConvertMode,
}: {
  organizationId: string;
  position: GradedPosition;
  errors: PositionErrors;
  showErrors: boolean;
  onChange: (position: Position) => void;
  onConvertMode: () => void;
}) => {
  const t = useTranslations();
  const { tiers } = position;

  const setAcceptableRules = (rules: TierRule[]) =>
    onChange({
      ...position,
      tiers: { ...tiers, acceptable: { ...tiers.acceptable, rules } },
    });
  const setNotAcceptableRules = (rules: TierRule[]) =>
    onChange({
      ...position,
      tiers: { ...tiers, notAcceptable: { rules } },
    });
  const setEntries = (entries: FallbackEntry[]) =>
    onChange({ ...position, tiers: { ...tiers, fallback: { entries } } });
  const setIdeal = (ideal: IdealLanguage | undefined) =>
    onChange({
      ...position,
      tiers: {
        ...tiers,
        acceptable: {
          ...tiers.acceptable,
          ...(ideal !== undefined ? { ideal } : {}),
        },
      },
    });

  return (
    <>
      {showErrors && errors.content !== undefined && (
        <p className="text-destructive text-xs" role="alert">
          {t("knowledge.playbooks.gradedNeedsContent")}
        </p>
      )}

      <TierSection
        icon={<CheckMark />}
        onAddRule={() =>
          setAcceptableRules([...tiers.acceptable.rules, newTierRule()])
        }
        title={t("knowledge.playbooks.tier.acceptable")}
        tone="acceptable"
        trailingAction={
          tiers.acceptable.ideal === undefined ? (
            <InlineAction
              onClick={() => setIdeal({ source: "inline", text: "" })}
            >
              + {t("knowledge.playbooks.idealLanguage")}
            </InlineAction>
          ) : null
        }
      >
        {tiers.acceptable.rules.map((rule, ruleIndex) => (
          <RuleRow
            key={rule.id}
            label={t("knowledge.playbooks.ruleNumber", {
              index: String(ruleIndex + 1),
            })}
            onChange={(text) =>
              setAcceptableRules(
                tiers.acceptable.rules.map((r) =>
                  r.id === rule.id ? { ...r, text } : r,
                ),
              )
            }
            onRemove={() =>
              setAcceptableRules(
                tiers.acceptable.rules.filter((r) => r.id !== rule.id),
              )
            }
            placeholder={t("knowledge.playbooks.rulePlaceholder")}
            value={rule.text}
          />
        ))}
        {tiers.acceptable.ideal !== undefined && (
          <IdealEditor
            clauseInvalid={showErrors && errors.clause !== undefined}
            ideal={tiers.acceptable.ideal}
            onChange={setIdeal}
            onRemove={() =>
              onChange({
                ...position,
                tiers: {
                  ...tiers,
                  acceptable: { rules: tiers.acceptable.rules },
                },
              })
            }
            organizationId={organizationId}
          />
        )}
      </TierSection>

      <TierSection
        icon={<RepeatIcon className="size-3" />}
        onAddRule={() =>
          setEntries([...tiers.fallback.entries, newFallbackEntry()])
        }
        title={t("knowledge.playbooks.tier.fallback")}
        tone="fallback"
      >
        {tiers.fallback.entries.map((entry, entryIndex) => (
          <FallbackEntryRow
            entry={entry}
            index={entryIndex}
            key={entry.id}
            onChange={(next) =>
              setEntries(
                tiers.fallback.entries.map((e) =>
                  e.id === entry.id ? next : e,
                ),
              )
            }
            onMoveDown={() => {
              const next = moveAdjacent(
                tiers.fallback.entries,
                entryIndex,
                "down",
              );
              if (next) {
                setEntries(next);
              }
            }}
            onMoveUp={() => {
              const next = moveAdjacent(
                tiers.fallback.entries,
                entryIndex,
                "up",
              );
              if (next) {
                setEntries(next);
              }
            }}
            onRemove={() =>
              setEntries(
                tiers.fallback.entries.filter((e) => e.id !== entry.id),
              )
            }
            total={tiers.fallback.entries.length}
          />
        ))}
      </TierSection>

      <TierSection
        icon={<FlagIcon className="size-3" />}
        onAddRule={() =>
          setNotAcceptableRules([...tiers.notAcceptable.rules, newTierRule()])
        }
        title={t("knowledge.playbooks.tier.notAcceptable")}
        tone="notAcceptable"
      >
        {tiers.notAcceptable.rules.map((rule, ruleIndex) => (
          <RuleRow
            key={rule.id}
            label={t("knowledge.playbooks.ruleNumber", {
              index: String(ruleIndex + 1),
            })}
            onChange={(text) =>
              setNotAcceptableRules(
                tiers.notAcceptable.rules.map((r) =>
                  r.id === rule.id ? { ...r, text } : r,
                ),
              )
            }
            onRemove={() =>
              setNotAcceptableRules(
                tiers.notAcceptable.rules.filter((r) => r.id !== rule.id),
              )
            }
            placeholder={t("knowledge.playbooks.redLinePlaceholder")}
            value={rule.text}
          />
        ))}
      </TierSection>

      <NegotiationSection onChange={onChange} position={position} />

      <GradedFooter
        onChange={onChange}
        onConvertMode={onConvertMode}
        position={position}
      />
    </>
  );
};

const CheckMark = () => (
  <svg
    aria-hidden
    className="size-3"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="3"
    viewBox="0 0 24 24"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// ── Tier section shell ────────────────────────────────

type TierTone = "acceptable" | "fallback" | "notAcceptable";

const TIER_TONE_CLASS = {
  acceptable: "border-success/30",
  fallback: "border-warning/30",
  notAcceptable: "border-destructive/30",
} as const satisfies Record<TierTone, string>;

const TIER_HEAD_CLASS = {
  acceptable: "text-success",
  fallback: "text-warning-foreground",
  notAcceptable: "text-destructive",
} as const satisfies Record<TierTone, string>;

const TIER_MARK_CLASS = {
  acceptable: "bg-success/12 text-success",
  fallback: "bg-warning/15 text-warning-foreground",
  notAcceptable: "bg-destructive/12 text-destructive",
} as const satisfies Record<TierTone, string>;

const TierSection = ({
  tone,
  title,
  icon,
  onAddRule,
  trailingAction,
  children,
}: {
  tone: TierTone;
  title: string;
  icon: React.ReactNode;
  onAddRule: () => void;
  trailingAction?: React.ReactNode;
  children: React.ReactNode;
}) => {
  const t = useTranslations();
  return (
    <section className={cn("rounded-lg border", TIER_TONE_CLASS[tone])}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={cn(
            "flex size-4.5 items-center justify-center rounded",
            TIER_MARK_CLASS[tone],
          )}
        >
          {icon}
        </span>
        <span
          className={cn("text-[13px] font-semibold", TIER_HEAD_CLASS[tone])}
        >
          {title}
        </span>
        <div className="ms-auto flex items-center gap-1">
          {trailingAction}
          <InlineAction onClick={onAddRule}>
            + {t("knowledge.playbooks.addRule")}
          </InlineAction>
        </div>
      </div>
      <div className="space-y-2 px-3 pb-3">{children}</div>
    </section>
  );
};

// ── Rule row ──────────────────────────────────────────

const RuleRow = ({
  label,
  value,
  placeholder,
  onChange,
  onRemove,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
  onRemove: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-11 shrink-0 pt-2 text-[10px] tracking-wide uppercase tabular-nums">
        {label}
      </span>
      <Input
        className="h-8 flex-1 text-sm"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <Button
        aria-label={t("common.remove")}
        className="shrink-0"
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
};

// ── Fallback entry row (ranked, reorderable) ──────────

const FallbackEntryRow = ({
  entry,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  entry: FallbackEntry;
  index: number;
  total: number;
  onChange: (entry: FallbackEntry) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-11 shrink-0 pt-2 text-[10px] tracking-wide uppercase tabular-nums">
        {t("knowledge.playbooks.entryRank", { index: String(index + 1) })}
      </span>
      <div className="flex-1 space-y-1.5">
        <Input
          className="h-8 text-sm"
          onChange={(e) => onChange({ ...entry, text: e.target.value })}
          placeholder={t("knowledge.playbooks.entryPlaceholder")}
          value={entry.text}
        />
        <Input
          className="h-7 text-xs"
          onChange={(e) => onChange({ ...entry, label: e.target.value })}
          placeholder={t("knowledge.playbooks.entryLabelPlaceholder")}
          value={entry.label ?? ""}
        />
      </div>
      <div className="flex shrink-0 flex-col">
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
      </div>
      <Button
        aria-label={t("common.remove")}
        className="shrink-0"
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
};

// ── Ideal language ────────────────────────────────────

const IdealEditor = ({
  organizationId,
  ideal,
  clauseInvalid,
  onChange,
  onRemove,
}: {
  organizationId: string;
  ideal: IdealLanguage;
  clauseInvalid: boolean;
  onChange: (ideal: IdealLanguage) => void;
  onRemove: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="border-border ms-11 space-y-2 border-s-2 ps-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
          {t("knowledge.playbooks.idealLanguage")}
        </span>
        <Select
          onValueChange={(value) => {
            if (value === "clause" && ideal.source !== "clause") {
              onChange({ source: "clause", clauseId: "" });
            }
            if (value === "inline" && ideal.source !== "inline") {
              onChange({ source: "inline", text: "" });
            }
          }}
          value={ideal.source}
        >
          <SelectTrigger className="h-6 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="inline">
              {t("knowledge.playbooks.idealInline")}
            </SelectItem>
            <SelectItem value="clause">
              {t("knowledge.playbooks.idealFromClause")}
            </SelectItem>
          </SelectPopup>
        </Select>
        <Button
          aria-label={t("knowledge.playbooks.removeIdeal")}
          className="ms-auto"
          onClick={onRemove}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {ideal.source === "inline" ? (
        <Textarea
          className="min-h-[52px] text-sm"
          onChange={(e) => onChange({ source: "inline", text: e.target.value })}
          placeholder={t("knowledge.playbooks.idealInlinePlaceholder")}
          value={ideal.text}
        />
      ) : (
        <ClausePicker
          clauseId={ideal.clauseId}
          invalid={clauseInvalid}
          onSelect={(clauseId) => onChange({ source: "clause", clauseId })}
          organizationId={organizationId}
        />
      )}
    </div>
  );
};

type ClauseOption = { id: string; title: string };

const ClausePicker = ({
  organizationId,
  clauseId,
  invalid,
  onSelect,
}: {
  organizationId: string;
  clauseId: string;
  invalid: boolean;
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
        aria-invalid={invalid}
        placeholder={t("knowledge.playbooks.clausePlaceholder")}
        startAddon={selected ? <Link2Icon /> : <SearchIcon />}
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

// ── Negotiation: reviewer-facing guidance for a flagged verdict ──
// Collapsible like the Advanced panel below, but its own toggle: this is
// review-time content a reviewer reads (why we want this, what to say,
// when to escalate), not a technical grading setting.

const NEGOTIATION_FIELD_LIMITS = { escalation: 500 } as const;

const updateNegotiation = (
  position: GradedPosition,
  patch: Partial<Negotiation>,
): GradedPosition => ({
  ...position,
  negotiation: { ...position.negotiation, ...patch },
});

const hasNegotiationContent = (negotiation: Negotiation | undefined): boolean =>
  negotiation !== undefined &&
  ((negotiation.rationale?.trim().length ?? 0) > 0 ||
    (negotiation.talkingPoints?.length ?? 0) > 0 ||
    (negotiation.escalation?.trim().length ?? 0) > 0);

const NegotiationSection = ({
  position,
  onChange,
}: {
  position: GradedPosition;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { negotiation } = position;
  const talkingPoints = optionalArray(negotiation?.talkingPoints);

  const setTalkingPoints = (points: string[]) =>
    onChange(updateNegotiation(position, { talkingPoints: points }));

  return (
    <div className="border-border/70 border-t border-dashed pt-3">
      <InlineAction
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <MessageSquareIcon className="size-3" />
        {t("knowledge.playbooks.negotiation.title")}
        {!open && hasNegotiationContent(negotiation) && (
          <span
            aria-hidden="true"
            className="bg-primary size-1.5 rounded-full"
          />
        )}
      </InlineAction>

      {open && (
        <div className="bg-muted/50 mt-3 space-y-4 rounded-md p-3">
          <div className="grid gap-1.5">
            <Label
              className="text-xs"
              htmlFor={`position-negotiation-rationale-${position.sourceId}`}
            >
              {t("knowledge.playbooks.negotiation.rationaleLabel")}
            </Label>
            <Textarea
              className="min-h-[52px] text-sm"
              id={`position-negotiation-rationale-${position.sourceId}`}
              onChange={(e) =>
                onChange(
                  updateNegotiation(position, { rationale: e.target.value }),
                )
              }
              placeholder={t(
                "knowledge.playbooks.negotiation.rationalePlaceholder",
              )}
              value={negotiation?.rationale ?? ""}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">
              {t("knowledge.playbooks.negotiation.talkingPointsLabel")}
            </Label>
            <div className="space-y-1.5">
              {talkingPoints.map((point, index) => (
                // eslint-disable-next-line react/no-array-index-key -- talkingPoints is a persisted string[] (playbook negotiation data) with no id field and duplicate values allowed; each Input is fully controlled by its string value, so index-keyed reuse never mismatches rendered content.
                <div className="flex items-center gap-2" key={index}>
                  <Input
                    className="h-8 flex-1 text-sm"
                    onChange={(e) =>
                      setTalkingPoints(
                        talkingPoints.map((existing, i) =>
                          i === index ? e.target.value : existing,
                        ),
                      )
                    }
                    placeholder={t(
                      "knowledge.playbooks.negotiation.talkingPointPlaceholder",
                    )}
                    value={point}
                  />
                  <Button
                    aria-label={t("common.remove")}
                    onClick={() =>
                      setTalkingPoints(
                        talkingPoints.filter((_, i) => i !== index),
                      )
                    }
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              className="w-fit"
              onClick={() => setTalkingPoints([...talkingPoints, ""])}
              size="xs"
              type="button"
              variant="outline"
            >
              <PlusIcon />
              {t("knowledge.playbooks.negotiation.addTalkingPoint")}
            </Button>
          </div>

          <div className="grid gap-1.5">
            <Label
              className="text-xs"
              htmlFor={`position-negotiation-escalation-${position.sourceId}`}
            >
              {t("knowledge.playbooks.negotiation.escalationLabel")}
            </Label>
            <Input
              className="h-8 text-sm"
              id={`position-negotiation-escalation-${position.sourceId}`}
              maxLength={NEGOTIATION_FIELD_LIMITS.escalation}
              onChange={(e) =>
                onChange(
                  updateNegotiation(position, { escalation: e.target.value }),
                )
              }
              placeholder={t(
                "knowledge.playbooks.negotiation.escalationPlaceholder",
              )}
              value={negotiation?.escalation ?? ""}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ── Graded footer: extraction + advanced ──────────────

const GradedFooter = ({
  position,
  onChange,
  onConvertMode,
}: {
  position: GradedPosition;
  onChange: (position: Position) => void;
  onConvertMode: () => void;
}) => {
  const t = useTranslations();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const isAuto = position.ask.mode === "auto";

  return (
    <div className="border-border/70 border-t border-dashed pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
          <SparklesIcon className="size-3.5" />
          {t("knowledge.playbooks.extraction")}
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[11px] font-semibold",
              isAuto
                ? "bg-primary/12 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {isAuto
              ? t("knowledge.playbooks.extractionAuto")
              : t("knowledge.playbooks.extractionManual")}
          </span>
        </span>
        <InlineAction
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <SlidersHorizontalIcon className="size-3" />
          {t("knowledge.playbooks.advanced")}
        </InlineAction>
      </div>

      {advancedOpen && (
        <div className="bg-muted/50 mt-3 space-y-4 rounded-md p-3">
          <ExtractionAdvanced onChange={onChange} position={position} />
          <CheckEditor onChange={onChange} position={position} />
          <GuidanceField onChange={onChange} position={position} />
          <ConvertModeButton
            label={t("knowledge.playbooks.convertToExtract")}
            onConvertMode={onConvertMode}
          />
        </div>
      )}
    </div>
  );
};

const ExtractionAdvanced = ({
  position,
  onChange,
}: {
  position: GradedPosition;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const { ask } = position;

  if (ask.mode === "auto") {
    return (
      <div className="space-y-2">
        {ask.derived ? (
          <div className="space-y-1 text-xs">
            <p>
              <span className="text-muted-foreground">
                {t("knowledge.playbooks.derivedQuestion")}
              </span>{" "}
              <span className="text-foreground italic">
                “{ask.derived.question}”
              </span>
            </p>
            <p className="text-muted-foreground">
              {t("knowledge.playbooks.derivedType")}{" "}
              {t(ASK_CONTENT_LABEL_KEYS[toAskContentType(ask.derived.content)])}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t("knowledge.playbooks.derivedAutomatically")}
          </p>
        )}
        <Button
          onClick={() =>
            onChange({
              ...position,
              ask: {
                mode: "manual",
                question: ask.derived?.question ?? "",
                content: ask.derived?.content ?? { version: 1, type: "text" },
              },
            })
          }
          size="xs"
          type="button"
          variant="outline"
        >
          {t("knowledge.playbooks.switchToManual")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AskContentEditor
        content={ask.content}
        onChangeContent={(content) =>
          onChange({ ...position, ask: { ...ask, content } })
        }
        onChangeQuestion={(question) =>
          onChange({ ...position, ask: { ...ask, question } })
        }
        question={ask.question}
        sourceId={position.sourceId}
      />
      <Button
        onClick={() => onChange({ ...position, ask: { mode: "auto" } })}
        size="xs"
        type="button"
        variant="ghost"
      >
        {t("knowledge.playbooks.switchToAuto")}
      </Button>
    </div>
  );
};

const toAskContentType = (content: PositionAskContent): AskContentType => {
  if (content.type === "single-select" || content.type === "multi-select") {
    return "single-select";
  }
  if (content.type === "date") {
    return "date";
  }
  if (content.type === "int") {
    return "int";
  }
  return "text";
};

// ── Deterministic check editor ────────────────────────

const CheckEditor = ({
  position,
  onChange,
}: {
  position: GradedPosition;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  const { check } = position;

  const setCheck = (next: DeterministicCheck | undefined) =>
    onChange(
      next === undefined ? removeCheck(position) : { ...position, check: next },
    );

  if (check === undefined) {
    return (
      <div className="space-y-1">
        <Button
          onClick={() =>
            setCheck({ kind: "presence", expectation: "required" })
          }
          size="xs"
          type="button"
          variant="outline"
        >
          <PlusIcon />
          {t("knowledge.playbooks.addCheck")}
        </Button>
        <p className="text-muted-foreground text-[11px]">
          {t("knowledge.playbooks.checkHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="border-border space-y-2 rounded-md border border-dashed p-2.5">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{t("knowledge.playbooks.check")}</Label>
        <Select
          onValueChange={(value) => {
            if (value === "presence") {
              setCheck({ kind: "presence", expectation: "required" });
            }
            if (value === "constraint") {
              setCheck({
                kind: "constraint",
                condition: emptyCondition(),
              });
            }
          }}
          value={check.kind}
        >
          <SelectTrigger className="h-7 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {CHECK_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(CHECK_KIND_LABEL_KEYS[kind])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          aria-label={t("knowledge.playbooks.removeCheck")}
          className="ms-auto"
          onClick={() => setCheck(undefined)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>

      {check.kind === "presence" && (
        <Select
          onValueChange={(value) => {
            if (value === "required" || value === "restricted") {
              setCheck({ kind: "presence", expectation: value });
            }
          }}
          value={check.expectation}
        >
          <SelectTrigger className="h-7 w-40 text-xs">
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
      )}

      {check.kind === "constraint" && (
        <ConstraintEditor
          condition={check.condition}
          onChange={(condition) => setCheck({ kind: "constraint", condition })}
          position={position}
        />
      )}
    </div>
  );
};

// Rebuild the graded position without its `check`, keeping the union exact.
const removeCheck = (position: GradedPosition): GradedPosition => {
  const { check: _check, ...rest } = position;
  return rest;
};

const ConstraintEditor = ({
  position,
  condition,
  onChange,
}: {
  position: GradedPosition;
  condition: ConditionNode;
  onChange: (condition: ConditionNode) => void;
}) => {
  const t = useTranslations();
  const [draft, setDraft] = useState<ConditionNode | null>(condition);
  const field = checkFieldOption(
    position,
    position.issue.trim() || t("knowledge.playbooks.issueLabel"),
  );

  return (
    <ConditionBuilder
      capabilities={{ fields: [field] }}
      onChange={(next) => {
        setDraft(next);
        onChange(pruneIncomplete(next) ?? emptyCondition());
      }}
      value={draft}
    />
  );
};

// The constrained value is this position's own extracted answer (operand keyed
// by sourceId). Its type comes from a manual ask when authored, else text.
const checkFieldOption = (
  position: GradedPosition,
  label: string,
): FieldOption => {
  const operand = { type: "property" as const, propertyId: position.sourceId };
  // A manual ask carries its content type directly; an auto ask carries it on
  // the derived result once populated. Fall back to null (→ text) otherwise.
  const content =
    position.ask.mode === "manual"
      ? position.ask.content
      : (position.ask.derived?.content ?? null);
  if (
    content &&
    (content.type === "single-select" || content.type === "multi-select")
  ) {
    return {
      operand,
      label,
      valueType: content.type,
      type: content.type,
      options: content.options.map((option) => ({
        value: option.value,
        label: option.value,
        color: option.color,
      })),
    };
  }
  if (content && (content.type === "date" || content.type === "int")) {
    return { operand, label, valueType: content.type, type: content.type };
  }
  return { operand, label, valueType: "text", type: "text" };
};

// ── Extract body ──────────────────────────────────────

const ExtractBody = ({
  position,
  onChange,
  onConvertMode,
}: {
  position: Extract<Position, { mode: "extract" }>;
  onChange: (position: Position) => void;
  onConvertMode: () => void;
}) => {
  const t = useTranslations();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground text-xs">
          {t("knowledge.playbooks.extractOnlyDescription")}
        </span>
        <InlineAction
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <SlidersHorizontalIcon className="size-3" />
          {t("knowledge.playbooks.advanced")}
        </InlineAction>
      </div>

      {advancedOpen && (
        <div className="bg-muted/50 space-y-4 rounded-md p-3">
          <AskContentEditor
            content={position.ask.content}
            onChangeContent={(content) =>
              onChange({ ...position, ask: { ...position.ask, content } })
            }
            onChangeQuestion={(question) =>
              onChange({ ...position, ask: { ...position.ask, question } })
            }
            question={position.ask.question}
            sourceId={position.sourceId}
          />
          <GuidanceField onChange={onChange} position={position} />
          <ConvertModeButton
            label={t("knowledge.playbooks.convertToGraded")}
            onConvertMode={onConvertMode}
          />
        </div>
      )}
    </div>
  );
};

// ── Shared: ask content editor (question + type + options) ──

const AskContentEditor = ({
  sourceId,
  question,
  content,
  onChangeQuestion,
  onChangeContent,
}: {
  sourceId: string;
  question: string;
  content: PositionAskContent;
  onChangeQuestion: (question: string) => void;
  onChangeContent: (content: PositionAskContent) => void;
}) => {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label className="text-xs" htmlFor={`position-question-${sourceId}`}>
          {t("knowledge.playbooks.askQuestionLabel")}
        </Label>
        <Textarea
          className="min-h-[52px] text-sm"
          id={`position-question-${sourceId}`}
          onChange={(e) => onChangeQuestion(e.target.value)}
          placeholder={t("knowledge.playbooks.askQuestionPlaceholder")}
          value={question}
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">
          {t("knowledge.playbooks.askContentLabel")}
        </Label>
        <Select
          onValueChange={(value) => {
            if (value !== null && isAskContentType(value)) {
              onChangeContent(contentForType(value, content));
            }
          }}
          value={toAskContentType(content)}
        >
          <SelectTrigger className="h-8 w-48 text-sm">
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
      {(content.type === "single-select" ||
        content.type === "multi-select") && (
        <SelectOptionsEditor content={content} onChange={onChangeContent} />
      )}
    </div>
  );
};

// A named option color resolves to its `--option-{name}` token; a custom hex
// value is used verbatim.
const optionSwatch = (color: string): string =>
  color.startsWith("#") ? color : `var(--option-${color})`;

const SelectOptionsEditor = ({
  content,
  onChange,
}: {
  content: SelectAskContent;
  onChange: (content: PositionAskContent) => void;
}) => {
  const t = useTranslations();

  const setOptions = (options: SelectAskContent["options"]) =>
    onChange({ ...content, options });

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{t("knowledge.playbooks.optionsLabel")}</Label>
      <div className="space-y-1.5">
        {content.options.map((option, index) => (
          // eslint-disable-next-line react/no-array-index-key -- SelectAskContent options have no id and duplicate values are possible (new rows are added blank), but each row is fully controlled by its own value/color so index-keyed reuse never mismatches rendered content.
          <div className="flex items-center gap-2" key={index}>
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: optionSwatch(option.color) }}
            />
            <Input
              className="h-7 flex-1 text-sm"
              onChange={(e) =>
                setOptions(
                  content.options.map((o, i) =>
                    i === index ? { ...o, value: e.target.value } : o,
                  ),
                )
              }
              placeholder={t("knowledge.playbooks.optionPlaceholder")}
              value={option.value}
            />
            <Button
              aria-label={t("common.remove")}
              onClick={() =>
                setOptions(content.options.filter((_, i) => i !== index))
              }
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
      <Button
        className="w-fit"
        onClick={() =>
          setOptions([
            ...content.options,
            {
              color:
                OPTION_COLORS[content.options.length % OPTION_COLORS.length] ??
                "gray",
              value: "",
            },
          ])
        }
        size="xs"
        type="button"
        variant="outline"
      >
        <PlusIcon />
        {t("knowledge.playbooks.addOption")}
      </Button>
    </div>
  );
};

// ── Shared: guidance + convert-mode ───────────────────

const GuidanceField = ({
  position,
  onChange,
}: {
  position: Position;
  onChange: (position: Position) => void;
}) => {
  const t = useTranslations();
  return (
    <div className="grid gap-1.5">
      <Label
        className="text-xs"
        htmlFor={`position-guidance-${position.sourceId}`}
      >
        {t("knowledge.playbooks.guidanceLabel")}
      </Label>
      <Textarea
        className="min-h-[44px] text-sm"
        id={`position-guidance-${position.sourceId}`}
        onChange={(e) => onChange({ ...position, guidance: e.target.value })}
        placeholder={t("knowledge.playbooks.guidancePlaceholder")}
        value={position.guidance ?? ""}
      />
    </div>
  );
};

const ConvertModeButton = ({
  label,
  onConvertMode,
}: {
  label: string;
  onConvertMode: () => void;
}) => (
  <Button
    className="text-muted-foreground"
    onClick={onConvertMode}
    size="xs"
    type="button"
    variant="ghost"
  >
    {label}
  </Button>
);
