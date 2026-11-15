import { useRouter } from "expo-router";
import { View } from "react-native";
import { useFormatter } from "use-intl";

import { Button } from "@stll/ui/button";
import { Separator } from "@stll/ui/separator";
import { Text } from "@stll/ui/text";

import type { DecisionSummary } from "@/state/case-law";

/**
 * One decision, as the web's case-law grid lists it: its case number, then
 * court, date and kind, then the opening of its headnote. The date is the
 * day it was decided, never "2 days ago": Hermes cannot format relative
 * times. Tapping it opens the decision, or does what `onPress` says, as
 * search does to remember what found it.
 */
export const DecisionRow = ({
  decision,
  onPress,
}: {
  decision: DecisionSummary;
  onPress?: (() => void) | undefined;
}) => {
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
    <Button
      onPress={
        onPress ??
        (() => {
          router.push({
            pathname: "/law/[decisionId]",
            params: {
              decisionId: decision.id,
              caseNumber: decision.caseNumber,
            },
          });
        })
      }
      size="row"
      variant="ghost"
    >
      <Separator className="absolute inset-x-0 bottom-0" />
      <View className="flex-1 gap-1">
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
      </View>
    </Button>
  );
};
