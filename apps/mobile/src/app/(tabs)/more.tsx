import { useRouter } from "expo-router";
import type { Href } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Pressable, ScrollView, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { screenStyles } from "@/components/empty-state-screen";
import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { useScan } from "@/components/use-scan";
import { ChevronRightIcon } from "@/icons.gen";
import { canScan } from "@/native/document-scanner";
import { useAppColors, useUiColors } from "@/theme";

type Glyph = Parameters<typeof LucideGlyphs.getImageSource>[0];

type MoreRow = {
  readonly label: string;
  readonly glyph: Glyph;
  /** The tile's colour, one of the web's option colour pairs. */
  readonly tile: "Amber" | "Blue" | "Gray" | "Purple" | "Teal";
  /** Where the row goes, or what it does. */
  readonly href: Href | (() => void);
};

/**
 * Everything beyond the three tabs, as GitHub's app lists its sections: a
 * coloured tile, the name and a chevron, in grouped cards. Case law, your
 * timers and the settings open from here, and a device with the document
 * camera scans paper into a matter.
 */
const MoreScreen = () => {
  const t = useTranslations();
  const colors = useAppColors();
  const scan = useScan();
  const headerHeight = useHeaderHeight();
  // Inside a tab the bottom inset includes the tab bar.
  const { bottom } = useSafeAreaInsets();

  const groups: readonly (readonly MoreRow[])[] = [
    [
      {
        glyph: "book-open",
        href: "/law",
        label: t("tabs.law"),
        tile: "Blue",
      },
      {
        glyph: "timer",
        href: "/timers",
        label: t("more.timers"),
        tile: "Amber",
      },
      ...(canScan()
        ? [
            {
              glyph: "scan-text",
              href: scan,
              label: t("scan.title"),
              tile: "Teal",
            } as const,
          ]
        : []),
    ],
    [
      {
        glyph: "cog",
        href: "/settings",
        label: t("tabs.settings"),
        tile: "Gray",
      },
    ],
  ];

  return (
    // Left and right: an iPhone Duo docks the tab bar as a rail at the side.
    <SafeAreaView
      edges={["left", "right"]}
      style={{ backgroundColor: colors.background, flex: 1 }}
    >
      <ScrollView
        alwaysBounceVertical={false}
        // The tab turns the system's automatic insets off (see the tab
        // layout), so the list clears the translucent header and the tab bar
        // itself. Left to the system, a list too short to scroll kept its
        // first offset and sat under the header.
        contentContainerStyle={[
          screenStyles.content,
          {
            paddingBottom: bottom + screenStyles.content.padding,
            paddingTop: headerHeight + screenStyles.content.paddingTop,
          },
        ]}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ bottom, top: headerHeight }}
      >
        {groups.map((rows) => (
          <View
            className="border-border bg-card overflow-hidden rounded-2xl border"
            key={rows[0]?.label}
          >
            {rows.map((row, index) => (
              <MoreRowView
                key={row.label}
                last={index === rows.length - 1}
                row={row}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
};

export default MoreScreen;

const MoreRowView = ({ last, row }: { last: boolean; row: MoreRow }) => {
  const router = useRouter();
  const colors = useAppColors();
  const ui = useUiColors();
  const { href } = row;

  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 pl-4 active:opacity-60"
      onPress={() => {
        if (typeof href === "function") {
          href();
        } else {
          router.push(href);
        }
      }}
    >
      <View
        className="size-8 items-center justify-center rounded-lg"
        style={{ backgroundColor: ui[`option${row.tile}Bg`] }}
      >
        <LucideGlyphs
          color={ui[`option${row.tile}Fg`]}
          name={row.glyph}
          size={18}
        />
      </View>
      <View
        className={`min-h-12 flex-1 flex-row items-center gap-2 py-3 pr-4 ${last ? "" : "border-border border-b"}`}
      >
        <Text className="flex-1" variant="rowTitle">
          {row.label}
        </Text>
        <ChevronRightIcon color={colors.muted} size={18} />
      </View>
    </Pressable>
  );
};
