/**
 * One position as a row, shared by every surface that shows positions: the
 * review facet's confirm step, the playbook editor's cards, and the results.
 *
 * It lives here rather than beside the playbook editor because the inspector
 * is shared chrome: a facet that reached into `@/routes/_protected…` for a row
 * would bind the panel to a route it can be mounted outside of, which
 * `inspector-route-boundary.test.ts` enforces.
 */

import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { ReviewStandardPassages } from "@/components/ai-suggestions/review-passage-side";
import {
  PositionHeader,
  type PositionTermKind,
} from "@/components/ai-suggestions/review-position-header";
import { Switch } from "@/components/switch";
import type { TranslationKey } from "@/i18n/types";
import type {
  Position,
  PositionSeverity,
  ReferencePassage,
} from "@/lib/knowledge/playbook-types";

// TODO(i18n): English until the review surface is localized as a whole.
const REFERENCE_DOCUMENT_LABEL = "Reference document";

/** Reference passages carry the document they were quoted from by id only, so
 *  a caller that knows the run's pinned references can name them. */
export type ReferenceNameLookup = ReadonlyMap<string, string>;

const SEVERITIES = [
  "blocker",
  "high",
  "medium",
  "low",
] as const satisfies readonly PositionSeverity[];

type MissingPositionSeverity = Exclude<
  PositionSeverity,
  (typeof SEVERITIES)[number]
>;

true satisfies MissingPositionSeverity extends never ? true : never;

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

const isSeverity = (value: string): value is PositionSeverity =>
  SEVERITIES.some((severity) => severity === value);

/** What kind of term this position compares, when its standard was read from a
 *  reference. An authored ladder states no kind, so its header shows none. */
export const positionTermKind = (
  position: Position,
): PositionTermKind | null =>
  position.mode === "graded" && position.standard.source === "reference"
    ? position.standard.termKind
    : null;

export const SeverityChip = ({
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

/**
 * A position's pinned reference passages, drawn exactly as the results card
 * draws its "Standard" column: one block per document, clause numbers hanging
 * in the margin, the same key-term marks, the same collapse. A playbook
 * position and the finding it produces must not read as two different things.
 */
export const ReferencePassageList = ({
  passages,
  referenceNames,
}: {
  passages: readonly ReferencePassage[];
  referenceNames: ReferenceNameLookup | undefined;
}) => (
  <div className="space-y-3">
    {groupPassagesByReference(passages).map((group) => (
      <ReviewStandardPassages
        key={group.fileFieldId}
        label={
          referenceNames?.get(group.fileFieldId) ?? REFERENCE_DOCUMENT_LABEL
        }
        passages={group.passages}
      />
    ))}
  </div>
);

type ReferencePassageGroup = {
  fileFieldId: string;
  passages: ReferencePassage[];
};

/** Passages read as one continuous quote per document, in the order they were
 *  pinned; the label above each group names the document they came from. */
const groupPassagesByReference = (
  passages: readonly ReferencePassage[],
): ReferencePassageGroup[] => {
  const groups: ReferencePassageGroup[] = [];
  for (const passage of passages) {
    const group = groups.find(
      (candidate) => candidate.fileFieldId === passage.fileFieldId,
    );
    if (group === undefined) {
      groups.push({ fileFieldId: passage.fileFieldId, passages: [passage] });
      continue;
    }
    group.passages.push(passage);
  }
  return groups;
};

/**
 * The confirm step's one-line position: the four fields a reviewer actually
 * changes before starting a run, in the same header the results card uses.
 * Everything else a position can carry (tiers, ask, negotiation, the
 * deterministic check) belongs to the playbook editor.
 */
export const PositionQuickRow = ({
  position,
  index,
  referenceNames,
  onChange,
  onRemove,
}: {
  position: Position;
  index: number;
  referenceNames: ReferenceNameLookup | undefined;
  onChange: (position: Position) => void;
  onRemove: () => void;
}) => {
  const t = useTranslations();
  const passages =
    position.mode === "graded" && position.standard.source === "reference"
      ? position.standard.passages
      : null;

  return (
    <div
      className={cn(
        "bg-card rounded-lg border transition-opacity duration-150",
        !position.enabled && "opacity-60",
      )}
    >
      <PositionHeader
        actions={
          <>
            <Switch
              aria-label={t("knowledge.playbooks.enablePosition")}
              checked={position.enabled}
              className="shrink-0"
              onCheckedChange={(enabled) => onChange({ ...position, enabled })}
            />
            <Button
              aria-label={t("knowledge.playbooks.deletePosition")}
              onClick={onRemove}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </>
        }
        index={index}
        label={
          position.mode === "graded" && (
            <SeverityChip
              onChange={(severity) => onChange({ ...position, severity })}
              severity={position.severity}
            />
          )
        }
        termKind={positionTermKind(position)}
        title={
          <Input
            aria-label={t("knowledge.playbooks.issueLabel")}
            className="hover:border-input focus-visible:bg-background h-8 w-full border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none"
            maxLength={256}
            onChange={(e) => onChange({ ...position, issue: e.target.value })}
            placeholder={t("knowledge.playbooks.issuePlaceholder")}
            value={position.issue}
          />
        }
      />
      {passages !== null && (
        <div className="px-3 pb-3">
          <ReferencePassageList
            passages={passages}
            referenceNames={referenceNames}
          />
        </div>
      )}
    </div>
  );
};
