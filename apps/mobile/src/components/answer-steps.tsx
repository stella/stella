import { useState } from "react";

import { Pressable, StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import { PROCESS_SUMMARY_KINDS } from "@stll/api-contract/chat-tool-activity";
import type { ProcessSummaryKind } from "@stll/api-contract/chat-tool-activity";
import { Text } from "@stll/ui/text";

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
  const [open, setOpen] = useState(false);
  const title = (step: AnswerStep) =>
    step.type === "reasoning" ? t("reasoning") : t(`tool.${step.label}`);
  const current = block.steps.at(-1);
  // Settled, the run says what it got done; a run of reasoning alone, or of
  // steps that did not land, counts its steps instead.
  const work =
    PROCESS_SUMMARY_KINDS.flatMap((kind) => {
      const count = block.work.get(kind) ?? 0;
      return count > 0 ? [t(SUMMARY_KEYS[kind], { count })] : [];
    }).join(" · ") || t("stepCount", { count: block.steps.length });
  const summary = live && current !== undefined ? title(current) : work;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <View style={styles.run}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={() => {
          setOpen((shown) => !shown);
        }}
        style={[
          styles.summary,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Chevron color={colors.muted} size={14} />
        <Text numberOfLines={1} style={[styles.label, { color: colors.muted }]}>
          {summary}
        </Text>
      </Pressable>
      {open ? (
        <View style={[styles.steps, { borderColor: colors.border }]}>
          {block.steps.map((step, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- the same step can run twice in one answer.
            <View key={index} style={styles.step}>
              <Text
                style={[
                  styles.label,
                  {
                    color:
                      step.type === "tool" && step.status === "failed"
                        ? colors.muted
                        : colors.text,
                  },
                ]}
              >
                {title(step)}
              </Text>
              {step.type === "reasoning" && step.text !== "" ? (
                <Text
                  numberOfLines={6}
                  selectable
                  style={[styles.reasoning, { color: colors.muted }]}
                >
                  {step.text}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
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
  reasoning: {
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
