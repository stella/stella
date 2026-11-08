import { useLayoutEffect, useRef, useState } from "react";

import { Animated, Image, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { GripVerticalIcon, MinusIcon, RotateCwIcon } from "@/icons.gen";
import { dropIndex, rowShift } from "@/state/scan-pages";
import type { ReviewPage } from "@/state/scan-pages";
import { useUiColors } from "@/theme";
import { UI_COLORS } from "@/ui-theme.gen";

/** Every row is this tall, so a drag can tell which row it is over by distance alone. */
const ROW_HEIGHT = 104;
/** The thumbnail's square: a page turned a quarter still fits inside it. */
const THUMBNAIL_SIDE = 88;

type Drag = { readonly from: number; readonly to: number };

/**
 * A scan's pages, numbered, as iOS lists rows being edited: a red minus to
 * remove a page, which asks once more with a Delete button, the page itself,
 * a button that turns it a quarter clockwise and a handle to drag it to
 * another place. VoiceOver moves a page with the row's actions instead.
 */
export const ScanPageList = ({
  armed,
  onArm,
  onDragging,
  onMove,
  onRemove,
  onRotate,
  pages,
}: {
  /** The page whose Delete button shows, if any. */
  armed: string | null;
  onArm: (key: string | null) => void;
  /** Whether a page is being dragged, so the screen holds its scrolling still. */
  onDragging: (dragging: boolean) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (key: string) => void;
  onRotate: (key: string) => void;
  pages: readonly ReviewPage[];
}) => {
  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as the gesture last left it, read by the next gesture event
  // before React has rendered the last one.
  const current = useRef<Drag | null>(null);
  const [offset] = useState(() => new Animated.Value(0));

  // The dragged row drops into its new place in the same render that ends
  // the drag; its offset goes after that render, so it never flashes back
  // to where it started.
  useLayoutEffect(() => {
    if (drag === null) {
      offset.setValue(0);
    }
  }, [drag, offset]);

  const begin = (from: number) => {
    current.current = { from, to: from };
    offset.setValue(0);
    setDrag(current.current);
    onArm(null);
    onDragging(true);
  };
  const move = (dy: number) => {
    const started = current.current;
    if (started === null) {
      return;
    }
    offset.setValue(dy);
    const to = dropIndex({
      count: pages.length,
      dy,
      from: started.from,
      rowHeight: ROW_HEIGHT,
    });
    if (to !== started.to) {
      current.current = { from: started.from, to };
      setDrag(current.current);
    }
  };
  const end = () => {
    const finished = current.current;
    current.current = null;
    setDrag(null);
    onDragging(false);
    if (finished !== null && finished.to !== finished.from) {
      onMove(finished.from, finished.to);
    }
  };

  return (
    <View>
      {pages.map((page, index) => (
        <ScanPageRow
          armed={armed === page.key}
          count={pages.length}
          dragged={drag?.from === index}
          dragging={drag !== null}
          index={index}
          key={page.key}
          offset={offset}
          onArm={onArm}
          onDragBegin={begin}
          onDragEnd={end}
          onDragMove={move}
          onMove={onMove}
          onRemove={onRemove}
          onRotate={onRotate}
          page={page}
          shift={rowShift({ drag, index, rowHeight: ROW_HEIGHT })}
        />
      ))}
    </View>
  );
};

const ScanPageRow = ({
  armed,
  count,
  dragged,
  dragging,
  index,
  offset,
  onArm,
  onDragBegin,
  onDragEnd,
  onDragMove,
  onMove,
  onRemove,
  onRotate,
  page,
  shift,
}: {
  armed: boolean;
  count: number;
  dragged: boolean;
  /** Whether any row is being dragged. */
  dragging: boolean;
  index: number;
  offset: Animated.Value;
  onArm: (key: string | null) => void;
  onDragBegin: (from: number) => void;
  onDragEnd: () => void;
  onDragMove: (dy: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (key: string) => void;
  onRotate: (key: string) => void;
  page: ReviewPage;
  shift: number;
}) => {
  const t = useTranslations("scan");
  const ui = useUiColors();
  const number = index + 1;
  const shifted = useShift(shift, dragging);
  // Where the finger touched the handle; a drag is measured from there.
  const touchedAt = useRef(0);

  // VoiceOver cannot drag; the row's actions move, turn and remove a page.
  const actions = [
    ...(index > 0
      ? [
          {
            label: t("moveUp"),
            name: "moveUp",
            run: () => {
              onMove(index, index - 1);
            },
          },
        ]
      : []),
    ...(index < count - 1
      ? [
          {
            label: t("moveDown"),
            name: "moveDown",
            run: () => {
              onMove(index, index + 1);
            },
          },
        ]
      : []),
    {
      label: t("rotatePage", { number }),
      name: "rotate",
      run: () => {
        onRotate(page.key);
      },
    },
    {
      label: t("removePage", { number }),
      name: "remove",
      run: () => {
        onRemove(page.key);
      },
    },
  ];

  return (
    <Animated.View
      style={{
        height: ROW_HEIGHT,
        transform: [{ translateY: dragged ? offset : shifted }],
        zIndex: dragged ? 1 : 0,
      }}
    >
      <View
        className={`border-border h-full flex-row items-center gap-3 border-b ${dragged ? "bg-card" : "bg-background"}`}
      >
        <Pressable
          accessibilityLabel={t("removePage", { number })}
          accessibilityRole="button"
          className="size-11 items-center justify-center"
          onPress={() => {
            onArm(armed ? null : page.key);
          }}
        >
          <View
            className="bg-destructive size-6 items-center justify-center rounded-full"
            style={{ transform: [{ rotate: armed ? "90deg" : "0deg" }] }}
          >
            <MinusIcon color={UI_COLORS.light.background} size={16} />
          </View>
        </Pressable>
        <View
          accessibilityActions={actions.map(({ label, name }) => ({
            label,
            name,
          }))}
          accessibilityLabel={t("page", { number })}
          accessible
          className="flex-1 flex-row items-center gap-3"
          onAccessibilityAction={(event) => {
            actions
              .find((action) => action.name === event.nativeEvent.actionName)
              ?.run();
          }}
        >
          <Text className="w-6 text-center" variant="caption">
            {String(number)}
          </Text>
          <View
            className="bg-muted items-center justify-center rounded-md"
            style={{ height: THUMBNAIL_SIDE, width: THUMBNAIL_SIDE }}
          >
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri: page.thumbnailUri }}
              style={{
                height: THUMBNAIL_SIDE,
                transform: [{ rotate: `${page.rotation}deg` }],
                width: THUMBNAIL_SIDE,
              }}
            />
          </View>
        </View>
        {armed ? (
          <Button
            className="mr-2"
            onPress={() => {
              onRemove(page.key);
            }}
            size="sm"
            variant="destructive"
          >
            {t("deletePage")}
          </Button>
        ) : (
          <>
            <Pressable
              accessibilityLabel={t("rotatePage", { number })}
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-lg active:opacity-60"
              onPress={() => {
                onRotate(page.key);
              }}
            >
              <RotateCwIcon color={ui.foreground} size={20} />
            </Pressable>
            <View
              accessibilityLabel={t("movePage", { number })}
              className="size-11 items-center justify-center"
              // The handle answers the touch itself, from its start, and
              // keeps it: holding a page, the list must not take it to scroll.
              onMoveShouldSetResponderCapture={() => true}
              onResponderGrant={(event) => {
                touchedAt.current = event.nativeEvent.pageY;
                onDragBegin(index);
              }}
              onResponderMove={(event) => {
                onDragMove(event.nativeEvent.pageY - touchedAt.current);
              }}
              onResponderRelease={onDragEnd}
              onResponderTerminate={onDragEnd}
              onResponderTerminationRequest={() => false}
              onStartShouldSetResponder={() => true}
              onStartShouldSetResponderCapture={() => true}
            >
              <GripVerticalIcon color={ui.mutedForeground} size={22} />
            </View>
          </>
        )}
      </View>
    </Animated.View>
  );
};

/**
 * A row's offset while another is dragged past it, eased rather than
 * jumped. Once the drag ends the rows take their new places in the list, so
 * the offset goes at once, before the frame is drawn.
 */
function useShift(shift: number, dragging: boolean): Animated.Value {
  const [value] = useState(() => new Animated.Value(shift));
  useLayoutEffect(() => {
    if (dragging) {
      Animated.timing(value, {
        duration: 160,
        toValue: shift,
        useNativeDriver: false,
      }).start();
    } else {
      value.setValue(shift);
    }
  }, [dragging, shift, value]);
  return value;
}
