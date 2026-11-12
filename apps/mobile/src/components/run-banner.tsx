import { useEffect, useEffectEvent, useRef, useState } from "react";

import { panic } from "better-result";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import type { GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import { RunStateMark } from "@stll/ui/run-state-mark";
import type { RunMarkState } from "@stll/ui/run-state-mark";
import { Text } from "@stll/ui/text";

import { useActiveChatRuns } from "@/components/active-chat-runs";
import { useOpenThread, useThreadOnScreen } from "@/components/open-thread";
import { WindowOverlay } from "@/components/window-overlay";
import { RUN_BANNER_TYPE } from "@/state/run-banners";
import type { RunBanner } from "@/state/run-banners";

/** How long a banner stays before it goes on its own. */
const VISIBLE_MS = 5000;
/** How long a banner takes to come and go, unless motion is reduced. */
const SLIDE_MS = 220;
/** How far above its place a banner starts and ends. */
const SLIDE_DISTANCE = 24;
/** How far up a drag must go before it is a swipe, not a tap. */
const CLAIM_DISTANCE = 6;
/** How far up a swipe must carry the banner to put it away. */
const DISMISS_DISTANCE = 24;
const MAX_WIDTH = 480;
const GAP = 8;

/**
 * Brief news about the person's chat runs, over whatever screen is open,
 * one banner at a time: a chat that now waits on them, or a chat whose run
 * finished. The news comes from the reads the chats list shows, so it
 * costs no request of its own. News about the chat on screen is dropped.
 */
export const RunBanners = () => {
  const { banners, dismissBanner } = useActiveChatRuns();
  const onScreen = useThreadOnScreen();
  const openThread = useOpenThread();
  const untitled = useTranslations("chat")("untitled");
  const dropOnScreen = useEffectEvent((threadId: string) => {
    dismissBanner(threadId);
  });

  const newsOnScreen =
    onScreen !== undefined &&
    banners.some(({ threadId }) => threadId === onScreen);
  useEffect(() => {
    if (newsOnScreen) {
      dropOnScreen(onScreen);
    }
  }, [newsOnScreen, onScreen]);

  const shown = banners.find(({ threadId }) => threadId !== onScreen);
  if (shown === undefined) {
    return null;
  }
  const title = shown.threadTitle.trim() === "" ? untitled : shown.threadTitle;
  return (
    <WindowOverlay>
      <Banner
        bannerType={shown.type}
        // A new banner comes in afresh, never in the place of the last one.
        key={`${shown.type}:${shown.threadId}`}
        onDismiss={() => {
          dismissBanner(shown.threadId);
        }}
        onOpen={() => {
          dismissBanner(shown.threadId);
          openThread({
            matterId: shown.matterId,
            threadId: shown.threadId,
            title,
          });
        }}
        title={title}
      />
    </WindowOverlay>
  );
};

/** What a banner says, and the run mark beside it, if its news has one. */
const bannerContent = (
  bannerType: RunBanner["type"],
): {
  readonly heading: "runBanner.needsYou" | "runBanner.finished";
  readonly mark: RunMarkState | undefined;
} => {
  switch (bannerType) {
    case RUN_BANNER_TYPE.needsYou:
      return {
        heading: "runBanner.needsYou",
        mark: CHAT_ACTIVE_RUN_STATE.needsYou,
      };
    // The list of unfinished runs does not say how a run ended.
    case RUN_BANNER_TYPE.finished:
      return { heading: "runBanner.finished", mark: undefined };
    default:
      bannerType satisfies never;
      return panic("Unhandled run banner type");
  }
};

/**
 * One banner at the top of the screen. It slides down into place, or
 * fades in where motion is reduced, and VoiceOver reads it out. It goes
 * after a few seconds, when swiped up, or with VoiceOver's escape gesture
 * or dismiss action; a touch holds it until let go. Tapping it opens its
 * chat.
 */
const Banner = ({
  bannerType,
  onDismiss,
  onOpen,
  title,
}: {
  bannerType: RunBanner["type"];
  onDismiss: () => void;
  onOpen: () => void;
  /** The chat's title, never blank. */
  title: string;
}) => {
  const t = useTranslations("chat");
  const tabs = useTranslations("tabs");
  const insets = useSafeAreaInsets();
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  const { heading, mark } = bannerContent(bannerType);
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  const [motion, setMotion] = useState<"full" | "reduced">("reduced");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef({ startX: 0, startY: 0 });

  const glide = (value: Animated.Value, toValue: number) =>
    Animated.timing(value, {
      duration: SLIDE_MS,
      easing: Easing.out((at) => Easing.cubic(at)),
      toValue,
      useNativeDriver: true,
    });
  const leave = () => {
    clearTimeout(timer.current);
    glide(progress, 0).start(({ finished }) => {
      if (finished) {
        onDismiss();
      }
    });
  };
  const wait = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(leave, VISIBLE_MS);
  };
  const show = useEffectEvent((reduced: boolean) => {
    setMotion(reduced ? "reduced" : "full");
    glide(progress, 1).start();
    AccessibilityInfo.announceForAccessibility(`${t(heading)}\n${title}`);
    wait();
  });

  useEffect(() => {
    let live = true;
    const start = (reduced: boolean) => {
      if (live) {
        show(reduced);
      }
    };
    AccessibilityInfo.isReduceMotionEnabled()
      .then(start)
      .catch(() => {
        start(true);
      });
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, []);

  const settleBack = () => {
    glide(drag, 0).start();
    wait();
  };
  const lifted = (pageY: number) => Math.min(0, pageY - touch.current.startY);
  const responder = {
    // Records where a touch began and holds the banner; its press keeps the touch.
    onStartShouldSetResponderCapture: ({
      nativeEvent,
    }: GestureResponderEvent) => {
      touch.current = { startX: nativeEvent.pageX, startY: nativeEvent.pageY };
      clearTimeout(timer.current);
      return false;
    },
    onMoveShouldSetResponderCapture: ({
      nativeEvent,
    }: GestureResponderEvent) => {
      const dy = nativeEvent.pageY - touch.current.startY;
      const dx = nativeEvent.pageX - touch.current.startX;
      return dy < -CLAIM_DISTANCE && Math.abs(dy) > Math.abs(dx);
    },
    onResponderGrant: () => {
      clearTimeout(timer.current);
      drag.stopAnimation();
    },
    onResponderMove: ({ nativeEvent }: GestureResponderEvent) => {
      drag.setValue(lifted(nativeEvent.pageY));
    },
    onResponderRelease: ({ nativeEvent }: GestureResponderEvent) => {
      if (lifted(nativeEvent.pageY) < -DISMISS_DISTANCE) {
        leave();
        return;
      }
      settleBack();
    },
    onResponderTerminate: settleBack,
  };

  // Reduced motion keeps the banner in place and only fades it.
  const slide = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [motion === "full" ? -SLIDE_DISTANCE : 0, 0],
  });

  const content = (
    <Pressable
      accessibilityActions={[{ label: tabs("close"), name: "dismiss" }]}
      accessibilityHint={t("runBanner.openHint")}
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "dismiss") {
          leave();
        }
      }}
      onAccessibilityEscape={leave}
      onPress={() => {
        clearTimeout(timer.current);
        onOpen();
      }}
      onPressOut={wait}
    >
      {mark === undefined ? null : <RunStateMark state={mark} />}
      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {t(heading)}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {title}
        </Text>
      </View>
    </Pressable>
  );

  // The dock spans the width so the banner centres on a wide screen; only
  // the banner itself takes touches.
  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { top: insets.top + GAP }]}
    >
      <Animated.View
        {...responder}
        style={[
          styles.banner,
          {
            opacity: progress,
            transform: [{ translateY: Animated.add(slide, drag) }],
          },
        ]}
      >
        {glass ? (
          <GlassView
            glassEffectStyle="regular"
            isInteractive
            style={styles.card}
          >
            {content}
          </GlassView>
        ) : (
          <View className="bg-card border-border border" style={styles.card}>
            {content}
          </View>
        )}
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  dock: {
    alignItems: "center",
    left: 0,
    paddingHorizontal: GAP * 2,
    position: "absolute",
    right: 0,
  },
  banner: {
    maxWidth: MAX_WIDTH,
    width: "100%",
  },
  card: {
    borderRadius: 20,
    overflow: "hidden",
  },
});
