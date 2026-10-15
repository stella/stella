import JSZip from "jszip";

import { writeZipEntry } from "@stll/docx-utils";

declare const xml: string;

const zip = new JSZip();
// oxlint-disable-next-line no-string-zip-entry/no-string-zip-entry -- fixture proves a string entry write is reported
zip.file("word/document.xml", xml);
// oxlint-disable-next-line no-string-zip-entry/no-string-zip-entry -- fixture proves an entry write with options is reported
zip.file("mimetype", xml, { compression: "STORE" });

// expect-clean: no-string-zip-entry/no-string-zip-entry
writeZipEntry(zip, "word/document.xml", xml);
const _read = zip.file("word/document.xml");
const _bunFile = Bun.file("a.txt");
