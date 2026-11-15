import { use } from "react";

import { Result } from "better-result";
import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { CheckIcon } from "@/icons.gen";
import type { ApiError } from "@/state/api-request";
import type { MemberCandidate } from "@/state/matters";
import { useUiColors } from "@/theme";

/**
 * The organization's people, to choose who a matter is shared with: a tap
 * checks or unchecks one. `locked` people are on the matter whatever is
 * tapped, the person themselves among them, so their check cannot be taken
 * off here.
 */
export const MemberChooser = ({
  chosen,
  disabled,
  load,
  locked,
  onToggle,
  self,
  source,
}: {
  chosen: ReadonlySet<string>;
  disabled: boolean;
  load: Promise<Result<MemberCandidate[], ApiError>>;
  locked: ReadonlySet<string>;
  onToggle: (member: MemberCandidate, choose: boolean) => void;
  /** The signed-in person, named "You" rather than by their own name. */
  self: string | undefined;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matters");
  const ui = useUiColors();
  const { end } = useSession();
  const loaded = use(load);

  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return <Text variant="error">{t("teamFailed")}</Text>;
  }

  return (
    <View className="border-border bg-card rounded-xl border px-3">
      {loaded.value.map((member, index) => {
        const isLocked = locked.has(member.userId);
        const isChosen = isLocked || chosen.has(member.userId);
        return (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{
              checked: isChosen,
              disabled: disabled || isLocked,
            }}
            className={`active:bg-accent min-h-11 flex-row items-center gap-3 py-2 ${
              index === loaded.value.length - 1 ? "" : "border-border border-b"
            }`}
            disabled={disabled || isLocked}
            key={member.userId}
            onPress={() => {
              onToggle(member, !isChosen);
            }}
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text numberOfLines={1} variant="rowTitle">
                {member.userId === self ? t("you") : member.name}
              </Text>
              <Text numberOfLines={1} variant="caption">
                {member.email}
              </Text>
            </View>
            {isChosen ? (
              <CheckIcon
                color={isLocked ? ui.mutedForeground : ui.foreground}
                size={18}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
};
