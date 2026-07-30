import * as Device from "expo-device";
import { Platform } from "react-native";

import {
  parseMobileApiUrl,
  shouldAllowAndroidEmulatorHttp,
} from "@/config/api-url";

const isDevelopmentBuild =
  typeof __DEV__ === "boolean"
    ? __DEV__
    : process.env.NODE_ENV !== "production";

export const env = {
  API_URL: parseMobileApiUrl(process.env.EXPO_PUBLIC_API_URL, {
    allowAndroidEmulatorHttp: shouldAllowAndroidEmulatorHttp({
      buildMode: isDevelopmentBuild ? "development" : "production",
      deviceKind: Device.isDevice ? "physical" : "emulator",
      platform: Platform.OS,
    }),
  }),
  RUNTIME: process.env.EXPO_OS === "web" ? "web" : "native",
} as const;
