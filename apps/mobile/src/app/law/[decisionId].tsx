import { Suspense, useState } from "react";

import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Loader } from "@stll/ui/loader";

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
      {session === null ? null : (
        <LoadedDecision
          decisionId={decisionId}
          serverUrl={session.serverUrl}
          webOrigin={new URL(session.tokenEndpoint).origin}
        />
      )}
    </View>
  );
};

/** The decision's text, loaded on opening and again on a pull to reload. */
const LoadedDecision = ({
  decisionId,
  serverUrl,
  webOrigin,
}: {
  decisionId: string;
  serverUrl: string;
  webOrigin: string;
}) => {
  const [load, setLoad] = useState(
    async () => await loadDecision(decisionId, serverUrl),
  );
  return (
    <Suspense fallback={<Loader className="flex-1" />}>
      <DecisionReader
        load={load}
        onReload={() => {
          setLoad(loadDecision(decisionId, serverUrl));
        }}
        webOrigin={webOrigin}
      />
    </Suspense>
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
