import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

// The same order as the other DOM tests here: register, then load the
// libraries that read the document, and unregister when the file is done.
GlobalRegistrator.register();
const { cleanup, render, screen } = await import("@testing-library/react");
const { Field, FieldError, FieldLabel } = await import("./field");
const { Form } = await import("./form");
const { Input } = await import("./input");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

describe("Form server errors", () => {
  test("a server error marks its field and shows in its FieldError", () => {
    render(
      <Form errors={{ email: "Already invited" }}>
        <Field name="email">
          <FieldLabel>Email</FieldLabel>
          <Input defaultValue="ada@example.com" />
          <FieldError />
        </Field>
        <Field name="name">
          <FieldLabel>Name</FieldLabel>
          <Input defaultValue="Ada" />
          <FieldError />
        </Field>
      </Form>,
    );

    expect(screen.getByText("Already invited")).toBeDefined();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).not.toBe(
      "true",
    );
  });

  test("a FieldError matched to one constraint stays hidden for a server error", () => {
    render(
      <Form errors={{ email: "Already invited" }}>
        <Field name="email">
          <FieldLabel>Email</FieldLabel>
          <Input defaultValue="ada@example.com" required />
          <FieldError match="valueMissing">Enter an email</FieldError>
        </Field>
      </Form>,
    );

    expect(screen.queryByText("Enter an email")).toBeNull();
  });
});
