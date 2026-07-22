import { NativeTabs } from "expo-router/unstable-native-tabs";

import { useAppColors } from "@/theme";

export default function TabLayout() {
  const colors = useAppColors();

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.accent}>
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Icon
          md="chat"
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon
          md="check_circle"
          sf={{
            default: "checkmark.circle",
            selected: "checkmark.circle.fill",
          }}
        />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <NativeTabs.Trigger.Icon
          md="folder"
          sf={{ default: "folder", selected: "folder.fill" }}
        />
        <NativeTabs.Trigger.Label>Matters</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
