---
"@stll/workspace-ui": minor
---

`FileConversionRefusal` adds `{ kind: "no_preview", format, cause }`: an image this deployment makes no preview of, because it does not decode the format (`"decoding_off"`) or cannot read the file's pictures (`"unreadable"`). `format` is the file's short tag, such as `"HEIC"`.
