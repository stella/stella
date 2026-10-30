import { use, useState } from "react";

import { Result } from "better-result";
import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { MatterIcon } from "@/components/ui/matter-icon";
import { Text, TextInput } from "@/components/ui/text";
import { CheckIcon } from "@/icons.gen";
import type { MatterSummary } from "@/state/matters";
import { useUiColors } from "@/theme";

/** The most matters the picker lists at once; a search narrows the rest. */
const MATTERS_SHOWN = 40;

/**
 * The person's matters to choose one from, narrowed by what is typed, the
 * chosen one marked. With `noneLabel`, a first row chooses no matter.
 */
export const MatterPicker = ({
  matters,
  noneLabel,
  onSelect,
  selected,
}: {
  matters: Promise<Result<MatterSummary[], unknown>>;
  noneLabel?: string;
  onSelect: (matterId: string | null) => void;
  selected: string | null;
}) => {
  const t = useTranslations("tasks");
  const ui = useUiColors();
  const [search, setSearch] = useState("");
  const result = use(matters);

  if (Result.isError(result)) {
    return <Text variant="error">{t("mattersFailed")}</Text>;
  }
  const needle = search.trim().toLocaleLowerCase();
  const shown = result.value
    .filter(
      (matter) =>
        matter.id === selected ||
        needle === "" ||
        [matter.name, matter.reference, matter.client?.displayName].some(
          (field) => field?.toLocaleLowerCase().includes(needle) === true,
        ),
    )
    .slice(0, MATTERS_SHOWN);

  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={t("findMatter")}
        autoCapitalize="none"
        onChangeText={setSearch}
        placeholder={t("findMatter")}
        value={search}
        variant="search"
      />
      <View className="border-border bg-card rounded-xl border px-3">
        {noneLabel === undefined ? null : (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: selected === null }}
            className={`active:bg-accent flex-row items-center gap-3 py-3 ${
              shown.length === 0 ? "" : "border-border border-b"
            }`}
            onPress={() => {
              onSelect(null);
            }}
          >
            <View className="flex-1">
              <Text numberOfLines={1} variant="rowTitle">
                {noneLabel}
              </Text>
            </View>
            {selected === null ? (
              <CheckIcon color={ui.foreground} size={18} />
            ) : null}
          </Pressable>
        )}
        {shown.map((matter, index) => (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: matter.id === selected }}
            className={`active:bg-accent flex-row items-center gap-3 py-3 ${
              index === shown.length - 1 ? "" : "border-border border-b"
            }`}
            key={matter.id}
            onPress={() => {
              onSelect(matter.id);
            }}
          >
            <MatterIcon matter={matter} size={18} />
            <View className="flex-1 gap-0.5">
              <Text numberOfLines={1} variant="rowTitle">
                {matter.name}
              </Text>
              {matter.client?.displayName === undefined ? null : (
                <Text numberOfLines={1} variant="caption">
                  {matter.client.displayName}
                </Text>
              )}
            </View>
            {matter.id === selected ? (
              <CheckIcon color={ui.foreground} size={18} />
            ) : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
};
