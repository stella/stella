import { startTransition, Suspense, use, useState } from "react";

import { panic, Result } from "better-result";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { resolveReferenceEdit } from "@stll/api-contract/matter-reference-edit";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { ContactPicker } from "@/components/contact-picker";
import { screenStyles } from "@/components/empty-state-screen";
import { LoadFailedCard } from "@/components/load-failure";
import { MatterParties } from "@/components/matter-parties";
import { MatterTeam, SectionTitle } from "@/components/matter-team";
import { useMatterWrite } from "@/components/use-matter-write";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import type { ContactChoice } from "@/state/contacts";
import {
  archiveMatter,
  deleteMatter,
  duplicateMatter,
  readMatter,
  unarchiveMatter,
  updateMatter,
} from "@/state/matter-detail";
import type { MatterDetail } from "@/state/matter-detail";
import { useAppColors } from "@/theme";

type DetailLoad = Promise<Result<MatterDetail, ApiError>>;

/**
 * A matter's details, as the web's matter info sheet keeps them: its name
 * and number, its client, lead, members and parties, and what can be done
 * with the whole matter: copy it, archive or restore it, or delete it.
 */
const MatterInfoScreen = () => {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const t = useTranslations("matterInfo");
  const { state } = useSession();
  return (
    <>
      <Stack.Screen options={{ title: t("title") }} />
      {state.status === "signed-in" ? (
        <MatterInfo matterId={workspaceId} source={state.source} />
      ) : null}
    </>
  );
};

const MatterInfo = ({
  matterId,
  source,
}: {
  matterId: string;
  source: AccessTokenSource;
}) => {
  const colors = useAppColors();
  const load = async () => await readMatter({ fetch, matterId, source });
  const [detail, setDetail] = useState<DetailLoad>(load);
  return (
    <ScrollView
      alwaysBounceVertical={false}
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
        <LoadedMatterInfo
          detail={detail}
          matterId={matterId}
          reload={() => {
            // Kept on screen while the fresh load arrives.
            startTransition(() => {
              setDetail(load());
            });
          }}
          source={source}
        />
      </Suspense>
    </ScrollView>
  );
};

const LoadedMatterInfo = ({
  detail,
  matterId,
  reload,
  source,
}: {
  detail: DetailLoad;
  matterId: string;
  reload: () => void;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const { end } = useSession();
  const loaded = use(detail);
  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return (
      <LoadFailedCard
        error={loaded.error}
        onRetry={reload}
        retryLabel={t("retry")}
        title={t("loadFailed")}
      />
    );
  }
  const matter = loaded.value;
  const archived = matter.status === "archived";
  return (
    <>
      {archived ? (
        <View className="px-1">
          <Text variant="caption">{t("archivedNotice")}</Text>
        </View>
      ) : null}
      <MatterFields
        archived={archived}
        // A fresh load starts the fields from what it read.
        key={JSON.stringify([matter.name, matter.reference])}
        matter={matter}
        reload={reload}
        source={source}
      />
      <MatterClient
        archived={archived}
        matter={matter}
        reload={reload}
        source={source}
      />
      {/* Keyed by status, so archiving or restoring loads them afresh. */}
      <MatterTeam
        disabled={archived}
        key={`team-${matter.status}`}
        leadUserId={matter.leadUserId ?? null}
        matterId={matterId}
        onChanged={reload}
        source={source}
      />
      <MatterParties
        disabled={archived}
        key={`parties-${matter.status}`}
        matterId={matterId}
        source={source}
      />
      <MatterActions matter={matter} reload={reload} source={source} />
    </>
  );
};

