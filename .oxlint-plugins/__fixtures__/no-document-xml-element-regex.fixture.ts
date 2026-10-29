declare const xml: string;

// oxlint-disable-next-line no-document-xml-element-regex/no-document-xml-element-regex
export const element = /<item>[\s\S]*?<\/item>/u.exec(xml);

// oxlint-disable-next-line no-document-xml-element-regex/no-document-xml-element-regex
export const dotAllElement = /<item>.*?<\/item>/su.exec(xml);

// expect-clean: no-document-xml-element-regex/no-document-xml-element-regex
export const attribute = /<item\s+name="[^"]+">/u.exec(xml);
