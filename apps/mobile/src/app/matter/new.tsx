import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { getPossibleDuplicateMatters } from "@stll/api-contract/matter-duplicates";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { ContactPicker } from "@/components/contact-picker";
import { screenStyles } from "@/components/empty-state-screen";
import { MemberChooser } from "@/components/member-chooser";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import type { ContactChoice } from "@/state/contacts";
import {
  createMatter,
  listMatters,
  listMemberCandidates,
  newMatterMembers,
} from "@/state/matters";
import type { MatterSummary, MemberCandidate } from "@/state/matters";
import { useAppColors } from "@/theme";

/** How many look-alike matters the sheet names, as the web's dialog does. */
const DUPLICATES_SHOWN = 3;

/**
 * A new matter, presented as a sheet over the matters, with what the web's
 * create dialog asks: its name and its client, a contact found by name or
 * added to the address book on the spot. With a client it can be shared
 * with colleagues from the start; without one it is personal. The sheet
 * names the client's matters with a similar name, and its number comes from
 * the firm's numbering. The bar's Create opens it, and the sheet gives way
 * to the matter itself.
 */
const NewMatterScreen = () => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <NewMatterForm source={state.source} />
  ) : null;
};

const NewMatterForm = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("matters");
  const tabs = useTranslations("tabs");
  const colors = useAppColors();
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  // One id for the sheet, so pressing Create again after a failure
  // retries the same matter rather than opening another.
  const [matterId] = useState(randomUUID);
  const [name, setName] = useState("");
  const [client, setClient] = useState<ContactChoice | null>(null);
  const self = source.session()?.userId;
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  // Loaded once a client makes the matter shareable.
  const [candidates, setCandidates] = useState<Promise<
    Result<MemberCandidate[], ApiError>
  > | null>(null);
  const loadMatters = async () => await listMatters({ fetch, source });
  const [matters, setMatters] = useState(loadMatters);
  // A client being added to the address book is not chosen yet; creating
  // the matter meanwhile would open it without that client.
  const [addingClient, setAddingClient] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [creating, startCreating] = useTransition();
  const ready = name.trim() !== "" && !creating && !addingClient;

  const pickClient = (contact: ContactChoice | null) => {
    setClient(contact);
    if (contact !== null && candidates === null) {
      setCandidates(listMemberCandidates({ fetch, source }));
    }
  };

  const create = () => {
    if (!ready) {
      return;
    }
    const clientId = client?.id ?? null;
    startCreating(async () => {
      setFailure(null);
      const created = await createMatter({
        clientId,
        fetch,
        id: matterId,
        memberUserIds: newMatterMembers({ chosen, clientId, creatorId: self }),
        name: name.trim(),
        source,
      });
      if (Result.isOk(created)) {
        changed("matters");
        router.replace({
          pathname: "/matter/[workspaceId]",
          params: { name: name.trim(), workspaceId: created.value },
        });
        return;
      }
      if (created.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(created.error));
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("newMatter"),
          unstable_headerLeftItems: () => [
            {
              label: tabs("close"),
              onPress: () => {
                router.back();
              },
              type: "button",
            },
          ],
          unstable_headerRightItems: () => [
            {
              disabled: !ready,
              label: t("create"),
              onPress: create,
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
        <Input
          accessibilityLabel={t("name")}
          autoFocus
          disabled={creating}
          onChangeText={setName}
          onSubmitEditing={create}
          placeholder={t("name")}
          returnKeyType="done"
          value={name}
        />
        <WriteFailureNotice failure={failure} message={t("createFailed")} />
        <View className="gap-2">
          <View className="px-1">
            <Text variant="section">{t("client")}</Text>
          </View>
          <ContactPicker
            clearLabel={t("removeClient")}
            disabled={creating}
            onAddingChange={setAddingClient}
            onSelect={pickClient}
            selected={client}
            source={source}
          />
          {client === null ? (
            <View className="px-1">
              <Text variant="caption">{t("personalDescription")}</Text>
            </View>
          ) : (
            <Suspense fallback={null}>
              <PossibleDuplicates
                clientId={client.id}
                matters={matters}
                name={name}
                onRetry={() => {
                  setMatters(loadMatters());
                }}
              />
            </Suspense>
          )}
        </View>
        {client === null || candidates === null ? null : (
          <View className="gap-2">
            <View className="gap-1 px-1">
              <Text variant="section">{t("team")}</Text>
              <Text variant="caption">{t("teamHint")}</Text>
            </View>
            <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
              <MemberChooser
                chosen={chosen}
                disabled={creating}
                load={candidates}
                locked={new Set(self === undefined ? [] : [self])}
                onToggle={(member, choose) => {
                  setChosen((current) => {
                    const next = new Set(current);
                    if (choose) {
                      next.add(member.userId);
                    } else {
                      next.delete(member.userId);
                    }
                    return next;
                  });
                }}
                self={self}
                source={source}
              />
            </Suspense>
          </View>
        )}
      </ScrollView>
    </>
  );
};

/**
 * The client's matters whose names resemble the one being typed, by the
 * web's own rule, so a matter opened twice is caught before it is.
 */
const PossibleDuplicates = ({
  clientId,
  matters,
  name,
  onRetry,
}: {
  clientId: string;
  matters: Promise<Result<MatterSummary[], ApiError>>;
  name: string;
  onRetry: () => void;
}) => {
  const t = useTranslations("matters");
  const loaded = use(matters);
  if (Result.isError(loaded)) {
    // Not the same as no look-alikes: the check did not run.
    return (
      <View className="flex-row items-center gap-3 px-1">
        <Text className="flex-1" variant="caption">
          {t("duplicatesFailed")}
        </Text>
        <Button onPress={onRetry} size="sm" variant="outline">
          {t("retry")}
        </Button>
      </View>
    );
  }
  const duplicates = getPossibleDuplicateMatters({
    clientId,
    limit: DUPLICATES_SHOWN,
    name,
    workspaces: loaded.value,
  });
  if (duplicates.length === 0) {
    return null;
  }
  return (
    <View className="border-border bg-card gap-2 rounded-xl border px-3 py-3">
      <Text variant="label">{t("possibleDuplicates")}</Text>
      {duplicates.map((matter) => (
        <View className="flex-row items-center gap-3" key={matter.id}>
          <MatterIcon matter={matter} size={16} />
          <Text className="flex-1" numberOfLines={1} variant="rowTitle">
            {matter.name}
          </Text>
          {matter.reference === undefined ||
          matter.reference === null ? null : (
            <Text variant="caption">{matter.reference}</Text>
          )}
        </View>
      ))}
    </View>
  );
};

export default NewMatterScreen;
