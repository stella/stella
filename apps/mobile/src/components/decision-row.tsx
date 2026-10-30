import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter } from "use-intl";

import { Text } from "@/components/ui/text";
import type { DecisionSummary } from "@/state/case-law";

/**
 * One decision, as the web's case-law grid lists it: its case number, then
 * court, date and kind, then the opening of its headnote. The date is the
 * day it was decided, never "2 days ago": Hermes cannot format relative
 * times. Tapping it opens the decision.
 */
export const DecisionRow = ({ decision }: { decision: DecisionSummary }) => {
  const format = useFormatter();
  const router = useRouter();
  const decided =
    decision.decisionDate === null
      ? null
      : format.dateTime(new Date(decision.decisionDate), {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
          year: "numeric",
        });
  const details = [decision.court, decided, decision.decisionType].filter(
    (detail): detail is string => detail !== null && detail !== "",
  );

  return (
    <Pressable
      accessibilityRole="button"
      className="border-border active:bg-accent gap-1 border-b py-3"
      onPress={() => {
        router.push({
          pathname: "/law/[decisionId]",
          params: { decisionId: decision.id, caseNumber: decision.caseNumber },
        });
      }}
    >
      <Text numberOfLines={1} variant="rowTitle">
        {decision.caseNumber}
      </Text>
      <Text numberOfLines={1} variant="caption">
        {details.join(" · ")}
      </Text>
      {decision.preview === null ? null : (
        <View className="pt-0.5">
          <Text numberOfLines={3} variant="caption">
            {decision.preview}
          </Text>
        </View>
      )}
    </Pressable>
  );
};
