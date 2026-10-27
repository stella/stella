import { use } from "react";

import { panic, Result } from "better-result";
import { Stack } from "expo-router";
import { FlatList, Linking, Share, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { RetryButton } from "@/components/retry-button";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import type { TextVariant } from "@/components/ui/text";
import { useGlyphImage } from "@/components/ui/use-glyph-image";
import type { Load } from "@/state/api-request";
import type { Decision } from "@/state/case-law";
import { plainTextBlocks, readerBlocks } from "@/state/decision-document";
import type { ReaderBlock, ReaderRun } from "@/state/decision-document";

/** Points a list level or a quotation is set in from the margin. */
const INDENT = 16;

/**
 * A decision as the web's reader sets it: court, kind, date and ECLI, the
 * headnote, then the text in the reader's serif, every block selectable.
 * Long texts stay smooth because only the blocks on screen are drawn.
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
  const { result } = use(load);

  if (Result.isError(result)) {
    return (
      <View className="flex-1 p-4">
        <EmptyCard description={t("loadFailed")} title={t("unavailable")}>
          <RetryButton label={t("retry")} onPress={onReload} />
        </EmptyCard>
      </View>
    );
  }
  const decision = result.value;
  const blocks =
    decision.blocks === null
      ? plainTextBlocks(decision.fulltext ?? "")
      : readerBlocks(decision.blocks);

  return (
    <>
      <ShareButton url={`${webOrigin}${decision.webPath}`} />
      <FlatList
        contentContainerStyle={screenStyles.content}
        data={blocks}
        initialNumToRender={12}
        keyExtractor={(block) => block.id}
        ListEmptyComponent={
          <View className="gap-3 pt-6">
            <Text variant="caption">{t("textUnavailable")}</Text>
            {decision.sourceUrl === null ? null : (
              <OpenSourceButton url={decision.sourceUrl} />
            )}
          </View>
        }
        ListFooterComponent={
          blocks.length === 0 || decision.sourceUrl === null ? null : (
            <View className="border-border mt-6 border-t pt-3">
              <OpenSourceButton url={decision.sourceUrl} />
            </View>
          )
        }
        ListHeaderComponent={<DecisionHeader decision={decision} />}
        renderItem={({ item }) => <ReaderBlockView block={item} />}
      />
    </>
  );
};

/** The header's share button, which hands on the decision's web page. */
const ShareButton = ({ url }: { url: string }) => {
  const t = useTranslations("law");
  const glyph = useGlyphImage("share");
  return (
    <Stack.Screen
      options={{
        unstable_headerRightItems: () =>
          glyph === null
            ? []
            : [
                {
                  icon: { source: glyph, type: "image" as const },
                  label: t("share"),
                  onPress: () => {
                    void Share.share({ message: url, url });
                  },
                  type: "button" as const,
                },
              ],
      }}
    />
  );
};

/** What the decision is, then its headnote, as the web reader opens. */
const DecisionHeader = ({ decision }: { decision: Decision }) => {
  const t = useTranslations("law");
  const format = useFormatter();
  const decided =
    decision.decisionDate === null
      ? null
      : format.dateTime(new Date(decision.decisionDate), {
          dateStyle: "long",
          timeZone: "UTC",
        });
  const details = [decision.court, decision.decisionType, decided].filter(
    (detail): detail is string => detail !== null && detail !== "",
  );

  return (
    <View className="gap-4 pb-5">
      <View className="gap-1">
        <Text accessibilityRole="header" selectable variant="title">
          {decision.caseNumber}
        </Text>
        <Text selectable variant="caption">
          {details.join(" · ")}
        </Text>
        {decision.ecli === null ? null : (
          <Text selectable variant="caption">
            {decision.ecli}
          </Text>
        )}
      </View>
      {decision.headnote === null ? null : (
        <View className="border-border bg-card gap-2 rounded-xl border p-4">
          <Text variant="section">{t("headnote")}</Text>
          <Text selectable variant="reading">
            {decision.headnote}
          </Text>
        </View>
      )}
    </View>
  );
};

const ReaderBlockView = ({ block }: { block: ReaderBlock }) => {
  switch (block.kind) {
    case "heading":
      return (
        <View className={block.level <= 2 ? "pt-6 pb-2" : "pt-4 pb-1"}>
          <Text accessibilityRole="header" selectable variant="headline">
            {block.runs.map((run) => run.text).join("")}
          </Text>
        </View>
      );
    case "paragraph":
      return (
        <View
          className="pb-4"
          style={{
            paddingStart: (block.depth + (block.quote ? 1 : 0)) * INDENT,
          }}
        >
          <Text selectable variant="reading">
            {block.number === null ? null : (
              <Text variant="readingStrong">{`${block.number}. `}</Text>
            )}
            {block.runs.map((run) => (
              <Text key={run.id} variant={runVariant(run)}>
                {run.text}
              </Text>
            ))}
          </Text>
        </View>
      );
    case "table":
      return (
        <View className="border-border mb-4 rounded-lg border">
          {block.rows.map((row) => (
            <View
              className={`flex-row gap-3 px-3 py-2 ${row === block.rows[0] ? "" : "border-border border-t"}`}
              key={row.id}
            >
              {row.cells.map((cell) => (
                <View className="flex-1" key={cell.id}>
                  <Text selectable variant="caption">
                    {cell.text}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    default:
      block satisfies never;
      return panic("Unhandled reader block");
  }
};

const OpenSourceButton = ({ url }: { url: string }) => {
  const t = useTranslations("law");
  return (
    <Button
      className="self-start"
      label={t("openSource")}
      onPress={() => {
        void Linking.openURL(url);
      }}
      size="sm"
      variant="outline"
    />
  );
};

/** The reading face of a run's emphasis. */
function runVariant(run: ReaderRun): TextVariant {
  if (run.strong) {
    return run.emphasis ? "readingStrongEmphasis" : "readingStrong";
  }
  return run.emphasis ? "readingEmphasis" : "reading";
}