/** The matter's name and number, each saved when its field is left. */
const MatterFields = ({
  archived,
  matter,
  reload,
  source,
}: {
  archived: boolean;
  matter: MatterDetail;
  reload: () => void;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const { failure, saving, write } = useMatterWrite(source);
  const [name, setName] = useState(matter.name);
  const [reference, setReference] = useState(matter.reference);
  const disabled = archived || saving;

  const saveName = () => {
    const next = name.trim();
    if (next === "" || next === matter.name) {
      setName(matter.name);
      return;
    }
    write(
      async () =>
        await updateMatter({
          change: { type: "name", value: next },
          fetch,
          matterId: matter.id,
          source,
        }),
      reload,
    );
  };

  const saveReference = (value: string) => {
    write(
      async () =>
        await updateMatter({
          change: { type: "reference", value },
          fetch,
          matterId: matter.id,
          source,
        }),
      reload,
    );
  };

  const leaveReference = () => {
    const edit = resolveReferenceEdit({
      currentReference: matter.reference,
      nextReference: reference,
      stampedVersionCount: matter.stampedVersionCount,
    });
    switch (edit.type) {
      case "discard":
        setReference(matter.reference);
        return;
      case "save":
        saveReference(edit.reference);
        return;
      case "confirm":
        Alert.alert(
          t("referenceChangeTitle"),
          t("referenceChangeMessage", {
            count: matter.stampedVersionCount,
            newReference: edit.reference,
            oldReference: matter.reference,
          }),
          [
            {
              onPress: () => {
                setReference(matter.reference);
              },
              style: "cancel",
              text: t("cancel"),
            },
            {
              onPress: () => {
                saveReference(edit.reference);
              },
              text: t("change"),
            },
          ],
        );
        return;
      default:
        edit satisfies never;
        panic(`Unhandled reference edit: ${String(edit)}`);
    }
  };

  return (
    <View className="gap-2">
      <SectionTitle title={t("name")} />
      <Input
        accessibilityLabel={t("name")}
        disabled={disabled}
        onChangeText={setName}
        onEndEditing={saveName}
        returnKeyType="done"
        value={name}
      />
      <SectionTitle title={t("number")} />
      <Input
        accessibilityLabel={t("number")}
        autoCapitalize="characters"
        autoCorrect={false}
        disabled={disabled}
        onChangeText={setReference}
        onEndEditing={leaveReference}
        returnKeyType="done"
        value={reference}
      />
      <View className="px-1">
        <Text variant="caption">
          {t("numberHint", { example: `${reference.trim()}/001` })}
        </Text>
      </View>
      <WriteFailureNotice failure={failure} message={t("saveFailed")} />
    </View>
  );
};

/**
 * Who the matter is for. A personal matter is given a client once, which
 * shares it with the team for good, so that asks first; a client matter's
 * client is replaced only if no one changed it meanwhile.
 */
const MatterClient = ({
  archived,
  matter,
  reload,
  source,
}: {
  archived: boolean;
  matter: MatterDetail;
  reload: () => void;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const { failure, saving, write } = useMatterWrite(source);
  const [choosing, setChoosing] = useState(false);
  // A client being added to the address book is not chosen yet.
  const [addingContact, setAddingContact] = useState(false);
  const current = matter.client ?? null;
  const clientAction = current === null ? t("setClient") : t("changeClient");

  const assign = (contact: ContactChoice) => {
    write(
      async () =>
        await updateMatter({
          change: {
            expectedClientId: current?.id ?? null,
            type: "clientId",
            value: contact.id,
          },
          fetch,
          matterId: matter.id,
          source,
        }),
      () => {
        setChoosing(false);
        reload();
      },
    );
  };

  const pick = (contact: ContactChoice | null) => {
    if (contact === null || contact.id === current?.id) {
      return;
    }
    if (current !== null) {
      assign(contact);
      return;
    }
    Alert.alert(
      t("promoteTitle"),
      t("promoteMessage", {
        clientName: contact.displayName,
        matterName: matter.name,
      }),
      [
        { style: "cancel", text: t("cancel") },
        {
          onPress: () => {
            assign(contact);
          },
          text: t("promote"),
        },
      ],
    );
  };

  return (
    <View className="gap-2">
      <SectionTitle title={t("client")} />
      <View className="border-border bg-card min-h-11 flex-row items-center gap-3 rounded-xl border px-3 py-2">
        <Text className="flex-1" numberOfLines={2} variant="rowTitle">
          {current?.displayName ?? t("personal")}
        </Text>
        {archived ? null : (
          <Button
            disabled={saving || addingContact}
            onPress={() => {
              setChoosing((open) => !open);
            }}
            size="sm"
            variant="outline"
          >
            {choosing ? t("done") : clientAction}
          </Button>
        )}
      </View>
      {current === null ? (
        <View className="px-1">
          <Text variant="caption">{t("personalDescription")}</Text>
        </View>
      ) : null}
      {choosing ? (
        <ContactPicker
          clearLabel={t("changeClient")}
          disabled={saving}
          onAddingChange={setAddingContact}
          onSelect={pick}
          selected={null}
          source={source}
        />
      ) : null}
      <WriteFailureNotice failure={failure} message={t("saveFailed")} />
    </View>
  );
};

/**
 * What can be done with the whole matter, as the web's matter info offers
 * it: a copy with or without its content, archiving or restoring it, and
 * deleting it once its name is typed to confirm.
 */
const MatterActions = ({
  matter,
  reload,
  source,
}: {
  matter: MatterDetail;
  reload: () => void;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const router = useRouter();
  const { failure, saving, write } = useMatterWrite(source);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const archived = matter.status === "archived";
  const request = { fetch, matterId: matter.id, source };

  const duplicate = (includeContent: boolean) => {
    Alert.alert(
      t("duplicateTitle"),
      includeContent ? t("duplicateWithContentMessage") : t("duplicateMessage"),
      [
        { style: "cancel", text: t("cancel") },
        {
          onPress: () => {
            write(
              async (): Promise<
                Result<{ id: string; name: string | undefined }, ApiError>
              > => {
                const copied = await duplicateMatter({
                  ...request,
                  includeContent,
                });
                if (Result.isError(copied)) {
                  return Result.err(copied.error);
                }
                // The copy exists once the duplicate answers; its name is
                // only for the title, so a failed read still opens it.
                const copy = await readMatter({
                  fetch,
                  matterId: copied.value,
                  source,
                });
                return Result.ok({
                  id: copied.value,
                  name: Result.isOk(copy) ? copy.value.name : undefined,
                });
              },
              (copy) => {
                router.dismissAll();
                router.push({
                  pathname: "/matter/[workspaceId]",
                  params: {
                    workspaceId: copy.id,
                    ...(copy.name === undefined ? {} : { name: copy.name }),
                  },
                });
              },
            );
          },
          text: t("duplicate"),
        },
      ],
    );
  };

  const archive = () => {
    Alert.alert(t("archive"), t("archiveMessage"), [
      { style: "cancel", text: t("cancel") },
      {
        onPress: () => {
          write(
            async () => await archiveMatter(request),
            () => {
              router.dismissAll();
            },
          );
        },
        text: t("archive"),
      },
    ]);
  };

  const unarchive = () => {
    write(async () => await unarchiveMatter(request), reload);
  };

  const remove = () => {
    write(
      async () => await deleteMatter(request),
      () => {
        router.dismissAll();
      },
    );
  };

  return (
    <View className="gap-2">
      <SectionTitle title={t("actions")} />
      {archived ? null : (
        <>
          <Button
            disabled={saving}
            onPress={() => {
              duplicate(false);
            }}
            variant="outline"
          >
            {t("duplicate")}
          </Button>
          <Button
            disabled={saving}
            onPress={() => {
              duplicate(true);
            }}
            variant="outline"
          >
            {t("duplicateWithContent")}
          </Button>
        </>
      )}
      <Button
        disabled={saving}
        onPress={archived ? unarchive : archive}
        variant="outline"
      >
        {archived ? t("unarchive") : t("archive")}
      </Button>
      {confirmingDelete ? (
        <View className="gap-2">
          <View className="px-1">
            <Text variant="caption">{t("deleteMessage")}</Text>
          </View>
          <Input
            accessibilityLabel={t("typeName")}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            disabled={saving}
            onChangeText={setTyped}
            placeholder={matter.name}
            value={typed}
          />
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              disabled={saving}
              onPress={() => {
                setConfirmingDelete(false);
                setTyped("");
              }}
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              className="flex-1"
              disabled={saving || typed.trim() !== matter.name}
              loading={saving}
              onPress={remove}
              variant="destructive"
            >
              {t("delete")}
            </Button>
          </View>
        </View>
      ) : (
        <Button
          disabled={saving}
          onPress={() => {
            setConfirmingDelete(true);
          }}
          variant="destructive-outline"
        >
          {t("delete")}
        </Button>
      )}
      <WriteFailureNotice failure={failure} message={t("saveFailed")} />
    </View>
  );
};

export default MatterInfoScreen;
