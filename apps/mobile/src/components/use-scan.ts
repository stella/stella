import { Result } from "better-result";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";

import { scanDocument } from "@/native/document-scanner";

/**
 * Opens the document camera and, once pages are saved, the sheet that
 * uploads them, into `matterId` when the scan began inside a matter. Closing
 * the camera without saving does nothing. `replacing` puts the sheet in
 * place of the screen the scan began on, as the command palette asks.
 */
export const useScan = (
  matterId?: string,
  { replacing = false }: { replacing?: boolean } = {},
): (() => void) => {
  const t = useTranslations("scan");
  const router = useRouter();

  return () => {
    void (async () => {
      const scanned = await Result.tryPromise(async () => await scanDocument());
      if (Result.isError(scanned)) {
        Alert.alert(t("failedTitle"), t("failed"));
        return;
      }
      if (scanned.value === null) {
        return;
      }
      const sheet = {
        pathname: "/scan",
        params: {
          pageCount: String(scanned.value.pageCount),
          sha256Hex: scanned.value.sha256Hex,
          size: String(scanned.value.size),
          uri: scanned.value.uri,
          ...(matterId === undefined ? {} : { matterId }),
        },
      } as const;
      if (replacing) {
        router.replace(sheet);
      } else {
        router.push(sheet);
      }
    })();
  };
};
