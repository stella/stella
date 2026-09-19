---
"@stll/ui": minor
---

`openFilePicker` (`@stll/ui/file-picker`) opens the browser file chooser from any handler without an `<input type="file">` in the tree, so surfaces no longer carry a hidden input, a ref, or the value reset that lets the same file be picked twice. `FileInput` now uses it and renders no native input; `onFileChange` receives a `File` and is not called when the chooser is dismissed.
