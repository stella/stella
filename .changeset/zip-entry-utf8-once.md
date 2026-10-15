---
"@stll/docx-utils": minor
---

Add `writeZipEntry`, which UTF-8 encodes text entries in one pass before handing them to JSZip. JSZip's own string encoding works in 16 KiB pieces and turns a character outside the Basic Multilingual Plane (such as an emoji) that straddles a piece boundary into two replacement characters.
