import { Result } from "better-result";
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
      const scanned = await scanPages();
      if (Result.isError(scanned)) {
        Alert.alert(t("failedTitle"), t("failed"));
        return;
      }
      if (scanned.value === null) {
        return;
      }
      const review = {
        pathname: "/scan",
        params: {
          pages: encodeScannedPages(scanned.value),
          ...(matterId === undefined ? {} : { matterId }),
        },
      } as const;
      if (replacing) {
        router.replace(review);
      } else {
        router.push(review);
      }
    })();
  };
};
