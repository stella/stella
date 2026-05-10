import { GlobeIcon } from "lucide-react";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/components/menu";

import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";

export const LanguagePicker = () => {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);

  return (
    <Menu>
      <MenuTrigger
        className="text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
        render={<button type="button" />}
      >
        <GlobeIcon className="size-4" />
        {LANG_ENDONYMS[lang]}
      </MenuTrigger>
      <MenuPopup side="bottom">
        <MenuRadioGroup value={lang}>
          {supportedLanguages.map((code) => (
            <MenuRadioItem
              key={code}
              onClick={() => void setLang(code)}
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
