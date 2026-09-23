import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { FileInput } from "./file-input";

const labels = {
  chooseLabel: "Choose file",
  emptyLabel: "No file selected",
};

describe("FileInput", () => {
  test("renders no native file input and labels the trigger with the caller's copy", () => {
    const markup = renderToStaticMarkup(
      <FileInput
        accept=".docx"
        file={null}
        onFileChange={() => {}}
        {...labels}
      />,
    );

    expect(markup).not.toContain('type="file"');
    expect(markup).toContain('data-slot="file-input-trigger"');
    expect(markup).toContain(">Choose file<");
    expect(markup).toContain(">No file selected<");
  });

  test("shows the selected file name in a bidi-isolated run", () => {
    const markup = renderToStaticMarkup(
      <FileInput
        file={new File([""], "smlouva.docx")}
        onFileChange={() => {}}
        {...labels}
      />,
    );

    expect(markup).toContain("<bdi>smlouva.docx</bdi>");
    expect(markup).not.toContain("No file selected");
  });

  test("composes the field label with the trigger's own text", () => {
    const markup = renderToStaticMarkup(
      <FileInput
        aria-labelledby="source-label"
        file={null}
        onFileChange={() => {}}
        {...labels}
      />,
    );

    const triggerId = /aria-labelledby="source-label ([^"]+)"/u.exec(
      markup,
    )?.[1];
    if (triggerId === undefined) {
      throw new Error("trigger id missing from aria-labelledby");
    }
    expect(markup).toContain(`id="${triggerId}"`);
  });

  test("disables the trigger", () => {
    const markup = renderToStaticMarkup(
      <FileInput disabled file={null} onFileChange={() => {}} {...labels} />,
    );

    expect(markup).toContain('data-slot="file-input-trigger" disabled=""');
  });
});
