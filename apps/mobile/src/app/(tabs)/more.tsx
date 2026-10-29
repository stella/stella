import { useRouter } from "expo-router";
import type { Href } from "expo-router";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
  /** Where the row goes, or what it does; none while it is still to come. */
  readonly href: Href | (() => void) | null;
};

/**
 * Everything beyond the three tabs, as GitHub's app lists its sections: a
 * coloured tile, the name and a chevron, in grouped cards. Case law, your
 * timers and the settings open from here, and a device with the document
 * camera scans paper into a matter; voice input is on its way.
 */
const MoreScreen = () => {
  const t = useTranslations();
  const colors = useAppColors();
  const scan = useScan();

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
      {
        glyph: "mic",
        href: null,
        label: t("more.voiceInput"),
        tile: "Purple",
      },
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
        contentContainerStyle={screenStyles.content}
        // The header is the platform's translucent bar; the list scrolls under it.
        contentInsetAdjustmentBehavior="automatic"
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
  const t = useTranslations("more");
  const router = useRouter();
  const colors = useAppColors();
  const ui = useUiColors();
  const { href } = row;

  return (
    <Button
      disabled={href === null}
      onPress={() => {
        if (typeof href === "function") {
          href();
        } else if (href !== null) {
          router.push(href);
        }
      }}
      size="row"
      variant="ghost"
    >
      <View className="flex-1 flex-row items-center gap-3 pl-4">
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
          {href === null ? (
            <Text variant="caption">{t("soon")}</Text>
          ) : (
            <ChevronRightIcon color={colors.muted} size={18} />
          )}
        </View>
      </View>
    </Button>
  );
};
