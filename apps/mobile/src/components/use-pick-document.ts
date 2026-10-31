import { Result } from "better-result";
import { getDocumentAsync } from "expo-document-picker";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";

import { pickedFileSaveParams } from "@/state/document-upload";
import { readLocalFile } from "@/state/local-file";

/**
 * Uploading a document from Files, as the web's "Upload document": the
 * system picker, then the save sheet with the file's name, size and digest,
 * into `matterId` when one is given, else into the matter the person picks
 * there. A file that cannot be read says so; a cancelled pick does nothing.
 */
export const usePickDocument = (matterId?: string): (() => void) => {
  const chat = useTranslations("chat");
  const matter = useTranslations("matter");
  const router = useRouter();

  return () => {
    void (async () => {
      const picked = await Result.tryPromise(
        async () =>
          await getDocumentAsync({
            copyToCacheDirectory: true,
            multiple: false,
          }),
      );
      if (Result.isError(picked)) {
        Alert.alert(chat("pickFailed"));
        return;
      }
      if (picked.value.canceled) {
        return;
      }
      const file = picked.value.assets.at(0);
      if (file === undefined) {
        return;
      }
      const read = await readLocalFile(fetch, file.uri);
      if (Result.isError(read)) {
        Alert.alert(matter("uploadFailed"));
        return;
      }
      router.push({
        pathname: "/scan/save",
        params: pickedFileSaveParams({ file, matterId, ...read.value }),
      });
    })();
  };
};
