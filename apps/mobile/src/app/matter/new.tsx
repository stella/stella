import { useState, useTransition } from "react";

import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { useTranslations } from "use-intl";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { Text, TextInput } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { createMatter } from "@/state/matters";

/**
 * A new matter, presented as a sheet over the matters: its name. The bar's
 * Create opens it as a personal matter, which the web can later give a
 * client and members, and the sheet gives way to the matter itself.
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
  const router = useRouter();
  const { end } = useSession();
  const changed = useChanged();
  // One id for the sheet, so pressing Create again after a failure
  // retries the same matter rather than opening another.
  const [matterId] = useState(randomUUID);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [creating, startCreating] = useTransition();
  const ready = name.trim() !== "" && !creating;

  const create = () => {
    if (!ready) {
      return;
    }
    startCreating(async () => {
      setFailure(null);
      const created = await createMatter({
        fetch,
        id: matterId,
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
        className="bg-background flex-1"
        contentContainerStyle={screenStyles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          accessibilityLabel={t("name")}
          autoFocus
          onChangeText={setName}
          onSubmitEditing={create}
          placeholder={t("name")}
          returnKeyType="done"
          value={name}
        />
        <Text variant="caption">{t("personalHint")}</Text>
        <WriteFailureNotice failure={failure} message={t("createFailed")} />
      </ScrollView>
    </>
  );
};

export default NewMatterScreen;
