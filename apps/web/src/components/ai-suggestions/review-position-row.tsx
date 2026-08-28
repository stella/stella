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

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import type { ReviewSeverityLevel } from "@stll/ui/review-severity-dot";
import {
  ReviewSeverityDot,
  reviewSeverityTone,
} from "@stll/ui/review-severity-dot";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import {
  PASSAGE_COLLAPSE,
  ReviewStandardPassages,
} from "@/components/ai-suggestions/review-passage-side";
import { PositionHeader } from "@/components/ai-suggestions/review-position-header";
import { Switch } from "@/components/switch";
import type { TranslationKey } from "@/i18n/types";
import type {
  Position,
  PositionSeverity,
  ReferencePassage,
} from "@/lib/knowledge/playbook-types";

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

/** The playbook's severity vocabulary on the product's shared review scale.
 *  `blocker` has no direct counterpart on the shared scale and carries the
 *  same weight as a `critical` finding. */
const POSITION_SEVERITY_LEVEL = {
  blocker: "critical",
  high: "high",
  medium: "medium",
  low: "low",
} as const satisfies Record<PositionSeverity, ReviewSeverityLevel>;

const isSeverity = (value: string): value is PositionSeverity =>
  SEVERITIES.some((severity) => severity === value);

/** How much a position matters, as a word, where it cannot be changed: the
 *  same chip the editors offer, minus the menu. */
export const SeverityWord = ({ severity }: { severity: PositionSeverity }) => {
  const t = useTranslations();
  const level = POSITION_SEVERITY_LEVEL[severity];
  return (
    <ReviewStatusBadge
      icon={<ReviewSeverityDot level={level} />}
      tone={reviewSeverityTone(level)}
      variant="solid"
    >
      {t(SEVERITY_LABEL_KEYS[severity])}
    </ReviewStatusBadge>
  );
};

export const SeverityChip = ({
  severity,
  onChange,
}: {
  severity: PositionSeverity;
  onChange: (severity: PositionSeverity) => void;
}) => {
  const t = useTranslations();
  const level = POSITION_SEVERITY_LEVEL[severity];
  return (
    <Menu>
      <MenuTrigger
        aria-label={t("knowledge.playbooks.severityLabel")}
        className="focus-visible:ring-ring rounded-full focus-visible:ring-2 focus-visible:outline-none"
      >
        <ReviewStatusBadge
          icon={<ReviewSeverityDot level={level} />}
          tone={reviewSeverityTone(level)}
          variant="solid"
        >
          {t(SEVERITY_LABEL_KEYS[severity])}
        </ReviewStatusBadge>
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
 *
 * Collapsed to the opening lines wherever a position appears in a list. The
 * quote is the evidence behind the issue, and a reviewer reading twenty
 * proposed positions is reading the issues; the expander names how many
 * passages are behind it so the cost of opening it is stated.
 */
export const ReferencePassageList = ({
  passages,
  referenceNames,
}: {
  passages: readonly ReferencePassage[];
  referenceNames: ReferenceNameLookup | undefined;
}) => {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      {groupPassagesByReference(passages).map((group) => (
        <ReviewStandardPassages
          collapse={PASSAGE_COLLAPSE.compact}
          expandLabel={t("inspector.review.passagesCount", {
            count: group.passages.length,
          })}
          key={group.fileFieldId}
          label={
            referenceNames?.get(group.fileFieldId) ??
            t("inspector.review.referenceDocument")
          }
          passages={group.passages}
        />
      ))}
    </div>
  );
};

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
 * One line of a position's own words, labelled so the two lines cannot be
 * confused for each other: what a comparison will examine, and why the term
 * exists at all. Empty renders nothing — a missing sentence is not worth a
 * label of its own.
 */
const PositionNote = ({ label, text }: { label: string; text: string }) => {
  if (text.trim().length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-sm leading-6 text-pretty">
      <span className="text-foreground-strong-muted font-medium">{label}</span>{" "}
      <BidiText as="span">{text}</BidiText>
    </p>
  );
};

/**
 * The proposed position as a reviewer meets it: the issue and how much it
 * matters, then in the position's own words what will be examined and why the
 * term is there, then the passages that state the standard — collapsed,
 * because they are the evidence rather than the point.
 *
 * Everything else a position can carry (tiers, ask, negotiation, the
 * deterministic check) belongs to the playbook editor, not to the minute
 * before a run starts.
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
  /** Omitted while the proposal is still being written: a position the model
   *  has not finished proposing is not one to edit, and an edit made against a
   *  list that is about to be handed to the run would be lost. */
  onChange?: ((position: Position) => void) | undefined;
  onRemove?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const passages =
    position.mode === "graded" && position.standard.source === "reference"
      ? position.standard.passages
      : null;
  // Only a graded position states why the term is negotiated; an extract
  // position captures a value and has no standard to be for or against.
  const purpose =
    position.mode === "graded" ? (position.purpose ?? null) : null;
  const guidance = position.guidance ?? null;

  return (
    <div
      className={cn(
        "bg-card rounded-lg border transition-opacity duration-150",
        !position.enabled && "opacity-60",
      )}
    >
      <PositionHeader
        actions={
          onChange === undefined ? null : (
            <>
              <Switch
                aria-label={t("knowledge.playbooks.enablePosition")}
                checked={position.enabled}
                className="shrink-0"
                onCheckedChange={(enabled) =>
                  onChange({ ...position, enabled })
                }
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
          )
        }
        index={index}
        label={
          position.mode === "graded" &&
          (onChange === undefined ? (
            <SeverityWord severity={position.severity} />
          ) : (
            <SeverityChip
              onChange={(severity) => onChange({ ...position, severity })}
              severity={position.severity}
            />
          ))
        }
        title={
          onChange === undefined ? (
            <BidiText as="span" className="font-medium">
              {position.issue}
            </BidiText>
          ) : (
            <Input
              aria-label={t("knowledge.playbooks.issueLabel")}
              className="hover:border-input focus-visible:bg-background h-8 w-full border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none"
              maxLength={256}
              onChange={(e) => onChange({ ...position, issue: e.target.value })}
              placeholder={t("knowledge.playbooks.issuePlaceholder")}
              value={position.issue}
            />
          )
        }
      />
      {(purpose !== null || guidance !== null || passages !== null) && (
        <div className="space-y-2 px-3 pb-3">
          {guidance !== null && (
            <PositionNote
              label={t("inspector.review.checks")}
              text={guidance}
            />
          )}
          {purpose !== null && (
            <PositionNote
              label={t("inspector.review.whyItMatters")}
              text={purpose}
            />
          )}
          {passages !== null && (
            <ReferencePassageList
              passages={passages}
              referenceNames={referenceNames}
            />
          )}
        </div>
      )}
    </div>
  );
};
