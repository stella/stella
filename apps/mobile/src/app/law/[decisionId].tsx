import { Suspense, useState } from "react";

import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useTranslations } from "use-intl";

import { DecisionReader } from "@/components/decision-reader";
import { screenStyles } from "@/components/empty-state-screen";
import { epochMilliseconds } from "@/connection/clock";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import { readDecision } from "@/state/case-law";
import type { Decision } from "@/state/case-law";
import { useAppColors } from "@/theme";

/**
 * One decision, opened from the Law tab, which passes its case number along
 * so the header names it before the text loads.
 */
const DecisionScreen = () => {
  const colors = useAppColors();
  const t = useTranslations("law");
  const { state } = useSession();
  const { caseNumber, decisionId } = useLocalSearchParams<{
    caseNumber?: string;
    decisionId: string;
  }>();
  const session = state.status === "signed-in" ? state.source.session() : null;
  const [load, setLoad] = useState<Promise<Load<Decision>> | null>(() =>
    session === null ? null : loadDecision(decisionId, session.serverUrl),
  );

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text },
          title: caseNumber ?? t("title"),
        }}
      />
      {load === null || session === null ? null : (
        <Suspense
          fallback={
            <ActivityIndicator className="flex-1" color={colors.muted} />
          }
        >
          <DecisionReader
            load={load}
            onReload={() => {
              setLoad(loadDecision(decisionId, session.serverUrl));
            }}
            webOrigin={new URL(session.tokenEndpoint).origin}
          />
        </Suspense>
      )}
    </View>
  );
};

export default DecisionScreen;

async function loadDecision(
  decisionId: string,
  serverUrl: string,
): Promise<Load<Decision>> {
  return {
    loadedAt: epochMilliseconds(),
    result: await readDecision({ decisionId, fetch, serverUrl }),
  };
}
