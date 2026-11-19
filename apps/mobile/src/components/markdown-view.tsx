import { use } from "react";

import { Platform, ScrollView, StyleSheet, View } from "react-native";

import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";
import { Text } from "@stll/ui/text";

import { keyedBy } from "@/components/keyed";
import { useOpenLink } from "@/components/open-link";
import { ThreadMatter } from "@/components/thread-matter";
import { useOpenReference } from "@/components/use-open-reference";
import { APP_VARIANT } from "@/env";
import type { ChatTextReference } from "@/state/chat-references";
import { parseMarkdown } from "@/state/markdown";
import type { Block, Span } from "@/state/markdown";
import { useAppColors } from "@/theme";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

/** This build's own scheme, whose links open the app's screens. */
const APP_SCHEME = MOBILE_REDIRECT_SCHEMES[APP_VARIANT];

/** A table column's width; a wide table scrolls sideways. */
const TABLE_COLUMN_WIDTH = 160;

/**
 * Chat text drawn from its markdown with plain Text views: an assistant's
 * answer (`answer`), or the person's own message in its bubble (`message`).
 * A mention or citation of a document, matter or decision is a chip with its
 * name that opens the app's own screen; other links open only web pages and
 * this build's own screens.
 */
export const MarkdownView = ({
  markdown,
  variant = "answer",
}: {
  markdown: string;
  variant?: "answer" | "message";
}) => {
  const matterId = use(ThreadMatter);
  return (
    <View style={variant === "answer" ? styles.blocks : styles.messageBlocks}>
      {parseMarkdown(markdown, { appScheme: APP_SCHEME, matterId }).map(
        (block, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- blocks are re-parsed from the same text; position is their identity.
          <BlockView block={block} key={index} variant={variant} />
        ),
      )}
    </View>
  );
};

const ReferenceChip = ({ reference }: { reference: ChatTextReference }) => {
  const colors = useAppColors();
  const open = useOpenReference(reference);
  return (
    <Text
      accessibilityRole={open === undefined ? "text" : "link"}
      onPress={open}
      style={[
        styles.chip,
        { backgroundColor: colors.background, color: colors.accent },
      ]}
    >
      {reference.label}
    </Text>
  );
};

const Spans = ({ spans }: { spans: readonly Span[] }) => {
  const colors = useAppColors();
  const openLink = useOpenLink();
  return spans.map((span, index) => {
    const key = `${index}:${span.text}`;
    if (span.reference !== undefined) {
      return <ReferenceChip key={key} reference={span.reference} />;
    }
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

/** A cell's words, which with its place among equal cells is its key. */
const spansText = (spans: readonly Span[]) =>
  spans.map((span) => span.text).join("");

const TableView = ({ block }: { block: Extract<Block, { type: "table" }> }) => {
  const colors = useAppColors();
  const row = (cells: readonly Span[][], header: boolean) =>
    keyedBy(cells, spansText).map(({ item: cell, key }) => (
      <View key={key} style={[styles.cell, { borderColor: colors.border }]}>
        <Text
          selectable
          style={[
            styles.cellText,
            header && styles.bold,
            { color: colors.text },
          ]}
        >
          <Spans spans={cell} />
        </Text>
      </View>
    ));
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.table, { borderColor: colors.border }]}
    >
      <View>
        <View style={[styles.row, { backgroundColor: colors.background }]}>
          {row(block.header, true)}
        </View>
        {keyedBy(block.rows, (cells) => cells.map(spansText).join("|")).map(
          ({ item: cells, key }) => (
            <View key={key} style={styles.row}>
              {row(cells, false)}
            </View>
          ),
        )}
      </View>
    </ScrollView>
  );
};

const BlockView = ({
  block,
  variant,
}: {
  block: Block;
  variant: "answer" | "message";
}) => {
  const colors = useAppColors();
  const text = variant === "answer" ? styles.text : styles.messageText;
  switch (block.type) {
    case "heading": {
      return (
        <Text
          accessibilityRole="header"
          style={[
            text,
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
        <Text selectable style={[text, { color: colors.text }]}>
          <Spans spans={block.spans} />
        </Text>
      );
    }
    case "quote": {
      return (
        <View style={[styles.quote, { borderColor: colors.border }]}>
          <Text selectable style={[text, { color: colors.muted }]}>
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
              <Text style={[text, styles.marker, { color: colors.muted }]}>
                {block.ordered ? `${index + 1}.` : "•"}
              </Text>
              <Text
                selectable
                style={[text, styles.itemText, { color: colors.text }]}
              >
                <Spans spans={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    }
    case "table": {
      return <TableView block={block} />;
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

const styles = StyleSheet.create({
  blocks: {
    gap: 10,
  },
  bold: {
    fontFamily: "DMSans-Bold",
    fontWeight: "700",
  },
  cell: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    width: TABLE_COLUMN_WIDTH,
  },
  cellText: {
    fontFamily: "DMSans-Regular",
    fontSize: 14,
    lineHeight: 20,
  },
  chip: {
    fontFamily: "DMSans-SemiBold",
    fontWeight: "600",
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
  messageBlocks: {
    gap: 6,
  },
  messageText: {
    fontFamily: "DMSans-Regular",
    fontSize: 15,
    lineHeight: 21,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: 12,
  },
  row: {
    flexDirection: "row",
  },
  table: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
  },
  text: {
    // DM Sans, the web's typeface; each weight is its own embedded face.
    fontFamily: "DMSans-Regular",
    fontSize: 16,
    lineHeight: 23,
  },
});
