import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

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

import { detectDesktopPlatform, formatShortcut } from "../shared/shortcut-keys";
import type { ShortcutKeys } from "../shared/shortcut-keys";
import {
  appRows,
  titleRows,
  wallClockTime,
  withMovedEdge,
} from "./activity-calendar-logic";
import type {
  ActivitySuggestion,
  EvidenceRow,
  RangeEdge,
  RangeMatterBasis,
} from "./activity-calendar-logic";
import { calendarDate } from "./activity-logic";
import type { ActivityDaySnapshot } from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import type { CardDraft, DraftFailureKind } from "./billing-draft-logic";
import { MatterPicker } from "./MatterPicker";
import { useDurationLabel } from "./use-duration-label";

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

/** What the stella AI strip above the narrative shows. `hidden` when the
 * firm has drafting off or its settings cannot be read. */
export type DraftAssistView =
  | { type: "hidden" }
  | { type: "needsMatter" }
  | { pending: boolean; type: "consent" }
  | {
      canUndo: boolean;
      canRestoreTemplate: boolean;
      drafted: boolean;
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

type ActivitySuggestionCardProps = {
  suggestion: ActivitySuggestion;
  times: SuggestionTimes;
  edit: SuggestionEdit;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  editable: boolean;
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
  candidates,
  editable,
  timeLabel,
  sourceAppVisuals,
  titlesNotice,
  assist,
  earlierEntries,
  flags,
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
  onClose,
  onCopy,
}: ActivitySuggestionCardProps) => {
  const t = useTranslations("activity");
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
  const acceptable =
    editable &&
    edit.matter !== null &&
    edit.narrative.trim().length > 0 &&
    suggestion.roundedTenths > 0;
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
            <bdi className="truncate">{title}</bdi>
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
          {suggestion.segments.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("rangeEmpty")}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("entryMatter")}
            </span>
            <MatterPicker
              candidates={candidates}
              disabled={!editable}
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
          {titlesNotice !== null && titleRows(suggestion).length === 0 ? (
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
          <DraftClassification classification={edit.classification} />
          <GuidelineFlags
            flags={flags}
            onSplit={
              editable && structure?.type === "split" ? onAcceptStructure : null
            }
          />
          {structure === null ? null : (
            <StructureProposal
              editable={editable}
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
            onClick={onReject}
            size="sm"
            variant="ghost"
          >
            {t("reject")}
            <ShortcutHint label={shortcutLabel(REJECT_KEYS)} />
          </Button>
          <Button disabled={!acceptable} onClick={onAccept} size="sm">
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
 * the hours it bills, which round up to a tenth.
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

const DRAFT_FAILURE_MESSAGES = {
  off: "aiDraftOff",
  consentRequired: "aiDraftConsentRequired",
  refused: "aiDraftRefused",
  modeChanged: "aiDraftModeChanged",
  tooLarge: "aiDraftTooLarge",
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
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <p role="status">{t(DRAFT_FAILURE_MESSAGES[view.kind])}</p>
          {view.kind === "off" || view.kind === "refused" ? null : (
            <DraftButton label={t("aiDraftRetry")} onClick={onDraft} />
          )}
        </div>
      );
    case "ready":
      return (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <DraftButton
              label={view.drafted ? t("aiDraftAgain") : t("aiDraftWrite")}
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
            {view.drafted ? (
              <span className="text-muted-foreground ms-auto">
                <AiLabel
                  disclosure={t("aiDraftDisclosure")}
                  label={t("aiDraftLabel")}
                />
              </span>
            ) : null}
          </div>
          {view.refineFailure === null ? null : (
            <p className="text-muted-foreground" role="status">
              {t(DRAFT_FAILURE_MESSAGES[view.refineFailure])}
            </p>
          )}
          {view.drafted ? <RefineInput onRefine={onRefine} /> : null}
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
              {t("aiAccept")}
            </Button>
            <Button onClick={onDismissProposal} size="xs" variant="ghost">
              {t("aiDismiss")}
            </Button>
          </div>
        </section>
      );
    case "consent":
      return <DraftConsent onAllow={onAllow} pending={view.pending} />;
    default:
      view satisfies never;
      return panic("Unhandled stella AI draft view");
  }
};

/**
 * The ask before stella AI drafts anything: one line and Allow, with what a
 * draft sends a click away. Allow is the same consent whether or not the
 * details are open.
 */
const DraftConsent = ({
  onAllow,
  pending,
}: {
  onAllow: () => void;
  pending: boolean;
}) => {
  const t = useTranslations("activity");
  return (
    <Collapsible
      className="bg-muted/60 flex flex-col gap-2 rounded-lg px-2.5 py-2 text-xs"
      data-activity-draft-consent=""
    >
      <div className="flex items-center gap-2">
        <AiActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 text-pretty">
          {t("aiDraftOffer")}{" "}
          <CollapsibleTrigger render={<Button size="inline" variant="link" />}>
            {t("aiDraftWhatIsSent")}
          </CollapsibleTrigger>
        </p>
        <Button loading={pending} onClick={onAllow} size="xs" variant="outline">
          {t("aiDraftAllow")}
        </Button>
      </div>
      <CollapsiblePanel>
        <p className="text-muted-foreground ps-5.5 text-pretty">
          {t("aiDraftConsent")}
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
};

const STEER_CHIPS = [
  "aiSteerShorter",
  "aiSteerMoreDetail",
  "aiSteerClientFriendly",
  // Each catalogue names its own language, as people say it.
  "aiSteerWriteInLanguage",
] as const;

/** An instruction for stella AI to change the draft, with quick chips and the
 * choice to remember it for future drafts. */
const RefineInput = ({
  onRefine,
}: {
  onRefine: (steer: string, remember: boolean) => void;
}) => {
  const t = useTranslations("activity");
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const chips = STEER_CHIPS.map((key) => t(key));
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
        <Button disabled={steer.length === 0} size="sm" type="submit">
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

/** The UTBMS codes a guided draft gave an entry billed in LEDES. */
const DraftClassification = ({
  classification,
}: {
  classification: DesktopTimeEntryClassification | null;
}) => {
  const t = useTranslations("activity");
  if (classification?.type !== "ledes") {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {t("aiDraftCodes", {
        task: classification.taskCode,
        activity: classification.activityCode,
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
      className="flex flex-col gap-1.5 text-xs"
    >
      <span className="font-medium">{t("aiDraftFlags")}</span>
      <ul className="flex flex-col gap-1.5">
        {flags.map((flag) => (
          <li
            className="flex flex-col gap-0.5"
            key={`${flag.fileName}\n${flag.section}\n${flag.text}`}
          >
            <bdi className="text-pretty">{flag.text}</bdi>
            <span className="text-muted-foreground">
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
  editable,
  onAccept,
}: {
  structure: NonNullable<CardDraft["structure"]>;
  editable: boolean;
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
        disabled={!editable}
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
  const titled = titles.some(({ type }) => type === "named");
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
            <bdi
              className="text-foreground-subtle -mt-0.5 truncate ps-6"
              data-activity-evidence-matter=""
            >
              {row.matter.name}
            </bdi>
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
      return <bdi className="min-w-0 flex-1 truncate">{row.label}</bdi>;
    case "untitled":
      return (
        <bdi className="text-muted-foreground min-w-0 flex-1 truncate">
          {t("evidenceUntitled", { app: row.label })}
        </bdi>
      );
    default:
      row.type satisfies never;
      return panic("Unhandled evidence row");
  }
};
