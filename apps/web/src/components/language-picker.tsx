import { GlobeIcon } from "lucide-react";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";

export const LanguagePicker = () => {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);

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
                detached(setLang(code), "language-picker.set-lang")
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
