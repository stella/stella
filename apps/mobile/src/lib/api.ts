import { Platform } from "react-native";

import { createStellaEdenClient } from "@stll/api-client";
import type { API } from "@stll/api/types";

import { env } from "@/env";
import { authClient } from "@/lib/auth-client";
import { createAuthTransportOptions } from "@/lib/auth-transport";

const authRuntime = Platform.OS === "web" ? "web" : "native";
const eden = createStellaEdenClient<API>(
  env.API_URL,
  createAuthTransportOptions(authRuntime, () => authClient.getCookie()),
);

export const api = eden.v1;
