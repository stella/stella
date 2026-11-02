import { useEffect, useEffectEvent, useRef } from "react";

import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "@stll/api-contract/desktop-time-entries";
import type {
  DesktopMatter,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Button } from "@stll/ui/button";
import { CopyButton } from "@stll/ui/copy-button";
import { AiActionIcon, XIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
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
import type { ActivityDaySnapshot } from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { MatterPicker } from "./MatterPicker";

/** The editable fields of one suggestion. `written` counts stella AI
 * descriptions, so each new one fades in. */
export type SuggestionEdit = {
  billable: boolean;
  matter: DesktopMatter | null;
  narrative: string;
  written: number;
};

/** What the stella AI strip above the narrative shows. */
export type NarrativeAssistView =
  | { type: "ask" }
  | { type: "folded" }
  | { type: "writing" }
  | { type: "failed" }
  | { type: "hidden" };

export type AssistChoice = "no" | "once" | "always";

type ActivitySuggestionCardProps = {
  suggestion: ActivitySuggestion;
  edit: SuggestionEdit;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  editable: boolean;
  timeLabel: string;
  sourceAppVisuals: ActivityDaySnapshot["sourceAppVisuals"];
  assist: NarrativeAssistView;
  onAssist: (choice: AssistChoice) => void;
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
  onAssist,
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
          onChoose={(matter) => onEdit({ matter })}
        />
      </div>
      <NarrativeAssistStrip
        view={assist}
        onChoose={(choice) => {
          onAssist(choice);
          // The strip's buttons go away; keep the card's shortcuts in reach.
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

const NarrativeAssistStrip = ({
  view,
  onChoose,
}: {
  view: NarrativeAssistView;
  onChoose: (choice: AssistChoice) => void;
}) => {
  const t = useTranslations("activity");
  switch (view.type) {
    case "hidden":
      return null;
    case "writing":
      return (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
        >
          <AiActionIcon aria-hidden="true" className="size-3.5" />
          {t("narrativeAiWriting")}
        </p>
      );
    case "failed":
      return (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <p role="status">{t("narrativeAiFailed")}</p>
          <WriteWithAiButton onClick={() => onChoose("once")} />
        </div>
      );
    case "folded":
      return (
        <div>
          <WriteWithAiButton onClick={() => onChoose("once")} />
        </div>
      );
    case "ask":
      return (
        <div
          className="bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2.5 py-2 text-xs"
          data-activity-narrative-consent=""
        >
          <p className="flex min-w-0 flex-1 basis-56 items-start gap-1.5 text-pretty">
            <AiActionIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            {t("narrativeAiPrompt")}
          </p>
          <div className="flex gap-1">
            <Button onClick={() => onChoose("no")} size="xs" variant="ghost">
              {t("narrativeAiNo")}
            </Button>
            <Button
              onClick={() => onChoose("once")}
              size="xs"
              variant="outline"
            >
              {t("narrativeAiApprove")}
            </Button>
            <Button
              onClick={() => onChoose("always")}
              size="xs"
              variant="outline"
            >
              {t("narrativeAiAlways")}
            </Button>
          </div>
        </div>
      );
    default:
      view satisfies never;
      return panic("Unhandled narrative assist view");
  }
};

const WriteWithAiButton = ({ onClick }: { onClick: () => void }) => {
  const t = useTranslations("activity");
  return (
    <Button onClick={onClick} size="xs" variant="ghost">
      <AiActionIcon aria-hidden="true" />
      {t("narrativeAiWrite")}
    </Button>
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
