import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type * as TestingLibrary from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { Field, FieldError, FieldLabel } from "./field";
import { Form } from "./form";
import { Input } from "./input";

// Registered for this file only, and the testing library loaded after it,
// so the shared test process keeps one happy-dom at a time.
let library: typeof TestingLibrary;

beforeAll(async () => {
  GlobalRegistrator.register();
  library = await import("@testing-library/react");
});

afterEach(() => {
  library.cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("Form server errors", () => {
  test("a server error marks its field and shows in its FieldError", () => {
    const { render, screen } = library;
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
    const { render, screen } = library;
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
