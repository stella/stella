import { createRef, useState } from "react";
import type * as React from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { Field, FieldLabel } = await import("./field");
const { Form } = await import("./form");
const { Textarea } = await import("./textarea");
const { HighlightedTextarea } = await import("./highlighted-textarea");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

type Kind = "controlled" | "uncontrolled" | "highlighted";
const KINDS: readonly Kind[] = ["controlled", "uncontrolled", "highlighted"];

const Editor = ({
  kind,
  editorRef,
}: {
  kind: Kind;
  editorRef?: React.Ref<HTMLTextAreaElement>;
}) => {
  const [value, setValue] = useState("Original");
  const props = {
    id: "draft-editor",
    name: "draft",
    disabled: false,
    ref: editorRef,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setValue(event.currentTarget.value),
  };
  if (kind === "highlighted") {
    return (
      <HighlightedTextarea
        {...props}
        value={value}
        highlightedContent={value}
      />
    );
  }
  if (kind === "uncontrolled") {
    return <Textarea {...props} defaultValue="Original" />;
  }
  return <Textarea {...props} value={value} />;
};

for (const kind of KINDS) {
  test(`${kind}: the Field label targets the explicit native id`, () => {
    const view = render(
      <Field name="draft">
        <FieldLabel>Draft</FieldLabel>
        <Editor kind={kind} />
      </Field>,
    );
    const editor = view.getByRole("textbox", { name: "Draft" });
    expect(editor.id).toBe("draft-editor");
    expect(view.container.querySelector("label")?.htmlFor).toBe(editor.id);
    expect(view.container.querySelector("label")?.control === editor).toBe(
      true,
    );
  });
  for (const refKind of ["object", "callback"] as const) {
    test(`${kind}: Field submission preserves value with a ${refKind} ref`, async () => {
      const objectRef = createRef<HTMLTextAreaElement>();
      let callbackNode: HTMLTextAreaElement | null = null;
      let cleanupCount = 0;
      const callbackRef = (node: HTMLTextAreaElement | null) => {
        callbackNode = node;
        return () => {
          callbackNode = null;
          cleanupCount += 1;
        };
      };
      const editorRef = refKind === "object" ? objectRef : callbackRef;
      const submitted: unknown[] = [];
      const view = render(
        <Form
          aria-label="Example"
          onFormSubmit={(values: unknown) => {
            submitted.push(values);
          }}
        >
          <Field name="draft">
            <FieldLabel>Draft</FieldLabel>
            <Editor kind={kind} editorRef={editorRef} />
          </Field>
        </Form>,
      );
      const editor = view.getByRole("textbox", { name: "Draft" });
      expect(
        (refKind === "object" ? objectRef.current : callbackNode) === editor,
      ).toBe(true);
      expect(editor).toHaveProperty("value", "Original");
      fireEvent.change(editor, { target: { value: "Updated" } });
      expect(editor).toHaveProperty("value", "Updated");
      fireEvent.submit(view.getByRole("form", { name: "Example" }));
      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(submitted).toEqual([{ draft: "Updated" }]);
      expect(
        view.container.querySelector<HTMLElement>('[data-slot="field"]')
          ?.dataset["dirty"] !== undefined,
      ).toBe(true);
      view.unmount();
      expect(
        refKind === "object" ? objectRef.current : callbackNode,
      ).toBeNull();
      if (refKind === "callback") {
        expect(cleanupCount).toBeGreaterThan(0);
      }
    });
  }
  test(`${kind}: a disabled Field keeps its native editor disabled`, () => {
    const view = render(
      <Field name="draft" disabled>
        <FieldLabel>Draft</FieldLabel>
        <Editor kind={kind} />
      </Field>,
    );
    expect(view.getByRole("textbox", { name: "Draft" })).toHaveProperty(
      "disabled",
      true,
    );
  });
}
