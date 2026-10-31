import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@stll/ui/button";
import { GlobeIcon } from "@stll/ui/icons";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

import { setLang } from "@/i18n/client-document-locale";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";

export const LanguagePicker = () => {
  const queryClient = useQueryClient();
  const lang = useI18nStore((s) => s.lang);

  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <GlobeIcon className="size-4" />
        {LANG_ENDONYMS[lang]}
      </MenuTrigger>
      <MenuPopup side="bottom">
        <MenuRadioGroup value={lang}>
          {supportedLanguages.map((code) => (
            <MenuRadioItem
              key={code}
              onClick={() =>
                detached(setLang(queryClient, code), "language-picker.set-lang")
              }
              value={code}
            >
              {LANG_ENDONYMS[code]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};
