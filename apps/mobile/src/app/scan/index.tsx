import { useState } from "react";

import { Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFormatter, useTranslations } from "use-intl";

import { screenStyles } from "@/components/empty-state-screen";
import { ScanPageList } from "@/components/scan-page-list";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";
import { barGlyph } from "@/components/ui/bar-glyph";
import { epochMilliseconds } from "@/connection/clock";
import { buildPdf, discardScans, scanPages } from "@/native/document-scanner";
import {
  decodeScannedPages,
  movePage,
  pdfName,
  removePage,
  reviewPages,
  rotatePage,
  sizeInUnits,
  totalSize,
} from "@/state/scan-pages";
import type { ReviewPage } from "@/state/scan-pages";
import { useAppColors } from "@/theme";

/**
 * The pages a scan captured, to look over before they go anywhere, laid out
 * as TurboScan lays its review: the document's name with its page count and
 * the day it was scanned, then the pages in order, each one to remove, turn
 * or drag to another place, and under them a button to scan more pages and
 * the size the PDF will be. Share hands the PDF to the system's share sheet
 * (AirDrop, Mail, Files); Save puts it into a matter.
 */
const ScanReviewScreen = () => {
  const t = useTranslations("scan");
  const tabs = useTranslations("tabs");
  const format = useFormatter();
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ matterId?: string; pages?: string }>();
  const [scannedAt] = useState(epochMilliseconds);
  const day = format.dateTime(scannedAt, { dateStyle: "medium" });
  const [pages, setPages] = useState<readonly ReviewPage[]>(() =>
    reviewPages(decodeScannedPages(params.pages)),
  );
  const [defaultName] = useState(() =>
    t("defaultName", {
      day: format.dateTime(scannedAt, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    }),
  );
  const [name, setName] = useState(defaultName);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** What the screen waits for: the camera, or the PDF being bound. */
  const [busy, setBusy] = useState<"pdf" | "scan" | null>(null);
  const insets = useSafeAreaInsets();
  const size = sizeInUnits(totalSize(pages));
  const documentName = pdfName(name, defaultName);
  const ready = pages.length > 0 && busy === null;

  /** The pages bound into a PDF as they stand now, or why they could not be. */
  const pdf = async () => {
    setFailure(null);
    setArmed(null);
    setBusy("pdf");
    const built = await buildPdf(
      documentName,
      pages.map(({ rotation, uri }) => ({ rotation, uri })),
    );
    setBusy(null);
    if (Result.isError(built)) {
      setFailure(t("pdfFailed"));
    }
    return built;
  };

  const share = () => {
    void (async () => {
      const built = await pdf();
      if (Result.isError(built)) {
        return;
      }
      const shared = await Result.tryPromise(
        async () => await Share.share({ url: built.value.uri }),
      );
      if (Result.isError(shared)) {
        setFailure(t("shareFailed"));
      }
    })();
  };

  const save = () => {
    void (async () => {
      const built = await pdf();
      if (Result.isError(built)) {
        return;
      }
      router.push({
        pathname: "/scan/save",
        params: {
          name: documentName,
          pageCount: String(built.value.pageCount),
          sha256Hex: built.value.sha256Hex,
          size: String(built.value.size),
          uri: built.value.uri,
          ...(params.matterId === undefined
            ? {}
            : { matterId: params.matterId }),
        },
      });
    })();
  };

  const addPages = () => {
    setArmed(null);
    setBusy("scan");
    void (async () => {
      const scanned = await scanPages();
      setBusy(null);
      if (Result.isError(scanned)) {
        Alert.alert(t("failedTitle"), t("failed"));
        return;
      }
      if (scanned.value !== null) {
        const added = reviewPages(scanned.value);
        setPages((current) => [...current, ...added]);
      }
    })();
  };

  const close = () => {
    const leave = () => {
      discardScans();
      router.back();
    };
    if (pages.length === 0) {
      leave();
      return;
    }
    Alert.alert(t("discardTitle"), t("discardMessage"), [
      { style: "cancel", text: t("keepEditing") },
      { onPress: leave, style: "destructive", text: t("discard") },
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={close}>
          {barGlyph("x")}
          <Stack.Toolbar.Label>{tabs("close")}</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button disabled={!ready} onPress={share}>
          {barGlyph("share")}
          <Stack.Toolbar.Label>{t("share")}</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button disabled={!ready} onPress={save} variant="done">
          <Stack.Toolbar.Label>{t("save")}</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View className="bg-background flex-1">
        <ScrollView
          contentContainerStyle={screenStyles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!dragging}
        >
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <Input
                accessibilityLabel={t("name")}
                className="flex-1"
                onChangeText={setName}
                placeholder={t("name")}
                returnKeyType="done"
                value={name}
              />
              <View
                accessibilityLabel={t("pages", { count: pages.length })}
                accessible
                className="bg-secondary min-w-7 items-center rounded-full px-2 py-0.5"
              >
                <Text variant="label">{format.number(pages.length)}</Text>
              </View>
            </View>
            <View className="px-1">
              <Text variant="caption">{day}</Text>
            </View>
          </View>
          {busy === null ? null : <ActivityIndicator color={colors.muted} />}
          {failure === null ? null : <Text variant="error">{failure}</Text>}
          {pages.length === 0 ? (
            <View className="items-center py-6">
              <Text className="text-center" variant="caption">
                {t("noPages")}
              </Text>
            </View>
          ) : (
            <ScanPageList
              armed={armed}
              onArm={setArmed}
              onDragging={setDragging}
              onMove={(from, to) => {
                setPages((current) => movePage(current, from, to));
              }}
              onRemove={(key) => {
                setArmed(null);
                setPages((current) => removePage(current, key));
              }}
              onRotate={(key) => {
                setPages((current) => rotatePage(current, key));
              }}
              pages={pages}
            />
          )}
        </ScrollView>
        <View
          className="border-border bg-background flex-row items-center justify-between gap-3 border-t px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <Button
            disabled={busy !== null}
            onPress={addPages}
            size="sm"
            variant="outline"
          >
            {t("addPages")}
          </Button>
          <Text variant="caption">
            {t(size.unit, { size: format.number(size.value) })}
          </Text>
        </View>
      </View>
    </>
  );
};

export default ScanReviewScreen;
