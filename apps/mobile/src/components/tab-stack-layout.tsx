import { Stack } from "expo-router/stack";

import { SignOutButton } from "@/components/sign-out-button";
import { useAppColors } from "@/theme";

export const TabStackLayout = ({ title }: { title: string }) => {
  const colors = useAppColors();

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerBackButtonDisplayMode: "minimal",
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerLargeStyle: { backgroundColor: "transparent" },
        headerRight: () => <SignOutButton />,
        headerShadowVisible: false,
        headerTransparent: true,
      }}
    >
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
};
