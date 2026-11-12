import { Suspense, use, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import {
  Stack,
  useLocalSearchParams,
  usePreventRemove,
  useRouter,
} from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { CheckIcon } from "@/icons.gen";
import { discardShare, readShare, sweepShares } from "@/native/share-inbox";
import { readFileProperty, uploadDocument } from "@/state/document-upload";
import { readLocalFile } from "@/state/local-file";
import { listMatters } from "@/state/matters";
import { shareDestinations, sharedFiles } from "@/state/shared-items";
import type {
  ShareDestination,
  SharedItem,
  SharedItemsError,
} from "@/state/shared-items";
import { useAppColors, useUiColors } from "@/theme";

/**
 * What another app shared through the share extension: its files, links
 * and text, to save into a matter as documents or to start a conversation
 * with. The share's folder in the App Group is deleted once it is saved, or
 * as the sheet closes; a conversation takes it over and deletes it once its
 * files are read.
 */
const ShareScreen = () => {
  const { state } = useSession();
  const { shareId } = useLocalSearchParams<{ shareId: string }>();
  return state.status === "signed-in" ? (
    <ShareLoader key={shareId} shareId={shareId} source={state.source} />
  ) : null;
};

const ShareLoader = ({
  shareId,
  source,
}: {
  shareId: string;
  source: AccessTokenSource;
}) => {
  const colors = useAppColors();
  const [share] = useState(async () => {
    // Best effort: the extension deletes stale shares too, as it writes one.
    sweepShares({ keep: shareId, now: epochMilliseconds() }).unwrapOr(
      undefined,
    );
    return await readShare(shareId);
  });
  return (
    <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
      <LoadedShare share={share} shareId={shareId} source={source} />
    </Suspense>
  );
};

const LoadedShare = ({
  share,
  shareId,
  source,
}: {
  share: Promise<Result<readonly SharedItem[], SharedItemsError>>;
  shareId: string;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("share");
  const tabs = useTranslations("tabs");
  const router = useRouter();
  const result = use(share);

  if (Result.isError(result)) {
    return (
      <View className="bg-background flex-1" style={screenStyles.content}>
        <Stack.Screen options={{ title: t("title") }} />
        <EmptyCard description={t("unavailable")} title={t("unavailableTitle")}>
          <Button
            onPress={() => {
              router.back();
            }}
            variant="outline"
          >
            {tabs("close")}
          </Button>
        </EmptyCard>
      </View>
    );
  }
  return <ShareSheet items={result.value} shareId={shareId} source={source} />;
};

/** How many of the share's files are in which matter, so a retry sends only the rest. */
type Uploaded = { readonly matterId: string; readonly count: number };

const ShareSheet = ({
  items,
  shareId,
  source,
}: {
  items: readonly SharedItem[];
  shareId: string;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("share");
  const tabs = useTranslations("tabs");
  const scan = useTranslations("scan");
  const chat = useTranslations("chat");
  const matterT = useTranslations("matter");
  const colors = useAppColors();
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  const destinations = shareDestinations(items);
  const files = sharedFiles(items);
  const [destination, setDestination] = useState(destinations[0]);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [uploading, startUploading] = useTransition();
  const [matters] = useState(async () => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });
  // How the sheet is left: a conversation takes the share over; saved,
  // closed or swiped away, the share is deleted.
  const outcome = useRef<"open" | "saved" | "chat">("open");
  const [leaving, setLeaving] = useState(false);

  // Every way out comes here; an upload in progress keeps the sheet up
  // until it is done.
  usePreventRemove(!leaving, ({ repeat }) => {
    if (outcome.current === "open" && uploading) {
      return;
    }
    if (outcome.current !== "chat") {
      // Best effort: what is left is deleted within the hour by the next
      // share or the next time this screen opens.
      discardShare(shareId).unwrapOr(undefined);
    }
    setLeaving(true);
    repeat();
  });

  const startChat = () => {
    outcome.current = "chat";
    router.replace({
      pathname: "/thread/[threadId]",
      params: {
        fresh: "1",
        shareId,
        threadId: randomUUID(),
        title: chat("newChat"),
      },
    });
  };

  const save = (target: string) => {
    startUploading(async () => {
      setFailure(null);
      const from = uploaded?.matterId === target ? uploaded.count : 0;
      const propertyId = await readFileProperty({
        fetch,
        matterId: target,
        source,
      });
      if (Result.isError(propertyId)) {
        if (propertyId.error._tag === "SignedOutError") {
          end(source);
          return;
        }
        setFailure(writeFailure(propertyId.error));
        return;
      }
      for (const [index, file] of files.entries()) {
        if (index < from) {
          continue;
        }
        const read = await readLocalFile(fetch, file.uri);
        if (Result.isError(read)) {
          setFailure({ kind: "failed", detail: undefined });
          return;
        }
        const sent = await uploadDocument({
          fetch,
          file: { mimeType: file.mimeType, uri: file.uri, ...read.value },
          matterId: target,
          name: file.name,
          propertyId: propertyId.value,
          source,
        });
        if (Result.isError(sent)) {
          if (sent.error._tag === "SignedOutError") {
            end(source);
            return;
          }
          setFailure(writeFailure(sent.error));
          return;
        }
        setUploaded({ matterId: target, count: index + 1 });
      }
      changed("documents");
      outcome.current = "saved";
      router.replace({
        pathname: "/matter/[workspaceId]",
        params: { workspaceId: target },
      });
    });
  };

  const done =
    matterId !== null && uploaded?.matterId === matterId ? uploaded.count : 0;
  const choices = {
    matter: scan("saveTitle"),
    chat: chat("newChat"),
  } as const satisfies Record<ShareDestination, string>;

  return (
    <>
      <Stack.Screen
        options={{
          // An upload in progress keeps the sheet up until it is done.
          gestureEnabled: !uploading,
          title: t("title"),
          unstable_headerLeftItems: () => [
            {
              disabled: uploading,
              label: tabs("close"),
              onPress: () => {
                router.back();
              },
              type: "button",
            },
          ],
          unstable_headerRightItems: () => [
            destination === "chat"
              ? {
                  label: t("start"),
                  onPress: startChat,
                  type: "button",
                  variant: "done",
                }
              : {
                  disabled: matterId === null || uploading,
                  label: scan("upload"),
                  onPress: () => {
                    if (matterId !== null) {
                      save(matterId);
                    }
                  },
                  type: "button",
                  variant: "done",
                },
          ],
        }}
      />
      <ScrollView
        alwaysBounceVertical={false}
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <SharedItemList items={items} />
        {destinations.length > 1 ? (
          <View className="border-border bg-card rounded-xl border px-3">
            {destinations.map((choice, index) => (
              <ChoiceRow
                key={choice}
                label={choices[choice]}
                last={index === destinations.length - 1}
                onPress={() => {
                  setDestination(choice);
                }}
                selected={choice === destination}
              />
            ))}
          </View>
        ) : null}
        {destination === "matter" ? (
          <>
            {files.length < items.length ? (
              <Text className="px-1" variant="caption">
                {t("filesOnly")}
              </Text>
            ) : null}
            {uploading ? (
              <View className="flex-row items-center gap-2 px-1">
                <ActivityIndicator color={colors.muted} />
                <Text variant="caption">
                  {t("uploading", {
                    done: Math.min(done + 1, files.length),
                    total: files.length,
                  })}
                </Text>
              </View>
            ) : null}
            <WriteFailureNotice
              failure={failure}
              message={matterT("uploadFailed")}
            />
            <View className="gap-2">
              <View className="px-1">
                <Text variant="section">{scan("matterTitle")}</Text>
              </View>
              <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
                <MatterPicker
                  matters={matters}
                  onSelect={setMatterId}
                  selected={matterId}
                />
              </Suspense>
            </View>
          </>
        ) : null}
      </ScrollView>
    </>
  );
};

/** The shared items as the share sheet lists them: each file's name, each link, each text's opening lines. */
const SharedItemList = ({ items }: { items: readonly SharedItem[] }) => (
  <View className="border-border bg-card rounded-xl border px-3">
    {items.map((item, index) => (
      <View
        className={`py-3 ${index === items.length - 1 ? "" : "border-border border-b"}`}
        key={item.id}
      >
        {item.type === "file" ? (
          <Text numberOfLines={2} variant="rowTitle">
            {item.name}
          </Text>
        ) : (
          <Text numberOfLines={3} variant="caption">
            {item.type === "link" ? item.url : item.text}
          </Text>
        )}
      </View>
    ))}
  </View>
);

const ChoiceRow = ({
  label,
  last,
  onPress,
  selected,
}: {
  label: string;
  last: boolean;
  onPress: () => void;
  selected: boolean;
}) => {
  const ui = useUiColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      className={`active:bg-accent flex-row items-center gap-3 py-3 ${
        last ? "" : "border-border border-b"
      }`}
      onPress={onPress}
    >
      <View className="flex-1">
        <Text numberOfLines={1} variant="rowTitle">
          {label}
        </Text>
      </View>
      {selected ? <CheckIcon color={ui.foreground} size={18} /> : null}
    </Pressable>
  );
};

export default ShareScreen;
