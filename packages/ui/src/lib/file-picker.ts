type PickedFiles = [File, ...File[]];

type OpenFilePickerOptions = {
  accept?: string | undefined;
  multiple?: boolean | undefined;
  onPick: (files: PickedFiles) => void;
};

/**
 * Opens the browser's file chooser without an `<input type="file">` in the
 * component tree, so no surface carries a hidden input, a ref, or the
 * value-reset that lets the same file be picked twice.
 *
 * Call it synchronously inside a user gesture (a click or keydown handler):
 * browsers open the chooser only under transient activation, so an `await`
 * before the call silently does nothing. Dismissing the chooser calls nothing;
 * `onPick` runs only with at least one file.
 */
const openFilePicker = ({
  accept,
  multiple = false,
  onPick,
}: OpenFilePickerOptions): void => {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  if (accept !== undefined) {
    input.accept = accept;
  }
  input.hidden = true;
  const settle = () => {
    input.remove();
    const [first, ...rest] = Array.from(input.files ?? []);
    if (first !== undefined) {
      onPick([first, ...rest]);
    }
  };
  input.addEventListener("change", settle, { once: true });
  input.addEventListener("cancel", settle, { once: true });
  // Safari opens the chooser only for an input attached to the document.
  document.body.append(input);
  input.click();
};

export { openFilePicker, type OpenFilePickerOptions };
