import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { CircleCheck, Folder, MessageCircle } from "lucide-react-native";

import { useAppColors } from "@/theme";

export default function TabLayout() {
  const colors = useAppColors();

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.accent}>
      <NativeTabs.Trigger name="(chats)">
        <Icon
          androidSrc={<MessageCircle />}
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
        <Label>Chats</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <Icon
          androidSrc={<CircleCheck />}
          sf={{
            default: "checkmark.circle",
            selected: "checkmark.circle.fill",
          }}
        />
        <Label>Tasks</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <Icon
          androidSrc={<Folder />}
          sf={{ default: "folder", selected: "folder.fill" }}
        />
        <Label>Matters</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
