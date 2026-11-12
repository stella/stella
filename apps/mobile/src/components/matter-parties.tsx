import { startTransition, Suspense, use, useState } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { WORKSPACE_CONTACT_ROLES } from "@stll/api-contract/workspace-contacts";
import type { WorkspaceContactRole } from "@stll/api-contract/workspace-contacts";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { ContactPicker } from "@/components/contact-picker";
import { SectionTitle } from "@/components/matter-team";
import { useMatterWrite } from "@/components/use-matter-write";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { XIcon } from "@/icons.gen";
import type { ApiError } from "@/state/api-request";
import type { ContactChoice } from "@/state/contacts";
import {
  addMatterParty,
  listMatterParties,
  removeMatterParty,
} from "@/state/matter-detail";
import type { MatterParty } from "@/state/matter-detail";
import { useAppColors, useUiColors } from "@/theme";

type PartiesLoad = Promise<Result<MatterParty[], ApiError>>;

/**
 * The matter's other parties, as the web's matter info lists them: each
 * contact in its role, with a party to add from the address book, or added
 * to it on the spot, in a role chosen for it.
 */
export const MatterParties = ({
  disabled,
  matterId,
  source,
}: {
  /** An archived matter shows its parties without changing them. */
  disabled: boolean;
  matterId: string;
  source: AccessTokenSource;
}) => {
  const colors = useAppColors();
  const load = async () => await listMatterParties({ fetch, matterId, source });
  const [parties, setParties] = useState<PartiesLoad>(load);

  return (
    <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
      <LoadedParties
        disabled={disabled}
        matterId={matterId}
        onChanged={() => {
          startTransition(() => {
            setParties(load());
          });
        }}
        parties={parties}
        source={source}
      />
    </Suspense>
  );
};

const LoadedParties = ({
  disabled,
  matterId,
  onChanged,
  parties,
  source,
}: {
  disabled: boolean;
  matterId: string;
  onChanged: () => void;
  parties: PartiesLoad;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const ui = useUiColors();
  const { end } = useSession();
  const { failure, saving, write } = useMatterWrite(source);
  const [adding, setAdding] = useState(false);
  // A party being added to the address book is not chosen yet.
  const [addingContact, setAddingContact] = useState(false);
  const [contact, setContact] = useState<ContactChoice | null>(null);
  const [role, setRole] = useState<WorkspaceContactRole | null>(null);
  // One id per contact and role being linked, so pressing Add again after a
  // lost answer links the party once.
  const [requestId, setRequestId] = useState(randomUUID);
  const loaded = use(parties);

  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return <Text variant="error">{t("partiesFailed")}</Text>;
  }
  const listed = loaded.value;
  const busy = disabled || saving;

  const close = () => {
    setAdding(false);
    setContact(null);
    setRole(null);
    setRequestId(randomUUID());
  };

  const add = () => {
    if (contact === null || role === null) {
      return;
    }
    write(
      async () =>
        await addMatterParty({
          contactId: contact.id,
          fetch,
          matterId,
          requestId,
          role,
          source,
        }),
      () => {
        close();
        onChanged();
      },
    );
  };

  const remove = (party: MatterParty) => {
    Alert.alert(
      t("removeParty"),
      t("removePartyMessage", { name: party.contact.displayName }),
      [
        { style: "cancel", text: t("cancel") },
        {
          onPress: () => {
            write(
              async () =>
                await removeMatterParty({
                  fetch,
                  matterId,
                  partyId: party.id,
                  source,
                }),
              onChanged,
            );
          },
          style: "destructive",
          text: t("remove"),
        },
      ],
    );
  };

  return (
    <View className="gap-2">
      <SectionTitle title={t("parties")} />
      {listed.length === 0 ? (
        <View className="px-1">
          <Text variant="caption">{t("noParties")}</Text>
        </View>
      ) : (
        <View className="border-border bg-card rounded-xl border px-3">
          {listed.map((party, index) => (
            <View
              className={`min-h-11 flex-row items-center gap-3 py-2 ${
                index === listed.length - 1 ? "" : "border-border border-b"
              }`}
              key={party.id}
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1} variant="rowTitle">
                  {party.contact.displayName}
                </Text>
                <Text numberOfLines={1} variant="caption">
                  {t(`role.${party.role}`)}
                </Text>
              </View>
              {disabled ? null : (
                <Pressable
                  accessibilityLabel={t("removeParty")}
                  accessibilityRole="button"
                  className="p-1 active:opacity-60"
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => {
                    remove(party);
                  }}
                >
                  <XIcon color={ui.mutedForeground} size={18} />
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
      {adding && !disabled ? (
        <View className="gap-3">
          <ContactPicker
            clearLabel={t("removeParty")}
            disabled={busy}
            onAddingChange={setAddingContact}
            onSelect={(picked) => {
              setContact(picked);
              setRequestId(randomUUID());
            }}
            selected={contact}
            source={source}
          />
          <View className="flex-row flex-wrap gap-2">
            {WORKSPACE_CONTACT_ROLES.map((choice) => (
              <RoleChip
                disabled={busy}
                key={choice}
                label={t(`role.${choice}`)}
                onPress={() => {
                  setRole(choice);
                  setRequestId(randomUUID());
                }}
                selected={role === choice}
              />
            ))}
          </View>
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              onPress={close}
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              className="flex-1"
              disabled={
                busy || addingContact || contact === null || role === null
              }
              loading={saving}
              onPress={add}
            >
              {t("addParty")}
            </Button>
          </View>
        </View>
      ) : null}
      {adding || disabled ? null : (
        <Button
          disabled={busy}
          onPress={() => {
            setAdding(true);
          }}
          variant="outline"
        >
          {t("addParty")}
        </Button>
      )}
      <WriteFailureNotice failure={failure} message={t("saveFailed")} />
    </View>
  );
};

/** A party role to choose, filled while it is the chosen one. */
const RoleChip = ({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) => {
  const ui = useUiColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ disabled, selected }}
      className={`rounded-full border px-3 py-1.5 active:opacity-60 ${
        selected ? "border-foreground bg-foreground" : "border-border bg-card"
      }`}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={selected ? { color: ui.background } : undefined}
        variant="label"
      >
        {label}
      </Text>
    </Pressable>
  );
};
