import { use } from "react";

import { Result } from "better-result";
import { Stack } from "expo-router";
import {
  Linking,
  Platform,
  Share,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import DecisionText from "@/components/decision-text.dom";
import { screenStyles } from "@/components/empty-state-screen";
import { LoadFailedCard } from "@/components/load-failure";
import { barGlyph } from "@/components/ui/bar-glyph";
import type { Load } from "@/state/api-request";
import type { Decision } from "@/state/case-law";
import { decisionPage, isWebUrl } from "@/state/decision-page";
import { linkShareContent } from "@/state/share-content";

/**
 * A decision as the web's reader sets it: court, kind, date and ECLI, the
 * headnote, then the text in the reader's serif. The page is a web view
 * (./decision-text.dom.tsx), so any stretch of it selects, across
 * paragraphs, with the system's Copy, Look Up, Translate and Share; the
 * screen's header and its share button stay native, and the app opens the
 * links the page hands it.
 */
export const DecisionReader = ({
  load,
  onReload,
  webOrigin,
}: {
  load: Promise<Load<Decision>>;
  onReload: () => void;
  /** The web app's origin, which the decision's shared link names. */
  webOrigin: string;
}) => {
  const t = useTranslations("law");
  const format = useFormatter();
  const scheme = useColorScheme();
  const { fontScale } = useWindowDimensions();
  const { result } = use(load);

  if (Result.isError(result)) {
    return (
      <View className="flex-1 p-4">
        <LoadFailedCard
          error={result.error}
          onRetry={onReload}
          retryLabel={t("retry")}
          title={t("loadFailed")}
        />
      </View>
    );
  }
  const decision = result.value;

  return (
    <>
      <ShareButton url={`${webOrigin}${decision.webPath}`} />
      <DecisionText
        appearance={scheme === "dark" ? "dark" : "light"}
        dom={{ style: screenStyles.screen }}
        onLink={(href) => {
          if (isWebUrl(href)) {
            void Linking.openURL(href);
          }
        }}
        page={decisionPage({
          decision,
          decided:
            decision.decisionDate === null
              ? null
              : format.dateTime(new Date(decision.decisionDate), {
                  dateStyle: "long",
                  timeZone: "UTC",
                }),
          labels: {
            headnote: t("headnote"),
            openSource: t("openSource"),
            textUnavailable: t("textUnavailable"),
          },
        })}
        textScale={fontScale}
      />
    </>
  );
};

/** The header's share button, which hands on the decision's web page. */
const ShareButton = ({ url }: { url: string }) => {
  const t = useTranslations("law");
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button
        onPress={() => {
          void Share.share(linkShareContent(url, Platform.OS));
        }}
      >
        {barGlyph("share")}
        <Stack.Toolbar.Label>{t("share")}</Stack.Toolbar.Label>
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  );
};
