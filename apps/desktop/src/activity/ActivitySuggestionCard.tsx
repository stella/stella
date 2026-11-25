import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import type { BILLING_CODE_TYPES } from "@stll/api-contract/billing";
import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import type {
  DesktopMatter,
  DesktopTimeEntryClassification,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { AiLabel } from "@stll/ui/ai-label";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { CopyButton } from "@stll/ui/copy-button";
import type { DayCalendarRange } from "@stll/ui/day-calendar.logic";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { Form } from "@stll/ui/form";
import { AiActionIcon, XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
import { ReviewDiffText } from "@stll/ui/review-diff-text";
import { diffWords } from "@stll/ui/review-word-diff";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Switch } from "@stll/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/tabs";
import { Textarea } from "@stll/ui/textarea";
import { TimeField, TimeFieldGroup } from "@stll/ui/time-field";
import { TruncatedText } from "@stll/ui/truncated-text";

import { detectDesktopPlatform, formatShortcut } from "../shared/shortcut-keys";
import type { ShortcutKeys } from "../shared/shortcut-keys";
import {
  appRows,
  hasWindowTitles,
  rangeBreakdown,
  titleRows,
  wallClockTime,
  withMovedEdge,
} from "./activity-calendar-logic";
import type {
  ActivitySuggestion,
  EvidenceRow,
  RangeBreakdown,
  RangeEdge,
  RangeMatterBasis,
} from "./activity-calendar-logic";
import { appTotals, calendarDate, MINUTE_MS } from "./activity-logic";
import type { ActivityDaySnapshot } from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { DRAFT_FAILURE_RECOVERY } from "./billing-draft-logic";
import type { CardDraft, DraftFailureKind } from "./billing-draft-logic";
import type { DraftConsentStatus } from "./billing-draft-transport";
import { recordedElsewhere } from "./day-review-logic";
import type { DayEntriesRead, MatchedSegment } from "./day-review-logic";
import { DraftConsent } from "./DraftConsent";
import { useMatchReasonLabel } from "./matter-rule-label";
import { MatterPicker } from "./MatterPicker";
import { useDurationLabel, useMinutesLabel } from "./use-duration-label";

/** The editable fields of one suggestion. `written` counts stella AI
 * descriptions, so each new one fades in. */
export type SuggestionEdit = {
  billable: boolean;
  matter: DesktopMatter | null;
  narrative: string;
  written: number;
  /** What a guided draft classified the entry as, for the chosen matter. */
  classification: DesktopTimeEntryClassification | null;
  /** What the last applied stella AI change replaced, for Undo. */
  undo: Pick<
    SuggestionEdit,
    "narrative" | "classification" | "billable"
  > | null;
};

/** What the stella AI strip under the narrative shows. `hidden` when the
 * drafting settings cannot be read; a firm that switched drafting off is the
 * `off` failure. */
export type DraftAssistView =
  | { type: "hidden" }
  | { type: "needsMatter" }
  | { consent: DraftConsentStatus; type: "consent" }
  | {
      canUndo: boolean;
      canRestoreTemplate: boolean;
      /** The draft in place, or `null` while the card has none. */
      draft: Pick<CardDraft, "narrativeLanguage"> | null;
      refineFailure: DraftFailureKind | null;
      type: "ready";
    }
  | { type: "writing" }
  | { type: "refining" }
  /** A refinement shown as a tracked change for the user to accept. */
  | { after: string; before: string; type: "proposal" }
  | { kind: DraftFailureKind; type: "failed" };

/** Where a card's time comes from: what was recorded for a matched
 * suggestion, or a range the user selected and sets to the minute. */
export type SuggestionTimes =
  | { type: "recorded" }
  | {
      /** The calendar day, `YYYY-MM-DD`, the range stays on. */
      date: string;
      onRangeChange: (range: DayCalendarRange) => void;
      range: DayCalendarRange;
      timeZone: string;
      type: "selected";
    };

/** Time on the card's matter that day from another computer or the web,
 * with what the member can do about it. It warns; accepting stays open. */
type RecordedElsewhereNotice = {
  dayEntries: DayEntriesRead;
  /** The entries this computer created for the day. */
  draftedEntries: readonly ActivityDaySnapshot["draftedEntries"][number][];
  /** How the copy names the reviewed day. */
  day: "today" | "other";
  onReview: (matterId: string) => void;
  onRetry: () => void;
};

type ActivitySuggestionCardProps = {
  suggestion: ActivitySuggestion;
  times: SuggestionTimes;
  edit: SuggestionEdit;
  recordedElsewhere: RecordedElsewhereNotice;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  editingDisabledReason?: string | undefined;
  timeLabel: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  /** Why no window titles were recorded, with the action that changes it;
   * `null` when no action would. */
  titlesNotice: React.ReactElement | null;
  assist: DraftAssistView;
  /** The user's earlier entries the current draft followed. */
  earlierEntries: CardDraft["earlierEntries"];
  /** The current guided draft's notes against the billing guidelines. */
  flags: CardDraft["flags"];
  /** The names the matter gives the codes the current draft uses. */
  codeNames: CardDraft["codeNames"];
  /** A split or move the current guided draft proposes. */
  structure: CardDraft["structure"];
  onDraft: () => void;
  onAllow: () => void;
  onRefine: (steer: string, remember: boolean) => void;
  onAcceptProposal: () => void;
  onDismissProposal: () => void;
  onUndo: () => void;
  onRestoreTemplate: () => void;
  onEdit: (change: Partial<SuggestionEdit>) => void;
  onAccept: () => void;
  /** Creates the entries the proposed split or move makes. */
  onAcceptStructure: () => void;
  onReject: () => void;
  /** Takes the suggestion's slivers into its entry. */
  onIncludeSlivers: () => void;
  onClose: () => void;
  onCopy: () => Promise<boolean>;
};

const PLATFORM = detectDesktopPlatform(navigator.userAgent);
/** The primary modifier: ⌘ on macOS, Ctrl elsewhere. */
const PRIMARY_MODIFIER = PLATFORM === "mac" ? "super" : "control";
const ACCEPT_KEYS = {
  code: "Enter",
  modifiers: [PRIMARY_MODIFIER],
} as const satisfies ShortcutKeys;
const REJECT_KEYS = {
  code: "Backspace",
  modifiers: [PRIMARY_MODIFIER],
} as const satisfies ShortcutKeys;

const hasPrimaryModifier = (event: KeyboardEvent) =>
  PLATFORM === "mac" ? event.metaKey : event.ctrlKey;

type CardShortcut = "accept" | "close" | "reject";

const cardShortcut = (event: KeyboardEvent): CardShortcut | null => {
  if (event.key === "Escape") {
    return "close";
  }
  if (!hasPrimaryModifier(event)) {
    return null;
  }
  if (event.key === "Enter") {
    return "accept";
  }
  return event.key === "Backspace" ? "reject" : null;
};

export const ActivitySuggestionCard = ({
  suggestion,
  times,
  edit,
  recordedElsewhere: recordedElsewhereNotice,
  candidates,
  editingDisabledReason,
  timeLabel,
  sourceAppVisuals,
  titlesNotice,
  assist,
  earlierEntries,
  flags,
  codeNames,
  structure,
  onDraft,
  onAllow,
  onRefine,
  onAcceptProposal,
  onDismissProposal,
  onUndo,
  onRestoreTemplate,
  onEdit,
  onAccept,
  onAcceptStructure,
  onReject,
  onIncludeSlivers,
  onClose,
  onCopy,
}: ActivitySuggestionCardProps) => {
  const t = useTranslations("activity");
  const editable = editingDisabledReason === undefined;
  const locale = useLocale();
  const card = useRef<HTMLElement>(null);
  // The card is keyed by suggestion: each one takes focus as it opens, so a
  // day can be triaged from the keyboard, and scrolls wholly into view, so
  // its actions show however low on the day it opens. While it stays on
  // screen it keeps them in view as it grows (a draft arrives, details
  // open); a card scrolled away is left there.
  useEffect(() => {
    // The effect runs after the card's section has mounted.
    const element =
      card.current ?? panic("Suggestion card mounted without its element");
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
    const observer = new ResizeObserver(() => {
      const { bottom, top } = element.getBoundingClientRect();
      if (bottom > 0 && top < window.innerHeight) {
        element.scrollIntoView({ block: "nearest" });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const acceptDisabledReason = (() => {
    if (editingDisabledReason !== undefined) {
      return editingDisabledReason;
    }
    if (edit.matter === null) {
      return t("chooseMatterForEntry");
    }
    if (refusesMatter(assist)) {
      return t("aiDraftRefused");
    }
    if (edit.narrative.trim().length === 0) {
      return t("writeDescription");
    }
    return suggestion.workedMinutes > 0 ? undefined : t("entryNeedsDuration");
  })();
  const acceptable = acceptDisabledReason === undefined;
  const shortcutLabel = (keys: ShortcutKeys) =>
    formatShortcut({ keys, layout: null, locale, platform: PLATFORM });
  const runShortcut = useEffectEvent((shortcut: CardShortcut) => {
    switch (shortcut) {
      case "accept":
        if (acceptable) {
          onAccept();
        }
        return;
      case "reject":
        if (editable) {
          onReject();
        }
        return;
      case "close":
        onClose();
        return;
      default:
        shortcut satisfies never;
        panic("Unhandled suggestion card shortcut");
    }
  });
  // Shortcuts work wherever focus is in the card, and from the page body
  // after a control that held focus disappears; a popover such as the
  // matter search keeps its own keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = cardShortcut(event);
      const target = event.target;
      const inCard =
        target === document.body ||
        (target instanceof Node && card.current?.contains(target) === true);
      // In text, ⌘/Ctrl+Backspace deletes words, never the suggestion.
      const editingText =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement;
      if (
        shortcut === null ||
        !inCard ||
        (editingText && shortcut === "reject")
      ) {
        return;
      }
      event.preventDefault();
      runShortcut(shortcut);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const title = edit.matter?.name ?? t("newEntry");

  return (
    <section
      aria-label={title}
      // At most the window's height, less the calendar's sticky header: the
      // description and evidence scroll inside, so the actions stay in view.
      className="bg-popover text-popover-foreground ring-border flex max-h-[calc(100dvh-4rem)] scroll-mt-12 scroll-mb-2 flex-col rounded-xl text-sm shadow-lg ring-1 outline-none"
      data-activity-suggestion-card={suggestion.id}
      ref={card}
      tabIndex={-1}
    >
      <header className="flex items-start gap-2 px-3.5 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 font-semibold">
            {edit.matter === null ? null : (
              <MatterIcon matter={edit.matter} className="size-4 shrink-0" />
            )}
            <TruncatedText render={<bdi />}>{title}</TruncatedText>
          </h2>
          <p className="text-muted-foreground text-xs tabular-nums">
            {timeLabel}
          </p>
        </div>
        <Button
          aria-label={t("cancel")}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      <ScrollArea
        axis="vertical"
        className="min-h-0 flex-1"
        data-activity-card-body=""
        scrollFade
      >
        <div className="flex flex-col gap-3 px-3.5 pb-3">
          {times.type === "selected" ? (
            <SelectedRangeFields
              durationMs={suggestion.durationMs}
              editable={editable}
              times={times}
            />
          ) : null}
          {suggestion.type === "manual" ? (
            <RangeBreakdownList
              breakdown={rangeBreakdown(suggestion, edit.matter?.id ?? null)}
              hasMatter={edit.matter !== null}
            />
          ) : null}
          {suggestion.segments.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("rangeEmpty")}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("entryMatter")}
            </span>
            <MatterPicker
              candidates={candidates}
              disabledReason={editingDisabledReason}
              label={edit.matter?.name ?? t("chooseMatter")}
              // Codes follow the matter's billing format, so a new matter
              // drops them until it is drafted again. A card that started on
              // no matter starts non-billable; the first matter chosen makes
              // it billable, as every matter's card starts.
              onChoose={(matter) =>
                onEdit({
                  matter,
                  classification: null,
                  ...(edit.matter === null ? { billable: true } : {}),
                })
              }
            />
          </div>
          {edit.matter === null ? (
            <RangeMatterNote suggestion={suggestion} />
          ) : null}
          {edit.matter !== null && edit.matter.id === suggestion.matter?.id ? (
            <MatchReasonNote suggestion={suggestion} />
          ) : null}
          <RecordedElsewhereNote
            matterId={edit.matter?.id ?? null}
            notice={recordedElsewhereNotice}
          />
          <Slivers
            editingDisabledReason={editingDisabledReason}
            onInclude={onIncludeSlivers}
            slivers={suggestion.slivers}
          />
          {titlesNotice !== null && !hasWindowTitles(suggestion) ? (
            // The description falls back to app names without titles; say
            // why next to it, where the gap shows.
            <div className="text-xs" data-activity-titles-reason="">
              {titlesNotice}
            </div>
          ) : null}
          <Textarea
            aria-label={t("entryNarrative")}
            className="min-h-16 shrink-0 resize-none"
            data-activity-narrative={writtenPhase(edit.written)}
            disabled={!editable}
            maxLength={DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH}
            onChange={(event) => onEdit({ narrative: event.target.value })}
            rows={2}
            value={edit.narrative}
          />
          {/* Under the description, so it stays the first thing under the
              matter however much stella AI offers. */}
          <DraftAssistStrip
            view={assist}
            onDraft={onDraft}
            onRefine={onRefine}
            onAcceptProposal={onAcceptProposal}
            onDismissProposal={onDismissProposal}
            onUndo={onUndo}
            onRestoreTemplate={onRestoreTemplate}
            onAllow={() => {
              onAllow();
              // The consent buttons go away; keep the card's shortcuts in reach.
              card.current?.focus();
            }}
          />
          <DraftClassification
            classification={edit.classification}
            codeNames={codeNames}
          />
          <GuidelineFlags
            flags={flags}
            onSplit={
              editable && structure?.type === "split" ? onAcceptStructure : null
            }
          />
          {structure === null ? null : (
            <StructureProposal
              editingDisabledReason={editingDisabledReason}
              onAccept={onAcceptStructure}
              structure={structure}
            />
          )}
          <EarlierEntries entries={earlierEntries} />
          <Evidence
            matterId={edit.matter?.id ?? null}
            sourceAppVisuals={sourceAppVisuals}
            suggestion={suggestion}
          />
        </div>
      </ScrollArea>
      <footer
        className="border-border flex flex-col gap-2 border-t px-3.5 pt-2.5 pb-3"
        data-activity-card-actions=""
      >
        <div className="flex flex-wrap items-center gap-2">
          <Label className="gap-2 text-xs">
            <Switch
              checked={edit.billable}
              disabled={!editable}
              onCheckedChange={(billable) => onEdit({ billable })}
            />
            {t("entryBillable")}
          </Label>
          <CopyButton
            className="ms-auto"
            copiedLabel={t("copied")}
            disabled={edit.narrative.trim().length === 0}
            iconClassName="size-4"
            label={t("copySummary")}
            onCopy={onCopy}
            size="sm"
            variant="ghost"
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            disabled={!editable}
            disabledReason={editingDisabledReason}
            onClick={onReject}
            size="sm"
            variant="ghost"
          >
            {t("reject")}
            <ShortcutHint label={shortcutLabel(REJECT_KEYS)} />
          </Button>
          <Button
            disabled={!acceptable}
            disabledReason={acceptDisabledReason}
            onClick={onAccept}
            size="sm"
          >
            {t("accept")}
            <ShortcutHint label={shortcutLabel(ACCEPT_KEYS)} />
          </Button>
        </div>
      </footer>
    </section>
  );
};

/**
 * The start and end of a selected range, to the minute, in the locale's own
 * clock. The exact time the entry covers sits below them; the header keeps
 * the minutes it claims and what they bill under the firm's minimum unit.
 */
const SelectedRangeFields = ({
  durationMs,
  editable,
  times: { date, onRangeChange, range, timeZone },
}: {
  durationMs: number;
  editable: boolean;
  times: Extract<SuggestionTimes, { type: "selected" }>;
}) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const durationLabel = useDurationLabel();
  const errorId = useId();
  const backwards = range.endMs <= range.startMs;
  const move = (edge: RangeEdge) => (time: { hour: number; minute: number }) =>
    onRangeChange(withMovedEdge({ date, edge, range, time, timeZone }));
  return (
    <div className="flex flex-col gap-1.5" data-activity-entry-times="">
      <TimeFieldGroup>
        <TimeField
          disabled={!editable}
          label={t("entryStart")}
          locale={locale}
          onChange={move("start")}
          time={wallClockTime(range.startMs, timeZone)}
        />
        <TimeField
          describedBy={backwards ? errorId : undefined}
          disabled={!editable}
          invalid={backwards}
          label={t("entryEnd")}
          locale={locale}
          onChange={move("end")}
          time={wallClockTime(range.endMs, timeZone)}
        />
      </TimeFieldGroup>
      {backwards ? (
        <p className="text-destructive text-xs" id={errorId}>
          {t("rangeEndBeforeStart")}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs tabular-nums">
          {durationMs < range.endMs - range.startMs
            ? t("rangeDraftedLeftOut", { duration: durationLabel(durationMs) })
            : durationLabel(durationMs)}
        </p>
      )}
    </div>
  );
};

const RANGE_MATTER_NOTES = {
  majority: null,
  mostlyUnmatched: "rangeMostlyUnmatched",
  splitBetweenMatters: "rangeSplitBetweenMatters",
  // The card already says nothing was recorded.
  nothingRecorded: null,
} as const satisfies Record<RangeMatterBasis, string | null>;

/** Why a selected range starts on no matter, when activity was recorded in
 * it. */
const RangeMatterNote = ({
  suggestion,
}: {
  suggestion: ActivitySuggestion;
}) => {
  const t = useTranslations("activity");
  if (suggestion.type !== "manual") {
    return null;
  }
  const note = RANGE_MATTER_NOTES[suggestion.matterBasis];
  return note === null ? null : (
    <p className="text-muted-foreground text-xs text-pretty">{t(note)}</p>
  );
};

/** Why the review suggests the card's matter, while the card keeps it. */
const MatchReasonNote = ({
  suggestion,
}: {
  suggestion: ActivitySuggestion;
}) => {
  const reasonLabel = useMatchReasonLabel();
  const label = reasonLabel(suggestion.reason);
  return label === null ? null : (
    <p className="text-muted-foreground text-xs text-pretty">
      <bdi>{label}</bdi>
    </p>
  );
};

/** What a selected range claims, by where its time was recorded, so the
 * member sees another matter's or unrecorded time before confirming. */
const RangeBreakdownList = ({
  breakdown,
  hasMatter,
}: {
  breakdown: RangeBreakdown;
  hasMatter: boolean;
}) => {
  const t = useTranslations("activity");
  const minutesLabel = useMinutesLabel();
  const rows = [
    { key: "onMatter", label: t("rangeOnThisMatter") },
    {
      key: "onOtherMatters",
      label: hasMatter ? t("rangeOnOtherMatters") : t("rangeOnMatters"),
    },
    { key: "noMatter", label: t("rangeNoMatter") },
    { key: "notRecorded", label: t("rangeNotRecorded") },
  ] as const satisfies readonly { key: keyof RangeBreakdown; label: string }[];
  // Decided on exact time, so a kind under a minute still shows; time all
  // of one kind is the duration the card already states.
  const shown = rows.filter(({ key }) => breakdown[key].durationMs > 0);
  if (shown.length < 2) {
    return null;
  }
  return (
    <DetailsGrid
      aria-label={t("rangeBreakdown")}
      data-activity-range-breakdown=""
      variant="list"
    >
      {shown.map(({ key, label }) => (
        <DetailsItem key={key} label={label}>
          <span className="tabular-nums">
            {minutesLabel(breakdown[key].minutes)}
          </span>
        </DetailsItem>
      ))}
    </DetailsGrid>
  );
};

/** Time no matter claimed between two of this matter's own stretches:
 * named with its apps, and counted only once the member includes it. */
const Slivers = ({
  editingDisabledReason,
  onInclude,
  slivers,
}: {
  editingDisabledReason: string | undefined;
  onInclude: () => void;
  slivers: readonly MatchedSegment[];
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const durationLabel = useDurationLabel();
  if (slivers.length === 0) {
    return null;
  }
  const apps = format.list(
    appTotals(slivers).map(({ durationMs, name }) =>
      t("sliverApp", { app: name, duration: durationLabel(durationMs) }),
    ),
    { type: "unit" },
  );
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs"
      data-activity-slivers=""
    >
      <p className="text-muted-foreground min-w-0 flex-1 text-pretty">
        {t("sliversNote", { apps })}
      </p>
      <Button
        disabled={editingDisabledReason !== undefined}
        disabledReason={editingDisabledReason}
        onClick={onInclude}
        size="xs"
        variant="outline"
      >
        {t("includeSlivers")}
      </Button>
    </div>
  );
};

/**
 * Alternates per stella AI description so the fade restarts each time
 * without remounting the field, which would drop the keyboard focus.
 */
function writtenPhase(written: number) {
  if (written === 0) {
    return "template";
  }
  return written % 2 === 0 ? "written-even" : "written-odd";
}

const ShortcutHint = ({ label }: { label: string }) => (
  <kbd className="font-sans text-xs opacity-60" dir="ltr">
    {label}
  </kbd>
);

/** Whether drafting refused the card's matter: time entries can no longer
 * be created on it, so the card cannot create one either. */
const refusesMatter = (view: DraftAssistView) =>
  (view.type === "failed" && view.kind === "refused") ||
  (view.type === "ready" && view.refineFailure === "refused");

const DRAFT_FAILURE_MESSAGES = {
  off: "aiDraftOff",
  consentRequired: "aiDraftConsentRequired",
  refused: "aiDraftRefused",
  modeChanged: "aiDraftModeChanged",
  tooLarge: "aiDraftTooLarge",
  aiUnavailable: "aiDraftUnavailable",
  failed: "aiDraftFailed",
} as const satisfies Record<DraftFailureKind, string>;

const DraftAssistStrip = ({
  view,
  onDraft,
  onAllow,
  onRefine,
  onAcceptProposal,
  onDismissProposal,
  onUndo,
  onRestoreTemplate,
}: {
  view: DraftAssistView;
  onDraft: () => void;
  onAllow: () => void;
  onRefine: (steer: string, remember: boolean) => void;
  onAcceptProposal: () => void;
  onDismissProposal: () => void;
  onUndo: () => void;
  onRestoreTemplate: () => void;
}) => {
  const t = useTranslations("activity");
  switch (view.type) {
    case "hidden":
      return null;
    case "needsMatter":
      return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AiActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {t("aiDraftNeedsMatter")}
        </p>
      );
    case "writing":
      return (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
        >
          <AiActionIcon aria-hidden="true" className="size-3.5" />
          {t("aiDraftWriting")}
        </p>
      );
    case "failed":
      return (
        <DraftFailure kind={view.kind} onAllow={onAllow} onRetry={onDraft} />
      );
    case "ready":
      return (
        <div
          className="flex flex-col gap-2 text-xs"
          data-activity-draft-ready=""
        >
          {/* The label leads, so the actions wrap from the start edge and
              nothing is left floating at the end of a wrapped row. */}
          <div className="flex flex-wrap items-center gap-1">
            {view.draft === null ? null : (
              <span className="text-muted-foreground me-1">
                <AiLabel
                  disclosure={t("aiDraftDisclosure")}
                  label={t("aiDraftLabel")}
                />
              </span>
            )}
            <DraftButton
              label={
                view.draft === null ? t("aiDraftWrite") : t("aiDraftAgain")
              }
              onClick={onDraft}
            />
            {view.canUndo ? (
              <Button onClick={onUndo} size="xs" variant="ghost">
                {t("aiUndo")}
              </Button>
            ) : null}
            {view.canRestoreTemplate ? (
              <Button onClick={onRestoreTemplate} size="xs" variant="ghost">
                {t("aiUseOriginal")}
              </Button>
            ) : null}
          </div>
          {view.refineFailure === null ? null : (
            <p className="text-muted-foreground text-pretty" role="status">
              {t(DRAFT_FAILURE_MESSAGES[view.refineFailure])}
            </p>
          )}
          {view.draft === null ? null : (
            <RefineInput
              narrativeLanguage={view.draft.narrativeLanguage}
              onRefine={onRefine}
            />
          )}
        </div>
      );
    case "refining":
      return (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
        >
          <AiActionIcon aria-hidden="true" className="size-3.5" />
          {t("aiRefining")}
        </p>
      );
    case "proposal":
      return (
        <section
          aria-label={t("aiProposal")}
          className="bg-muted/60 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-xs"
        >
          <ReviewDiffText
            className="text-sm leading-relaxed"
            segments={diffWords(view.before, view.after).map(
              ({ type, token }) => ({ type, text: token }),
            )}
          />
          <div className="flex gap-1.5">
            <Button onClick={onAcceptProposal} size="xs">
              {t("aiApplyChange")}
            </Button>
            <Button onClick={onDismissProposal} size="xs" variant="ghost">
              {t("aiDismiss")}
            </Button>
          </div>
        </section>
      );
    case "consent":
      return <DraftConsent onAllow={onAllow} status={view.consent} />;
    default:
      view satisfies never;
      return panic("Unhandled stella AI draft view");
  }
};

/**
 * Why stella AI could not draft, in one layout for every kind, with the one
 * action that can still help: Allow when consent is missing, Try again when
 * another attempt can succeed, nothing when only another matter, less
 * detail or the firm can change the outcome.
 */
const DraftFailure = ({
  kind,
  onAllow,
  onRetry,
}: {
  kind: DraftFailureKind;
  onAllow: () => void;
  onRetry: () => void;
}) => {
  const t = useTranslations("activity");
  const recovery = DRAFT_FAILURE_RECOVERY[kind];
  const action = (() => {
    switch (recovery) {
      case "allow":
        return (
          <Button onClick={onAllow} size="xs" variant="outline">
            {t("aiDraftAllow")}
          </Button>
        );
      case "retry":
        return <DraftButton label={t("aiDraftRetry")} onClick={onRetry} />;
      case "none":
        return null;
      default:
        recovery satisfies never;
        return panic("Unhandled draft failure recovery");
    }
  })();
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      data-activity-draft-failure={kind}
    >
      <AiActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 basis-40 text-pretty" role="status">
        {t(DRAFT_FAILURE_MESSAGES[kind])}
      </p>
      {action}
    </div>
  );
};

const STEER_CHIPS = [
  "aiSteerShorter",
  "aiSteerMoreDetail",
  "aiSteerClientFriendly",
] as const;

/** A BCP 47 tag's language subtag, the one before any script or region. */
const languageSubtag = (tag: string) => tag.split("-", 1).at(0)?.toLowerCase();

/** Whether two language tags name the same language, whatever the region. */
const sameLanguage = (left: string, right: string) =>
  languageSubtag(left) === languageSubtag(right);

/** An instruction for stella AI to change the draft, with quick chips and the
 * choice to remember it for future drafts. The chip asking for the window's
 * language shows only on a draft written in another one. */
const RefineInput = ({
  narrativeLanguage,
  onRefine,
}: {
  narrativeLanguage: string;
  onRefine: (steer: string, remember: boolean) => void;
}) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const chips = [
    ...STEER_CHIPS.map((key) => t(key)),
    // Each catalogue names its own language, as people say it.
    ...(sameLanguage(narrativeLanguage, locale)
      ? []
      : [t("aiSteerWriteInLanguage")]),
  ];
  const steer = text.trim();
  return (
    <Form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (steer.length === 0) {
          return;
        }
        onRefine(steer, remember);
        setText("");
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={t("aiRefinePlaceholder")}
          className="h-8 flex-1"
          maxLength={DESKTOP_BILLING_DRAFT_LIMITS.steerLength}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("aiRefinePlaceholder")}
          value={text}
        />
        <Button
          disabled={steer.length === 0}
          disabledReason={t("enterRefinement")}
          size="sm"
          type="submit"
        >
          {t("aiRefine")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <Button
            key={chip}
            onClick={() => setText(chip)}
            size="xs"
            type="button"
            variant="outline"
          >
            {chip}
          </Button>
        ))}
        <Label className="text-muted-foreground ms-auto gap-1.5 text-xs">
          <Checkbox checked={remember} onCheckedChange={setRemember} />
          {t("aiSteerRemember")}
        </Label>
      </div>
    </Form>
  );
};

const DraftButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <Button onClick={onClick} size="xs" variant="ghost">
    <AiActionIcon aria-hidden="true" />
    {label}
  </Button>
);

type BillingCodeType = (typeof BILLING_CODE_TYPES)[number];

/** The UTBMS codes a guided draft gave an entry billed in LEDES. */
const DraftClassification = ({
  classification,
  codeNames,
}: {
  classification: DesktopTimeEntryClassification | null;
  codeNames: CardDraft["codeNames"];
}) => {
  const t = useTranslations("activity");
  if (classification?.type !== "ledes") {
    return null;
  }
  // A code the matter's code list does not name shows on its own.
  const named = (type: BillingCodeType, code: string) => {
    const name = codeNames.find(
      (entry) => entry.type === type && entry.code === code,
    )?.name;
    return name === undefined ? code : t("aiDraftCodeNamed", { code, name });
  };
  return (
    <p className="text-muted-foreground text-xs text-pretty">
      {t("aiDraftCodes", {
        task: named("task", classification.taskCode),
        activity: named("activity", classification.activityCode),
      })}
    </p>
  );
};

/** What a guided draft noted against the firm's billing guidelines, each
 * with the file and section it cites; a note a split fixes offers it. */
const GuidelineFlags = ({
  flags,
  onSplit,
}: {
  flags: CardDraft["flags"];
  onSplit: (() => void) | null;
}) => {
  const t = useTranslations("activity");
  if (flags.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={t("aiDraftFlags")}
      className="bg-muted/60 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-xs"
    >
      <span className="font-medium">{t("aiDraftFlags")}</span>
      <ul className="flex flex-col gap-2">
        {flags.map((flag) => (
          <li
            className="flex flex-col gap-0.5"
            key={`${flag.fileName}\n${flag.section}\n${flag.text}`}
          >
            <bdi className="text-pretty">{flag.text}</bdi>
            <span className="text-muted-foreground text-pretty">
              {t("aiDraftFlagSource", {
                file: flag.fileName,
                section: flag.section,
              })}
            </span>
            {flag.fix === "split" && onSplit !== null ? (
              <Button
                className="self-start"
                onClick={onSplit}
                size="xs"
                variant="outline"
              >
                {t("aiFlagSplit")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** A guided draft's split or move: the entries it would create, which only
 * Accept creates. */
const StructureProposal = ({
  structure,
  editingDisabledReason,
  onAccept,
}: {
  structure: NonNullable<CardDraft["structure"]>;
  editingDisabledReason: string | undefined;
  onAccept: () => void;
}) => {
  const t = useTranslations("activity");
  const durationLabel = useDurationLabel();
  const minutes = (value: number) => durationLabel(value * 60_000);
  // A proposal never changes once shown, so a part's place is its identity.
  const parts = (
    structure.type === "split"
      ? structure.parts
      : [
          {
            durationMinutes: structure.durationMinutes,
            narrative: structure.narrative,
          },
        ]
  ).map(({ durationMinutes, narrative }, position) => ({
    durationMinutes,
    narrative,
    key: `part-${String(position)}`,
  }));
  const title =
    structure.type === "split"
      ? t("aiStructureSplit", { count: structure.parts.length })
      : t("aiStructureMove", {
          duration: minutes(structure.durationMinutes),
          matter: structure.targetMatterName,
        });
  return (
    <section
      aria-label={title}
      className="bg-muted/60 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-xs"
    >
      <span className="flex items-center gap-1.5 font-medium">
        <AiActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <bdi className="min-w-0 text-pretty">{title}</bdi>
      </span>
      <ul className="flex flex-col gap-1">
        {parts.map((part) => (
          <li className="flex gap-2" key={part.key}>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {minutes(part.durationMinutes)}
            </span>
            <bdi className="min-w-0 text-pretty">{part.narrative}</bdi>
          </li>
        ))}
      </ul>
      <Button
        className="self-start"
        disabled={editingDisabledReason !== undefined}
        disabledReason={editingDisabledReason}
        onClick={onAccept}
        size="xs"
      >
        {structure.type === "split"
          ? t("aiStructureCreate", { count: structure.parts.length })
          : t("aiStructureMoveAccept")}
      </Button>
    </section>
  );
};

/** The user's own earlier entries the draft followed, so its wording can be
 * checked against them. */
/** Says the card's matter already has time that day from another computer
 * or the web, so the same minutes are not billed twice. */
const RecordedElsewhereNote = ({
  matterId,
  notice: { dayEntries, draftedEntries, day, onReview, onRetry },
}: {
  matterId: string | null;
  notice: RecordedElsewhereNotice;
}) => {
  const t = useTranslations("activity");
  const durationLabel = useDurationLabel();
  const status = recordedElsewhere({ dayEntries, draftedEntries, matterId });
  switch (status.type) {
    case "none":
      return null;
    case "recorded":
      return (
        <div
          className="bg-muted/60 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-2 text-xs"
          data-activity-recorded-elsewhere=""
          role="status"
        >
          <span className="text-pretty">
            {t("recordedElsewhere", {
              day,
              duration: durationLabel(status.minutes * MINUTE_MS),
            })}
          </span>
          <Button
            onClick={() => onReview(status.matterId)}
            size="xs"
            variant="outline"
          >
            {t("recordedElsewhereReview")}
          </Button>
        </div>
      );
    case "unknown":
      return (
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
          data-activity-recorded-elsewhere=""
          role="status"
        >
          {t("recordedElsewhereUnknown")}
          <Button onClick={onRetry} size="xs" variant="ghost">
            {t("retry")}
          </Button>
        </div>
      );
    default:
      status satisfies never;
      return panic("Unknown recorded-elsewhere status");
  }
};

const EarlierEntries = ({
  entries,
}: {
  entries: CardDraft["earlierEntries"];
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const durationLabel = useDurationLabel();
  if (entries.length === 0) {
    return null;
  }
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={<Button className="self-start" size="xs" variant="ghost" />}
      >
        {t("aiDraftEarlierEntries", { count: entries.length })}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="flex flex-col gap-1.5 text-xs">
          {entries.map((entry) => (
            <li className="flex flex-col gap-0.5" key={entry.id}>
              <span className="text-muted-foreground tabular-nums">
                {format.dateTime(calendarDate(entry.dateWorked), {
                  dateStyle: "medium",
                })}
                {" · "}
                {durationLabel(entry.durationMinutes * 60_000)}
              </span>
              <bdi className="text-pretty">{entry.narrative}</bdi>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
};

/** The recorded time behind a card, by title or by app. A row whose time
 * went to a matter other than the card's names that matter faintly. */
const Evidence = ({
  matterId,
  suggestion,
  sourceAppVisuals,
}: {
  /** The card's matter, which its own rows need not repeat. */
  matterId: string | null;
  suggestion: ActivitySuggestion;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
}) => {
  const t = useTranslations("activity");
  const titles = titleRows(suggestion);
  const apps = appRows(suggestion);
  if (apps.length === 0) {
    return null;
  }
  // Untitled time alone would only repeat the Apps tab.
  const titled = hasWindowTitles(suggestion);
  return (
    <Tabs defaultValue={titled ? "titles" : "apps"}>
      <TabsList variant="underline">
        <TabsTab disabled={!titled} value="titles">
          {t("evidenceTitles")}
        </TabsTab>
        <TabsTab value="apps">{t("evidenceApps")}</TabsTab>
      </TabsList>
      <TabsPanel value="titles">
        <EvidenceRows
          matterId={matterId}
          rows={titles}
          sourceAppVisuals={sourceAppVisuals}
        />
      </TabsPanel>
      <TabsPanel value="apps">
        <EvidenceRows
          matterId={matterId}
          rows={apps}
          sourceAppVisuals={sourceAppVisuals}
        />
      </TabsPanel>
    </Tabs>
  );
};

const EVIDENCE_ROW_LIMIT = 8;

const EvidenceRows = ({
  matterId,
  rows,
  sourceAppVisuals,
}: {
  matterId: string | null;
  rows: readonly EvidenceRow[];
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  return (
    <ul className="flex flex-col gap-1.5 pt-2 text-xs">
      {rows.slice(0, EVIDENCE_ROW_LIMIT).map((row) => (
        <li className="flex flex-col gap-1" key={row.id}>
          <div className="flex min-w-0 items-center gap-2">
            <ActivitySourceIcon
              appIdentifier={row.appIdentifier}
              sourceAppVisuals={sourceAppVisuals}
            />
            <EvidenceLabel row={row} />
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {t("durationMinutes", {
                minutes: Math.max(1, Math.round(row.durationMs / 60_000)),
              })}{" "}
              · {format.number(row.share, { style: "percent" })}
            </span>
          </div>
          {row.matter === null || row.matter.id === matterId ? null : (
            // Under the title, past the icon's width and gap.
            <TruncatedText
              className="text-foreground-subtle -mt-0.5 ps-6"
              data-activity-evidence-matter=""
              render={<bdi />}
            >
              {row.matter.name}
            </TruncatedText>
          )}
          <div aria-hidden="true" className="bg-muted h-1 rounded-full">
            <div
              className="bg-foreground-muted h-1 rounded-full"
              style={{ inlineSize: `${String(row.share * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
};

const EvidenceLabel = ({ row }: { row: EvidenceRow }) => {
  const t = useTranslations("activity");
  switch (row.type) {
    case "named":
      return (
        <TruncatedText className="flex-1" render={<bdi />}>
          {row.label}
        </TruncatedText>
      );
    case "untitled":
      return (
        <TruncatedText
          className="text-muted-foreground flex-1"
          render={<bdi />}
        >
          {t("evidenceUntitled", { app: row.label })}
        </TruncatedText>
      );
    default:
      row.type satisfies never;
      return panic("Unhandled evidence row");
  }
};
