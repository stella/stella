import { useState } from "react";

import { panic } from "better-result";
import { StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import { PROCESS_SUMMARY_KINDS } from "@stll/api-contract/chat-tool-activity";
import type { ProcessSummaryKind } from "@stll/api-contract/chat-tool-activity";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { keyedBy } from "@/components/keyed";
import { useLocalRunSubtitleText } from "@/components/local-run-subtitle";
import { StepContentView } from "@/components/step-content";
import { ChevronDownIcon, ChevronRightIcon } from "@/icons.gen";
import type { AnswerBlock, AnswerStep } from "@/state/chat-answer";
import { useAppColors } from "@/theme";

/** The phrase each kind of work is counted in, as the web counts it. */
const SUMMARY_KEYS = {
  research: "processSummary.sourcesChecked",
  artifact: "processSummary.documentEdits",
  mutation: "processSummary.changesSaved",
  computation: "processSummary.analyses",
} as const satisfies Record<ProcessSummaryKind, string>;

/**
 * A run of the steps an answer took, as the web shows it: one line that
 * says what the run got done ("3 sources checked · 2 analyses"), or, while
 * the run is still going, the step it is on. Tapping it lists each step by
 * its title.
 */
export const AnswerSteps = ({
  block,
  live,
}: {
  block: Extract<AnswerBlock, { type: "steps" }>;
  /** The run is the answer's last and still receiving steps. */
  live: boolean;
}) => {
  const t = useTranslations("chat");
  const colors = useAppColors();
  const stepTitle = useStepTitle();
  const [open, setOpen] = useState(false);
  const current = block.steps.at(-1);
  // Settled, the run says what it got done; a run of reasoning alone, or of
  // steps that did not land, counts its steps instead.
  const work =
    PROCESS_SUMMARY_KINDS.flatMap((kind) => {
      const count = block.work.get(kind) ?? 0;
      return count > 0 ? [t(SUMMARY_KEYS[kind], { count })] : [];
    }).join(" · ") || t("stepCount", { count: block.steps.length });
  const summary = live && current !== undefined ? stepTitle(current) : work;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <View style={styles.run}>
      <Button
        accessibilityState={{ expanded: open }}
        className="max-w-full"
        hitSlop={6}
        onPress={() => {
          setOpen((shown) => !shown);
        }}
        variant="plain"
      >
        <View
          style={[
            styles.summary,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Chevron color={colors.muted} size={14} />
          <Text
            numberOfLines={1}
            style={[styles.label, { color: colors.muted }]}
          >
            {summary}
          </Text>
        </View>
      </Button>
      {open ? <StepList steps={block.steps} /> : null}
    </View>
  );
};

/** The words a subagent's status reads in; a finished one says nothing. */
const SUBAGENT_STATUS_KEYS = {
  needs_approval: "localRun.status.needs_approval",
  running: "localRun.status.running",
  failed: "localRun.status.failed",
  interrupted: "localRun.status.interrupted",
  done: null,
} as const satisfies Record<
  Extract<AnswerBlock, { type: "subagent" }>["status"],
  string | null
>;

/**
 * A subagent a coding agent started on the person's computer, as the web's
 * card shows it: what it was started for, the kind of agent, how many steps
 * it took and its one status, with its own conversation, once it ended, and
 * the steps it took inside. It is open while the subagent works and folded
 * once it settles, until the person taps it; from then on it stays as they
 * left it.
 */
export const AnswerSubagent = ({
  block,
}: {
  block: Extract<AnswerBlock, { type: "subagent" }>;
}) => {
  const t = useTranslations("chat");
  const colors = useAppColors();
  const [chosen, setChosen] = useState<"open" | "closed" | null>(null);
  const hasSteps = block.steps.length > 0;
  const opens = hasSteps || block.conversationCallId !== null;
  const working =
    block.status === "running" || block.status === "needs_approval";
  const open = opens && (chosen === null ? working : chosen === "open");
  const statusKey = SUBAGENT_STATUS_KEYS[block.status];
  const facts = [
    block.agentType,
    block.stepCount === 0 ? null : t("stepCount", { count: block.stepCount }),
    statusKey === null ? null : t(statusKey),
  ].filter((fact) => fact !== null);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const header = (
    <>
      {opens ? <Chevron color={colors.muted} size={14} /> : null}
      <View style={styles.subagentText}>
        <Text numberOfLines={1} style={[styles.label, { color: colors.text }]}>
          {t("localRun.title.subagent")}
        </Text>
        {block.description === null ? null : (
          <Text
            numberOfLines={2}
            style={[styles.detail, { color: colors.muted }]}
          >
            {block.description}
          </Text>
        )}
        {facts.length === 0 ? null : (
          <Text
            numberOfLines={1}
            style={[styles.detail, { color: colors.muted }]}
          >
            {facts.join(" · ")}
          </Text>
        )}
      </View>
    </>
  );
  const frame = [
    styles.subagent,
    { backgroundColor: colors.card, borderColor: colors.border },
  ];

  return (
    <View style={styles.run}>
      {opens ? (
        <Button
          accessibilityState={{ expanded: open }}
          className="self-stretch"
          hitSlop={6}
          onPress={() => {
            setChosen(open ? "closed" : "open");
          }}
          variant="plain"
        >
          <View style={frame}>{header}</View>
        </Button>
      ) : (
        <View style={frame}>{header}</View>
      )}
      {/* Read from stella only once the person opens it. */}
      {open && block.conversationCallId !== null ? (
        <StepContentView
          callId={block.conversationCallId}
          name={block.description ?? ""}
        />
      ) : null}
      {open && hasSteps ? <StepList steps={block.steps} /> : null}
    </View>
  );
};

/**
 * A step's title: a coding agent's own step by its kind, any other by its
 * tool's title.
 */
const useStepTitle = () => {
  const t = useTranslations("chat");
  return (step: AnswerStep): string => {
    switch (step.type) {
      case "reasoning":
        return t("reasoning");
      case "tool":
        return t(`tool.${step.label}`);
      case "local":
        return step.titleKind === null
          ? t(`tool.${step.label}`)
          : t(`localRun.title.${step.titleKind}`);
      default:
        step satisfies never;
        return panic("Unhandled answer step");
    }
  };
};

/** Each step by its title, with what it was about under it. */
const StepList = ({ steps }: { steps: readonly AnswerStep[] }) => {
  const colors = useAppColors();
  const stepTitle = useStepTitle();

  return (
    <View style={[styles.steps, { borderColor: colors.border }]}>
      {keyedBy(steps, stepTitle).map(({ item: step, key }) => (
        <StepRow key={key} step={step} title={stepTitle(step)} />
      ))}
    </View>
  );
};

/**
 * One step: its title and what it was about. A coding agent's settled step
 * that produced something (a command's output, a diff, an image) opens
 * onto it, as its row does on the web.
 */
const StepRow = ({ step, title }: { step: AnswerStep; title: string }) => {
  const colors = useAppColors();
  const localRunSubtitleText = useLocalRunSubtitleText();
  const [open, setOpen] = useState(false);
  const about = (): string | null => {
    switch (step.type) {
      case "reasoning":
        return step.text === "" ? null : step.text;
      case "tool":
        return null;
      case "local":
        // A subagent started inside another names what it was started for.
        return localRunSubtitleText(step.subtitle);
      default:
        step satisfies never;
        return panic("Unhandled answer step");
    }
  };
  const detail = about();
  const contentCallId = step.type === "local" ? step.contentCallId : null;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const label = (
    <Text
      style={[
        styles.label,
        {
          color:
            step.type !== "reasoning" && step.status === "failed"
              ? colors.muted
              : colors.text,
        },
      ]}
    >
      {title}
    </Text>
  );

  return (
    <View style={styles.step}>
      {contentCallId === null ? (
        label
      ) : (
        <Button
          accessibilityState={{ expanded: open }}
          hitSlop={6}
          onPress={() => {
            setOpen((shown) => !shown);
          }}
          size="inline"
          variant="link"
        >
          {label}
          <Chevron color={colors.muted} size={14} />
        </Button>
      )}
      {detail === null || detail === "" ? null : (
        <Text selectable style={[styles.detail, { color: colors.muted }]}>
          {detail}
        </Text>
      )}
      {open && contentCallId !== null ? (
        <StepContentView callId={contentCallId} name={detail ?? ""} />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  label: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "500",
  },
  detail: {
    fontSize: 13,
    lineHeight: 18,
  },
  run: {
    alignItems: "flex-start",
    gap: 6,
  },
  step: {
    gap: 2,
  },
  steps: {
    alignSelf: "stretch",
    borderLeftWidth: 2,
    gap: 8,
    marginLeft: 8,
    paddingLeft: 12,
  },
  subagent: {
    alignItems: "flex-start",
    alignSelf: "stretch",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  subagentText: {
    flexShrink: 1,
    gap: 2,
  },
  summary: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    maxWidth: "100%",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
