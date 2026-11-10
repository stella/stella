import { useRef, useState } from "react";

import { panic } from "better-result";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  I18nManager,
  Pressable,
  View,
} from "react-native";
import type { GestureResponderEvent, ViewProps } from "react-native";

import { Text } from "@stll/ui/text";

import type { LucideIcon } from "@/icons.gen";
import {
  claimsSwipe,
  SWIPE_REVEAL_WIDTH,
  swipeOffset,
  swipeSettle,
} from "@/state/swipe";
import type { SwipeRest } from "@/state/swipe";
import { useUiColors } from "@/theme";

/** How long a row takes to settle once let go, unless motion is reduced. */
const SETTLE_MS = 180;

/** What swiping a row towards its trailing edge does. */
export type SwipeAction = {
  /** The action's name for assistive technology: stable, never translated. */
  readonly name: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
};

/** What the row's own pressable carries, so a screen reader offers the action. */
export type SwipeAccessibility = Required<
  Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction">
>;

/**
 * A list row that slides towards its trailing edge, as Mail's do, to show
 * `action`: a short swipe leaves it showing to tap, a full one runs it at
 * once. The row's own tap and hold still work, and a tap on a row standing
 * open closes it. The row's pressable spreads what `children` is handed, so
 * VoiceOver lists the action among the row's actions. Without an action,
 * such as while the last one saves, the row does not slide.
 */
export const SwipeRow = ({
  action,
  children,
}: {
  action: SwipeAction | null;
  children: (accessibility: SwipeAccessibility) => React.ReactNode;
}) => {
  const ui = useUiColors();
  const [offset] = useState(() => new Animated.Value(0));
  const [rest, setRest] = useState<SwipeRest>("closed");
  const [width, setWidth] = useState(0);
  // Offsets run from the leading edge; the screen's x axis runs from the
  // left, which is the trailing edge in a right-to-left language.
  const toScreen = I18nManager.isRTL ? -1 : 1;

  const settle = (to: SwipeRest) => {
    setRest(to);
    const target = toScreen * (to === "open" ? SWIPE_REVEAL_WIDTH : 0);
    const slide = (reduceMotion: boolean) => {
      Animated.timing(offset, {
        duration: reduceMotion ? 0 : SETTLE_MS,
        easing: Easing.out((progress) => Easing.cubic(progress)),
        toValue: target,
        useNativeDriver: true,
      }).start();
    };
    AccessibilityInfo.isReduceMotionEnabled()
      .then(slide)
      .catch(() => {
        slide(true);
      });
  };

  // Where the touch began and where it last moved, kept outside render:
  // the row may render again mid-swipe, and the swipe must carry on.
  const touch = useRef({ lastAt: 0, lastX: 0, startX: 0, startY: 0, vx: 0 });
  const travel = (pageX: number) =>
    swipeOffset({ dx: toScreen * (pageX - touch.current.startX), rest, width });

  const responder = {
    onMoveShouldSetResponderCapture: ({ nativeEvent }: GestureResponderEvent) =>
      action !== null &&
      claimsSwipe({
        dx: toScreen * (nativeEvent.pageX - touch.current.startX),
        dy: nativeEvent.pageY - touch.current.startY,
        rest,
      }),
    onResponderGrant: () => {
      offset.stopAnimation();
    },
    onResponderMove: ({ nativeEvent }: GestureResponderEvent) => {
      const { lastAt, lastX } = touch.current;
      const elapsed = nativeEvent.timestamp - lastAt;
      touch.current = {
        ...touch.current,
        lastAt: nativeEvent.timestamp,
        lastX: nativeEvent.pageX,
        vx: elapsed > 0 ? (nativeEvent.pageX - lastX) / elapsed : 0,
      };
      offset.setValue(toScreen * travel(nativeEvent.pageX));
    },
    onResponderRelease: ({ nativeEvent }: GestureResponderEvent) => {
      const outcome = swipeSettle({
        offset: travel(nativeEvent.pageX),
        velocity: toScreen * touch.current.vx,
        width,
      });
      switch (outcome) {
        case "run":
          action?.run();
          settle("closed");
          return;
        case "open":
          settle("open");
          return;
        case "close":
          settle("closed");
          return;
        default:
          outcome satisfies never;
          panic(`unknown swipe outcome ${String(outcome)}`);
      }
    },
    // Records the touch for the capture above; the row's content keeps it.
    onStartShouldSetResponderCapture: ({
      nativeEvent,
    }: GestureResponderEvent) => {
      touch.current = {
        lastAt: nativeEvent.timestamp,
        lastX: nativeEvent.pageX,
        startX: nativeEvent.pageX,
        startY: nativeEvent.pageY,
        vx: 0,
      };
      return false;
    },
    // The list scrolling away from under the finger closes the row.
    onResponderTerminate: () => {
      settle("closed");
    },
    onResponderTerminationRequest: () => false,
  };

  return (
    <View
      className="overflow-hidden"
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
      {...responder}
    >
      {action === null ? null : (
        // The row's pressable already offers the action to a screen reader.
        <View
          accessibilityElementsHidden
          className="bg-primary absolute inset-0 flex-row"
          importantForAccessibility="no-hide-descendants"
        >
          <Pressable
            accessible={false}
            className="items-center justify-center gap-1 px-2 active:opacity-70"
            onPress={() => {
              action.run();
              settle("closed");
            }}
            style={{ width: SWIPE_REVEAL_WIDTH }}
          >
            <action.icon color={ui.primaryForeground} size={20} />
            <Text
              className="text-primary-foreground text-center"
              numberOfLines={2}
              variant="label"
            >
              {action.label}
            </Text>
          </Pressable>
        </View>
      )}
      <Animated.View style={{ transform: [{ translateX: offset }] }}>
        <View className="bg-background">
          {children({
            accessibilityActions:
              action === null
                ? []
                : [{ label: action.label, name: action.name }],
            onAccessibilityAction: (event) => {
              if (
                action !== null &&
                event.nativeEvent.actionName === action.name
              ) {
                action.run();
                settle("closed");
              }
            },
          })}
        </View>
        {rest === "open" ? (
          <Pressable
            accessible={false}
            className="absolute inset-0"
            onPress={() => {
              settle("closed");
            }}
          />
        ) : null}
      </Animated.View>
    </View>
  );
};
