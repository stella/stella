import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFormatter, useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import {
  FIT_ZOOM,
  nextAppearance,
  ZOOM_STEPS,
  zoomedIn,
  zoomedOut,
} from "@/components/document-viewer/zoom";
import type { ViewerAppearance } from "@/components/document-viewer/zoom";
import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { useAppColors } from "@/theme";

/** The glyph that shows each appearance on its button. */
const APPEARANCE_GLYPHS = {
  system: "sun-moon",
  light: "sun",
  dark: "moon",
} as const satisfies Record<ViewerAppearance, string>;

/**
 * The bar floating over a document: − and + walk the zoom steps, the level
 * between them goes back to the fit, and the last button cycles the pages'
 * appearance between the app's, light and dark. A Liquid Glass capsule on
 * iOS 26, a bordered one elsewhere.
 */
export const ViewerControls = ({
  appearance,
  onAppearance,
  onZoom,
  zoom,
}: {
  appearance: ViewerAppearance;
  onAppearance: (appearance: ViewerAppearance) => void;
  onZoom: (zoom: number) => void;
  zoom: number;
}) => {
  const t = useTranslations("document");
  const format = useFormatter();
  const colors = useAppColors();
  const insets = useSafeAreaInsets();
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();

  const row = (
    <View style={styles.row}>
      <ControlButton
        disabled={zoom <= ZOOM_STEPS[0]}
        glyph="minus"
        label={t("zoomOut")}
        onPress={() => {
          onZoom(zoomedOut(zoom));
        }}
      />
      <Pressable
        accessibilityLabel={t("zoomFit")}
        accessibilityRole="button"
        className="active:opacity-60"
        hitSlop={4}
        onPress={() => {
          onZoom(FIT_ZOOM);
        }}
        style={styles.level}
      >
        <Text numberOfLines={1} variant="label">
          {zoom === FIT_ZOOM
            ? t("fit")
            : format.number(zoom, { style: "percent" })}
        </Text>
      </Pressable>
      <ControlButton
        disabled={zoom >= (ZOOM_STEPS.at(-1) ?? FIT_ZOOM)}
        glyph="plus"
        label={t("zoomIn")}
        onPress={() => {
          onZoom(zoomedIn(zoom));
        }}
      />
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <ControlButton
        glyph={APPEARANCE_GLYPHS[appearance]}
        label={t(`appearance.${appearance}`)}
        onPress={() => {
          onAppearance(nextAppearance(appearance));
        }}
      />
    </View>
  );

  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { bottom: insets.bottom + 12 }]}
    >
      {glass ? (
        <GlassView
          glassEffectStyle="regular"
          isInteractive
          style={styles.capsule}
        >
          {row}
        </GlassView>
      ) : (
        <View className="bg-card border-border border" style={styles.capsule}>
          {row}
        </View>
      )}
    </View>
  );
};

const ControlButton = ({
  disabled = false,
  glyph,
  label,
  onPress,
}: {
  disabled?: boolean;
  glyph: string;
  label: string;
  onPress: () => void;
}) => {
  const colors = useAppColors();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className="active:opacity-60"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled ? styles.disabled : null]}
    >
      <LucideGlyphs color={colors.text} name={glyph} size={20} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  dock: {
    alignItems: "center",
    left: 0,
    position: "absolute",
    right: 0,
  },
  capsule: {
    borderRadius: 24,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: 4,
  },
  button: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  disabled: {
    opacity: 0.35,
  },
  level: {
    alignItems: "center",
    minWidth: 56,
    paddingHorizontal: 4,
  },
  divider: {
    height: 20,
    marginHorizontal: 4,
    width: StyleSheet.hairlineWidth,
  },
});
