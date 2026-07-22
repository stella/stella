import {
  focusManager,
  onlineManager,
  QueryClient,
} from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { env } from "@/env";

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: {
      retry: 1,
      staleTime: 60_000,
    },
  },
});

if (env.RUNTIME === "native") {
  onlineManager.setEventListener((setOnline) => {
    Network.getNetworkStateAsync()
      .then((state) => setOnline(state.isConnected ?? true))
      .catch(() => setOnline(true));

    const subscription = Network.addNetworkStateListener((state) => {
      setOnline(state.isConnected ?? true);
    });
    return () => subscription.remove();
  });

  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) => {
      setFocused(state === "active");
    });
    return () => subscription.remove();
  });
}
