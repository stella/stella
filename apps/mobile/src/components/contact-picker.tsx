import { useEffect, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import type { ContactType } from "@stll/api-contract/workspace-contacts";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { BuildingIcon, PlusIcon, UserIcon, XIcon } from "@/icons.gen";
import { createContact, searchContacts } from "@/state/contacts";
import type { ContactChoice } from "@/state/contacts";
import { SEARCH_DEBOUNCE_MS } from "@/state/search";
import { useAppColors, useUiColors } from "@/theme";

type Found =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | { readonly status: "found"; readonly contacts: readonly ContactChoice[] }
  | { readonly status: "failed" };

/** A person or an organization, as the web marks a contact. */
const ContactGlyph = ({ type }: { type: ContactType }) => {
  const ui = useUiColors();
  return type === "person" ? (
    <UserIcon color={ui.mutedForeground} size={18} />
  ) : (
    <BuildingIcon color={ui.mutedForeground} size={18} />
  );
};

/**
 * A contact for a matter, such as its client, as the web's contact picker
 * chooses one: the chosen contact with a button to clear it, and a field
 * that finds contacts by name as it is typed. Whatever is typed can also go
 * into the address book as a new person or organization, which is then the
 * one chosen.
 */
export const ContactPicker = ({
  clearLabel,
  disabled,
  onSelect,
  selected,
  source,
}: {
  /** What the button clearing the chosen contact says, such as "Remove client". */
  clearLabel: string;
  disabled: boolean;
  onSelect: (contact: ContactChoice | null) => void;
  selected: ContactChoice | null;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matters");
  const ui = useUiColors();
  const colors = useAppColors();
  const { end } = useSession();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found>({ status: "idle" });
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [adding, startAdding] = useTransition();
  // One id per name and kind being added, so pressing again after a lost
  // answer gets the same contact back rather than a second one.
  const requestIds = useRef(new Map<string, string>());
  const tickets = useRef(0);
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(pause.current);
    },
    [],
  );

  const search = (text: string) => {
    setQuery(text);
    setFailure(null);
    clearTimeout(pause.current);
    tickets.current += 1;
    const ticket = tickets.current;
    if (text.trim() === "") {
      setFound({ status: "idle" });
      return;
    }
    setFound({ status: "searching" });
    pause.current = setTimeout(() => {
      void (async () => {
        const result = await searchContacts({ fetch, query: text, source });
        // Only the latest search's answer shows.
        if (ticket !== tickets.current) {
          return;
        }
        if (Result.isOk(result)) {
          setFound({ status: "found", contacts: result.value });
          return;
        }
        if (result.error._tag === "SignedOutError") {
          end(source);
          return;
        }
        setFound({ status: "failed" });
      })();
    }, SEARCH_DEBOUNCE_MS);
  };

  const choose = (contact: ContactChoice) => {
    onSelect(contact);
    search("");
  };

  const add = (type: ContactType) => {
    const displayName = query.trim();
    const intent = `${type}:${displayName}`;
    const requestId = requestIds.current.get(intent) ?? randomUUID();
    requestIds.current.set(intent, requestId);
    startAdding(async () => {
      setFailure(null);
      const created = await createContact({
        displayName,
        fetch,
        requestId,
        source,
        type,
      });
      if (Result.isOk(created)) {
        choose(created.value);
        return;
      }
      if (created.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(created.error));
    });
  };

  const typed = query.trim();
  const busy = disabled || adding;

  return (
    <View className="gap-2">
      {selected === null ? null : (
        <View className="border-border bg-card min-h-11 flex-row items-center gap-3 rounded-xl border px-3 py-2">
          <ContactGlyph type={selected.type} />
          <Text className="flex-1" numberOfLines={1} variant="rowTitle">
            {selected.displayName}
          </Text>
          <Pressable
            accessibilityLabel={clearLabel}
            accessibilityRole="button"
            className="p-1 active:opacity-60"
            disabled={busy}
            hitSlop={8}
            onPress={() => {
              onSelect(null);
            }}
          >
            <XIcon color={ui.mutedForeground} size={18} />
          </Pressable>
        </View>
      )}
      <Input
        accessibilityLabel={t("findClient")}
        autoCapitalize="words"
        autoCorrect={false}
        disabled={busy}
        onChangeText={search}
        placeholder={t("findClient")}
        type="search"
        value={query}
      />
      {typed === "" ? null : (
        <View className="border-border bg-card rounded-xl border px-3">
          {found.status === "searching" ? (
            <View className="border-border items-start border-b py-3">
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : null}
          {found.status === "failed" ? (
            <View className="border-border border-b py-3">
              <Text variant="error">{t("contactsFailed")}</Text>
            </View>
          ) : null}
          {found.status === "found" && found.contacts.length === 0 ? (
            <View className="border-border border-b py-3">
              <Text variant="caption">{t("noContacts")}</Text>
            </View>
          ) : null}
          {found.status === "found"
            ? found.contacts.map((contact) => (
                <Pressable
                  accessibilityRole="button"
                  className="border-border active:bg-accent min-h-11 flex-row items-center gap-3 border-b py-3"
                  disabled={busy}
                  key={contact.id}
                  onPress={() => {
                    choose(contact);
                  }}
                >
                  <ContactGlyph type={contact.type} />
                  <Text className="flex-1" numberOfLines={1} variant="rowTitle">
                    {contact.displayName}
                  </Text>
                </Pressable>
              ))
            : null}
          {(["person", "organization"] as const).map((type, index) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              className={`active:bg-accent min-h-11 flex-row items-center gap-3 py-3 ${
                index === 0 ? "border-border border-b" : ""
              }`}
              disabled={busy}
              key={type}
              onPress={() => {
                add(type);
              }}
            >
              <PlusIcon color={ui.foreground} size={18} />
              <Text className="flex-1" numberOfLines={2} variant="rowTitle">
                {type === "person"
                  ? t("addPerson", { name: typed })
                  : t("addOrganization", { name: typed })}
              </Text>
              {adding ? <ActivityIndicator color={colors.muted} /> : null}
            </Pressable>
          ))}
        </View>
      )}
      <WriteFailureNotice failure={failure} message={t("addContactFailed")} />
    </View>
  );
};
