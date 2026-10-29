import type React from "react";

import type { TextDirection } from "@stll/locales";

type Props = React.PropsWithChildren<{
  lang: string;
  dir: TextDirection;
}>;

/** The document root; `dir` comes from the email's locale. */
export const Html = ({ children, lang, dir }: Props) => (
  <html dir={dir} lang={lang}>
    {children}
  </html>
);
