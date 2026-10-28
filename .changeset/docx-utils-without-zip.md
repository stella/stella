---
"@stll/docx-utils": patch
---

Remove the ZIP helpers (`loadDocx`, `loadDocxArchive`, `extractText`, `extractBinary`, `repackZip`, `writeZipEntry`, `DOCX_COMPRESSION` and the archive limits) and the JSZip dependency. Read and write archives with `ZipArchive` from `@stll/docx-core/zip`.
