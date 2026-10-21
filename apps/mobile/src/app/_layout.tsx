/* oxlint-disable react/style-prop-object -- Expo StatusBar uses `style` as an appearance enum, not a React Native style object. */
import { Suspense } from "react";

import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/loading-screen";
import { ProtectedScreens } from "@/components/protected-screens";
import { SessionProvider } from "@/connection/session-provider";
import { MobileIntlProvider } from "@/i18n";

/** The keychain is read once at launch; the spinner covers that read. */
const RootLayout = () => (
  <SafeAreaProvider>
    <MobileIntlProvider>
      <Suspense fallback={<LoadingScreen />}>
        <SessionProvider>
          <ProtectedScreens />
        </SessionProvider>
      </Suspense>
    </MobileIntlProvider>
    <StatusBar style="auto" />
  </SafeAreaProvider>
);

export default RootLayout;
