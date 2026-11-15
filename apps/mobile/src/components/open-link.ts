import { Result } from "better-result";
import { ActionSheetIOS, Alert, Linking, Platform, Share } from "react-native";
import { useTranslations } from "use-intl";

import type { OpenableLink } from "@/state/links";
import { linkShareContent } from "@/state/share-content";

/**
 * How a tapped link in text the app did not write opens. A link to the
 * app's own screen opens at once; a web page first shows its host, with Open
 * and Share (whose sheet also copies the link), so the person sees where it
 * goes before leaving the app. Only links `@/state/links` accepted reach
 * here, and nothing else in the chat opens a link (`architecture.test.ts`).
 */
export const useOpenLink = (): ((link: OpenableLink) => void) => {
  const t = useTranslations("link");
  const open = (url: string) => {
    void (async () => {
      const opened = await Result.tryPromise(
        async () => await Linking.openURL(url),
      );
      if (Result.isError(opened)) {
        Alert.alert(t("openFailed"));
      }
    })();
  };
  const share = (url: string) => {
    void Share.share(linkShareContent(url, Platform.OS));
  };

  return (link) => {
    if (link.kind === "app") {
      open(link.url);
      return;
    }
    const { host, url } = link;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex: 2,
          options: [t("open"), t("share"), t("cancel")],
          title: host,
        },
        (index) => {
          if (index === 0) {
            open(url);
          } else if (index === 1) {
            share(url);
          }
        },
      );
      return;
    }
    Alert.alert(host, undefined, [
      { style: "cancel", text: t("cancel") },
      { onPress: () => share(url), text: t("share") },
      { onPress: () => open(url), text: t("open") },
    ]);
  };
};
