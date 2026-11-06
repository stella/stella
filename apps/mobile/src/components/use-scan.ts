import { Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";

import { scanPages } from "@/native/document-scanner";
import { encodeScannedPages } from "@/state/scan-pages";

/**
 * Opens the document camera and, once pages are saved, the review of them,
 * which shares them as a PDF or saves them into a matter: `matterId` when
 * the scan began inside one. Closing the camera without saving does nothing.
 * `replacing` puts the review in place of the screen the scan began on, as
 * the command palette asks.
 */
export const useScan = (
  matterId?: string,
  { replacing = false }: { replacing?: boolean } = {},
): (() => void) => {
  const t = useTranslations("scan");
  const router = useRouter();

  return () => {
    void (async () => {
      // The review's files go into a folder of their own.
      const review = randomUUID();
      const scanned = await scanPages(review);
      if (Result.isError(scanned)) {
        Alert.alert(t("failedTitle"), t("failed"));
        return;
      }
      if (scanned.value === null) {
        return;
      }
      const screen = {
        pathname: "/scan",
        params: {
          pages: encodeScannedPages(scanned.value),
          review,
          ...(matterId === undefined ? {} : { matterId }),
        },
      } as const;
      if (replacing) {
        router.replace(screen);
      } else {
        router.push(screen);
      }
    })();
  };
};
