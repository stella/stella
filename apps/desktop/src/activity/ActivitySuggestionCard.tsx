import { useEffect, useEffectEvent, useRef, useState } from "react";

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
import { Form } from "@stll/ui/form";
import { AiActionIcon, XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
import { ReviewDiffText } from "@stll/ui/review-diff-text";
import { diffWords } from "@stll/ui/review-word-diff";
import { Switch } from "@stll/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/tabs";
import { Textarea } from "@stll/ui/textarea";

import { detectDesktopPlatform, formatShortcut } from "../shared/shortcut-keys";
import type { ShortcutKeys } from "../shared/shortcut-keys";
import { appRows, titleRows } from "./activity-calendar-logic";
import type {
  ActivitySuggestion,
  EvidenceRow,
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
  undo: Pick<SuggestionEdit, "narrative" | "classification"> | null;
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

type ActivitySuggestionCardProps = {
  suggestion: ActivitySuggestion;
  edit: SuggestionEdit;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  editable: boolean;
  timeLabel: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  assist: DraftAssistView;
  /** The user's earlier entries the current draft followed. */
  earlierEntries: CardDraft["earlierEntries"];
  /** The current guided draft's notes against the billing guidelines. */
  flags: CardDraft["flags"];
  onDraft: () => void;
  onAllow: () => void;
  onRefine: (steer: string, remember: boolean) => void;
  onAcceptProposal: () => void;
  onDismissProposal: () => void;
  onUndo: () => void;
  onRestoreTemplate: () => void;
  onEdit: (change: Partial<SuggestionEdit>) => void;
  onAccept: () => void;
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
  edit,
  candidates,
  editable,
  timeLabel,
  sourceAppVisuals,
  assist,
  earlierEntries,
  flags,
  onDraft,
  onAllow,
  onRefine,
  onAcceptProposal,
  onDismissProposal,
  onUndo,
  onRestoreTemplate,
  onEdit,
  onAccept,
  onReject,
  onClose,
  onCopy,
}: ActivitySuggestionCardProps) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const card = useRef<HTMLElement>(null);
  // The card is keyed by suggestion: each one takes focus as it opens, so a
  // day can be triaged from the keyboard.
  useEffect(() => {
    card.current?.focus();
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
      className="bg-popover text-popover-foreground ring-border flex flex-col gap-3 rounded-xl p-3.5 text-sm shadow-lg ring-1 outline-none"
      data-activity-suggestion-card={suggestion.id}
      ref={card}
      tabIndex={-1}
    >
      <header className="flex items-start gap-2">
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
          // drops them until it is drafted again.
          onChoose={(matter) => onEdit({ matter, classification: null })}
        />
      </div>
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
      <Textarea
        aria-label={t("entryNarrative")}
        className="min-h-16 resize-none"
        data-activity-narrative={writtenPhase(edit.written)}
        disabled={!editable}
        maxLength={DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH}
        onChange={(event) => onEdit({ narrative: event.target.value })}
        rows={2}
        value={edit.narrative}
      />
      <DraftClassification classification={edit.classification} />
      <GuidelineFlags flags={flags} />
      <EarlierEntries entries={earlierEntries} />
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
      <Evidence suggestion={suggestion} sourceAppVisuals={sourceAppVisuals} />
    </section>
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
      return (
        <div
          className="bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2.5 py-2 text-xs"
          data-activity-draft-consent=""
        >
          <p className="flex min-w-0 flex-1 basis-56 items-start gap-1.5 text-pretty">
            <AiActionIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            {t("aiDraftConsent")}
          </p>
          <Button
            loading={view.pending}
            onClick={onAllow}
            size="xs"
            variant="outline"
          >
            {t("aiDraftAllow")}
          </Button>
        </div>
      );
    default:
      view satisfies never;
      return panic("Unhandled stella AI draft view");
  }
};

const STEER_CHIPS = [
  "aiSteerShorter",
  "aiSteerMoreDetail",
  "aiSteerClientFriendly",
] as const;

/** An instruction for stella AI to change the draft, with quick chips and the
 * choice to remember it for future drafts. */
const RefineInput = ({
  onRefine,
}: {
  onRefine: (steer: string, remember: boolean) => void;
}) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const language = new Intl.DisplayNames([locale], { type: "language" }).of(
    locale,
  );
  const chips = [
    ...STEER_CHIPS.map((key) => t(key)),
    ...(language === undefined ? [] : [t("aiSteerWriteIn", { language })]),
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
 * with the file and section it cites. */
const GuidelineFlags = ({ flags }: { flags: CardDraft["flags"] }) => {
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
          </li>
        ))}
      </ul>
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

const Evidence = ({
  suggestion,
  sourceAppVisuals,
}: {
  suggestion: ActivitySuggestion;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
}) => {
  const t = useTranslations("activity");
  const titles = titleRows(suggestion);
  const apps = appRows(suggestion);
  if (apps.length === 0) {
    return null;
  }
  return (
    <Tabs defaultValue={titles.length > 0 ? "titles" : "apps"}>
      <TabsList variant="underline">
        <TabsTab disabled={titles.length === 0} value="titles">
          {t("evidenceTitles")}
        </TabsTab>
        <TabsTab value="apps">{t("evidenceApps")}</TabsTab>
      </TabsList>
      <TabsPanel value="titles">
        <EvidenceRows rows={titles} sourceAppVisuals={sourceAppVisuals} />
      </TabsPanel>
      <TabsPanel value="apps">
        <EvidenceRows rows={apps} sourceAppVisuals={sourceAppVisuals} />
      </TabsPanel>
    </Tabs>
  );
};

const EVIDENCE_ROW_LIMIT = 8;

const EvidenceRows = ({
  rows,
  sourceAppVisuals,
}: {
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
            <bdi className="min-w-0 flex-1 truncate">{row.label}</bdi>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {t("durationMinutes", {
                minutes: Math.max(1, Math.round(row.durationMs / 60_000)),
              })}{" "}
              · {format.number(row.share, { style: "percent" })}
            </span>
          </div>
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
