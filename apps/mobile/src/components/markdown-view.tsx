import { Platform, StyleSheet, View } from "react-native";

import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";
import { Text } from "@stll/ui/text";

import { useOpenLink } from "@/components/open-link";
import { APP_VARIANT } from "@/env";
import { parseMarkdown } from "@/state/markdown";
import type { Block, Span } from "@/state/markdown";
import { useAppColors } from "@/theme";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

/** This build's own scheme, whose links open the app's screens. */
const APP_SCHEME = MOBILE_REDIRECT_SCHEMES[APP_VARIANT];

const Spans = ({ spans }: { spans: readonly Span[] }) => {
  const colors = useAppColors();
  const openLink = useOpenLink();
  return spans.map((span, index) => {
    const key = `${index}:${span.text}`;
    if (span.link !== undefined) {
      const { link } = span;
      return (
        <Text
          accessibilityRole="link"
          key={key}
          onPress={() => {
            openLink(link);
          }}
          style={[styles.link, { color: colors.accent }]}
        >
          {span.text}
        </Text>
      );
    }
    return (
      <Text
        key={key}
        style={[
          span.bold === true && styles.bold,
          span.italic === true && styles.italic,
          span.code === true && [
            styles.inlineCode,
            { backgroundColor: colors.background },
          ],
        ]}
      >
        {span.text}
      </Text>
    );
  });
};

const BlockView = ({ block }: { block: Block }) => {
  const colors = useAppColors();
  switch (block.type) {
    case "heading": {
      return (
        <Text
          accessibilityRole="header"
          style={[
            styles.text,
            { 1: styles.h1, 2: styles.h2, 3: styles.h3 }[block.level],
            { color: colors.text },
          ]}
        >
          <Spans spans={block.spans} />
        </Text>
      );
    }
    case "paragraph": {
      return (
        <Text selectable style={[styles.text, { color: colors.text }]}>
          <Spans spans={block.spans} />
        </Text>
      );
    }
    case "quote": {
      return (
        <View style={[styles.quote, { borderColor: colors.border }]}>
          <Text selectable style={[styles.text, { color: colors.muted }]}>
            <Spans spans={block.spans} />
          </Text>
        </View>
      );
    }
    case "list": {
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- list items have no identity but their position.
            <View key={index} style={styles.listItem}>
              <Text
                style={[styles.text, styles.marker, { color: colors.muted }]}
              >
                {block.ordered ? `${index + 1}.` : "•"}
              </Text>
              <Text
                selectable
                style={[styles.text, styles.itemText, { color: colors.text }]}
              >
                <Spans spans={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    }
    case "code": {
      break;
    }
  }
  return (
    <View
      style={[
        styles.codeBlock,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <Text selectable style={[styles.code, { color: colors.text }]}>
        {block.text}
      </Text>
    </View>
  );
};

/**
 * An assistant answer drawn from its markdown with plain Text views. Its
 * links open only web pages and this build's own screens.
 */
export const MarkdownView = ({ markdown }: { markdown: string }) => (
  <View style={styles.blocks}>
    {parseMarkdown(markdown, APP_SCHEME).map((block, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- blocks are re-parsed from the same text; position is their identity.
      <BlockView block={block} key={index} />
    ))}
  </View>
);

const styles = StyleSheet.create({
  blocks: {
    gap: 10,
  },
  bold: {
    fontFamily: "DMSans-Bold",
    fontWeight: "700",
  },
  code: {
    fontFamily: MONOSPACE,
    fontSize: 13,
    lineHeight: 19,
  },
  codeBlock: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
  },
  h1: {
    fontFamily: "DMSans-Bold",
    fontSize: 22,
    fontWeight: "700",
  },
  h2: {
    fontFamily: "DMSans-Bold",
    fontSize: 19,
    fontWeight: "700",
  },
  h3: {
    fontFamily: "DMSans-SemiBold",
    fontSize: 17,
    fontWeight: "600",
  },
  inlineCode: {
    fontFamily: MONOSPACE,
    fontSize: 14,
  },
  italic: {
    fontStyle: "italic",
  },
  itemText: {
    flex: 1,
  },
  link: {
    textDecorationLine: "underline",
  },
  list: {
    gap: 4,
  },
  listItem: {
    flexDirection: "row",
    gap: 8,
  },
  marker: {
    minWidth: 16,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: 12,
  },
  text: {
    // DM Sans, the web's typeface; each weight is its own embedded face.
    fontFamily: "DMSans-Regular",
    fontSize: 16,
    lineHeight: 23,
  },
});
