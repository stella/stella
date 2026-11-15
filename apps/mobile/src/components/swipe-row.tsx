import { useRef, useState } from "react";

import { panic } from "better-result";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  I18nManager,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import type { GestureResponderEvent, ViewProps } from "react-native";

import { Text } from "@stll/ui/text";

import type { LucideIcon } from "@/icons.gen";
import {
  claimsSwipe,
  restOffset,
  SWIPE_CLOSED,
  SWIPE_REVEAL_WIDTH,
  SWIPE_SIDE,
  swipeOffset,
  swipeSettle,
} from "@/state/swipe";
import type { SwipeRest, SwipeSide } from "@/state/swipe";
import { useUiColors } from "@/theme";

/** How long a row takes to settle once let go, unless motion is reduced. */
const SETTLE_MS = 180;

const SIDES = Object.values(SWIPE_SIDE);

/** What swiping a row to uncover one of its edges does. */
export type SwipeAction = {
  /** The action's name for assistive technology: stable, never translated. */
  readonly name: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
};

/**
 * A row's action at each edge, or null for none there: the leading one
 * shows as the row slides towards its trailing edge, as Mail's mark read
 * does, the trailing one as it slides the other way.
 */
export type SwipeActions = Readonly<Record<SwipeSide, SwipeAction | null>>;

/** What the row's own pressable carries, so a screen reader offers the actions. */
export type SwipeAccessibility = Required<
  Pick<ViewProps, "accessibilityActions" | "onAccessibilityAction">
>;

/**
 * A list row that slides sideways, as Mail's do, to show the action at the
 * edge it uncovers: a short swipe leaves it showing to tap, a full one runs
 * it at once. The row's own tap and hold still work, and a tap on a row
 * standing open closes it. The row's pressable spreads what `children` is
 * handed, so VoiceOver lists the actions among the row's actions. A side
 * without an action, such as while the last one saves, does not slide.
 */
export const SwipeRow = ({
  actions,
  children,
}: {
  actions: SwipeActions;
  children: (accessibility: SwipeAccessibility) => React.ReactNode;
}) => {
  const [offset] = useState(() => new Animated.Value(0));
  const [rest, setRest] = useState<SwipeRest>(SWIPE_CLOSED);
  const [width, setWidth] = useState(0);
  // Offsets run from the leading edge; the screen's x axis runs from the
  // left, which is the trailing edge in a right-to-left language.
  const toScreen = I18nManager.isRTL ? -1 : 1;
  const sides = SIDES.filter((side) => actions[side] !== null);
  const offered = SIDES.flatMap((side) => {
    const action = actions[side];
    return action === null ? [] : [action];
  });

  const settle = (to: SwipeRest) => {
    setRest(to);
    const target = toScreen * restOffset(to);
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
    swipeOffset({
      dx: toScreen * (pageX - touch.current.startX),
      rest,
      sides,
      width,
    });

  const responder = {
    onMoveShouldSetResponderCapture: ({ nativeEvent }: GestureResponderEvent) =>
      claimsSwipe({
        dx: toScreen * (nativeEvent.pageX - touch.current.startX),
        dy: nativeEvent.pageY - touch.current.startY,
        rest,
        sides,
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
      switch (outcome.type) {
        case "run":
          actions[outcome.side]?.run();
          settle(SWIPE_CLOSED);
          return;
        case "open":
          settle({ type: "open", side: outcome.side });
          return;
        case "close":
          settle(SWIPE_CLOSED);
          return;
        default:
          outcome satisfies never;
          panic("unknown swipe outcome");
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
      settle(SWIPE_CLOSED);
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
      {SIDES.map((side) => {
        const action = actions[side];
        return action === null ? null : (
          <ActionUnder
            action={action}
            key={side}
            offset={offset}
            onRun={() => {
              action.run();
              settle(SWIPE_CLOSED);
            }}
            side={side}
            toScreen={toScreen}
          />
        );
      })}
      <Animated.View style={{ transform: [{ translateX: offset }] }}>
        <View className="bg-background">
          {children({
            accessibilityActions: offered.map(({ label, name }) => ({
              label,
              name,
            })),
            onAccessibilityAction: (event) => {
              const action = offered.find(
                ({ name }) => name === event.nativeEvent.actionName,
              );
              if (action !== undefined) {
                action.run();
                settle(SWIPE_CLOSED);
              }
            },
          })}
        </View>
        {rest.type === "open" ? (
          <Pressable
            accessible={false}
            className="absolute inset-0"
            onPress={() => {
              settle(SWIPE_CLOSED);
            }}
          />
        ) : null}
      </Animated.View>
    </View>
  );
};

/**
 * One side's action under the row, at the edge the row uncovers. It shows
 * only while the row stands towards it, so a full swipe one way never
 * uncovers the other side's action. The row's pressable already offers it
 * to a screen reader.
 */
const ActionUnder = ({
  action,
  offset,
  onRun,
  side,
  toScreen,
}: {
  action: SwipeAction;
  /** Where the row stands, in screen points. */
  offset: Animated.Value;
  onRun: () => void;
  side: SwipeSide;
  /** 1 where the leading edge is the left one, -1 where it is the right. */
  toScreen: number;
}) => {
  const ui = useUiColors();
  // From the leading edge: the leading action shows on a positive offset.
  const opacity = Animated.multiply(offset, toScreen).interpolate(
    side === SWIPE_SIDE.leading
      ? { extrapolate: "clamp", inputRange: [0, 1], outputRange: [0, 1] }
      : { extrapolate: "clamp", inputRange: [-1, 0], outputRange: [1, 0] },
  );
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      <View
        className={`bg-primary flex-1 flex-row ${side === SWIPE_SIDE.leading ? "justify-start" : "justify-end"}`}
      >
        <Pressable
          accessible={false}
          className="items-center justify-center gap-1 px-2 active:opacity-70"
          onPress={onRun}
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
    </Animated.View>
  );
};
