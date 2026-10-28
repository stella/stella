import { useState, useTransition } from "react";

import { Result } from "better-result";
import { Stack, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { useTranslations } from "use-intl";

import { screenStyles } from "@/components/empty-state-screen";
import { useMattersView } from "@/components/matters-view";
import { Text, TextInput } from "@/components/ui/text";
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
  const { matterAdded } = useMattersView();
  const [name, setName] = useState("");
  const [failed, setFailed] = useState(false);
  const [creating, startCreating] = useTransition();
  const ready = name.trim() !== "" && !creating;

  const create = () => {
    if (!ready) {
      return;
    }
    startCreating(async () => {
      setFailed(false);
      const created = await createMatter({
        fetch,
        name: name.trim(),
        source,
      });
      if (Result.isOk(created)) {
        matterAdded();
        router.replace({
          pathname: "/matter/[workspaceId]",
          params: { name: name.trim(), workspaceId: created.value },
        });
        return;
      }
      if (created.error._tag === "SignedOutError") {
        end();
        return;
      }
      setFailed(true);
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
        {failed ? <Text variant="error">{t("createFailed")}</Text> : null}
      </ScrollView>
    </>
  );
};

export default NewMatterScreen;
