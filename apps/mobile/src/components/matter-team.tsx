import { startTransition, Suspense, use, useState } from "react";

import { Result } from "better-result";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { MemberChooser } from "@/components/member-chooser";
import { useMatterWrite } from "@/components/use-matter-write";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { CheckIcon, XIcon } from "@/icons.gen";
import type { ApiError } from "@/state/api-request";
import {
  addMatterMember,
  removeMatterMember,
  updateMatter,
} from "@/state/matter-detail";
import { listMemberCandidates } from "@/state/matters";
import type { MemberCandidate } from "@/state/matters";
import { listMatterMembers } from "@/state/tasks";
import type { MatterMember } from "@/state/tasks";
import { useAppColors, useUiColors } from "@/theme";

type MembersLoad = Promise<Result<MatterMember[], ApiError>>;

/**
 * Who works on a matter, as the web's matter info manages it: its lead,
 * chosen among its members, and its members, each of whom can be taken off
 * while another remains, with anyone of the organization to add.
 */
export const MatterTeam = ({
  disabled,
  leadUserId,
  matterId,
  onChanged,
  source,
}: {
  /** An archived matter shows its team without changing it. */
  disabled: boolean;
  leadUserId: string | null;
  matterId: string;
  /** Called after a change the matter's own details reflect, such as its lead. */
  onChanged: () => void;
  source: AccessTokenSource;
}) => {
  const colors = useAppColors();
  const loadMembers = async () =>
    await listMatterMembers({ fetch, matterId, source });
  const [members, setMembers] = useState<MembersLoad>(loadMembers);

  return (
    <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
      <LoadedTeam
        disabled={disabled}
        leadUserId={leadUserId}
        matterId={matterId}
        members={members}
        onChanged={() => {
          startTransition(() => {
            setMembers(loadMembers());
          });
          onChanged();
        }}
        source={source}
      />
    </Suspense>
  );
};

const LoadedTeam = ({
  disabled,
  leadUserId,
  matterId,
  members,
  onChanged,
  source,
}: {
  disabled: boolean;
  leadUserId: string | null;
  matterId: string;
  members: MembersLoad;
  onChanged: () => void;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("matterInfo");
  const ui = useUiColors();
  const colors = useAppColors();
  const { end } = useSession();
  const { failure, saving, write } = useMatterWrite(source);
  const [choosingLead, setChoosingLead] = useState(false);
  const [candidates, setCandidates] = useState<Promise<
    Result<MemberCandidate[], ApiError>
  > | null>(null);
  const loaded = use(members);
  const self = source.session()?.userId;

  if (Result.isError(loaded)) {
    if (loaded.error._tag === "SignedOutError") {
      end(source);
      return null;
    }
    return <Text variant="error">{t("membersFailed")}</Text>;
  }
  const team = loaded.value;
  const nameOf = (member: MatterMember) =>
    member.userId === self ? t("you") : (member.user?.name ?? t("someone"));
  const lead = team.find((member) => member.userId === leadUserId);
  // A lead whose account is gone still leads the matter, unnamed.
  let leadName = t("noLead");
  if (lead !== undefined) {
    leadName = nameOf(lead);
  } else if (leadUserId !== null) {
    leadName = t("someone");
  }
  const leadChoices: readonly { userId: string | null; name: string }[] = [
    { userId: null, name: t("noLead") },
    ...team.map((member) => ({ userId: member.userId, name: nameOf(member) })),
  ];
  const busy = disabled || saving;

  // The organization's people load the first time the list opens.
  const toggleCandidates = () => {
    if (candidates !== null) {
      setCandidates(null);
      return;
    }
    setCandidates(listMemberCandidates({ fetch, source }));
  };

  const chooseLead = (userId: string | null) => {
    setChoosingLead(false);
    if (userId === leadUserId) {
      return;
    }
    write(
      async () =>
        await updateMatter({
          change: { type: "leadUserId", value: userId },
          fetch,
          matterId,
          source,
        }),
      onChanged,
    );
  };

  const remove = (member: MatterMember) => {
    Alert.alert(
      t("removeMember"),
      t("removeMemberMessage", { name: nameOf(member) }),
      [
        { style: "cancel", text: t("cancel") },
        {
          onPress: () => {
            write(
              async () =>
                await removeMatterMember({
                  fetch,
                  matterId,
                  source,
                  userId: member.userId,
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

  const add = (candidate: MemberCandidate) => {
    write(
      async () =>
        await addMatterMember({
          fetch,
          matterId,
          source,
          userId: candidate.userId,
        }),
      onChanged,
    );
  };

  return (
    <View className="gap-5">
      <View className="gap-2">
        <SectionTitle title={t("lead")} />
        <View className="border-border bg-card rounded-xl border px-3">
          <View className="min-h-11 flex-row items-center gap-3 py-2">
            <Text className="flex-1" numberOfLines={1} variant="rowTitle">
              {leadName}
            </Text>
            {disabled ? null : (
              <Button
                disabled={busy}
                onPress={() => {
                  setChoosingLead((open) => !open);
                }}
                size="sm"
                variant="outline"
              >
                {choosingLead ? t("done") : t("change")}
              </Button>
            )}
          </View>
          {choosingLead
            ? leadChoices.map((choice) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{
                    disabled: busy,
                    selected: choice.userId === leadUserId,
                  }}
                  className="border-border active:bg-accent min-h-11 flex-row items-center gap-3 border-t py-2"
                  disabled={busy}
                  key={choice.userId ?? "none"}
                  onPress={() => {
                    chooseLead(choice.userId);
                  }}
                >
                  <Text className="flex-1" numberOfLines={1} variant="rowTitle">
                    {choice.name}
                  </Text>
                  {choice.userId === leadUserId ? (
                    <CheckIcon color={ui.foreground} size={18} />
                  ) : null}
                </Pressable>
              ))
            : null}
        </View>
      </View>
      <View className="gap-2">
        <SectionTitle title={t("members")} />
        <View className="border-border bg-card rounded-xl border px-3">
          {team.map((member, index) => (
            <View
              className={`min-h-11 flex-row items-center gap-3 py-2 ${
                index === team.length - 1 ? "" : "border-border border-b"
              }`}
              key={member.userId}
            >
              <Text className="flex-1" numberOfLines={1} variant="rowTitle">
                {nameOf(member)}
              </Text>
              {disabled || team.length < 2 ? null : (
                <Pressable
                  accessibilityLabel={t("removeMember")}
                  accessibilityRole="button"
                  className="p-1 active:opacity-60"
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => {
                    remove(member);
                  }}
                >
                  <XIcon color={ui.mutedForeground} size={18} />
                </Pressable>
              )}
            </View>
          ))}
        </View>
        {disabled ? null : (
          <Button disabled={busy} onPress={toggleCandidates} variant="outline">
            {candidates === null ? t("addMember") : t("done")}
          </Button>
        )}
        {candidates === null ? null : (
          <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
            <MemberChooser
              chosen={new Set()}
              disabled={busy}
              load={candidates}
              locked={new Set(team.map((member) => member.userId))}
              onToggle={(candidate, choose) => {
                if (choose) {
                  add(candidate);
                }
              }}
              self={self}
              source={source}
            />
          </Suspense>
        )}
        <WriteFailureNotice failure={failure} message={t("saveFailed")} />
      </View>
    </View>
  );
};

/** The small capitals over a group of rows. */
export const SectionTitle = ({ title }: { title: string }) => (
  <View className="px-1">
    <Text variant="section">{title}</Text>
  </View>
);
