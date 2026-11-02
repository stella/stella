import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { Textarea } = await import("./textarea");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

test("a form reset brings the count back to the restored text", async () => {
  const view = render(
    <form>
      <Textarea
        aria-label="Summary"
        defaultValue="Draft"
        maxLength={280}
        showCount
      />
    </form>,
  );
  const textarea = view.getByRole("textbox", { name: "Summary" });
  const count = () =>
    view.container.querySelector('[data-slot="textarea-count"]')?.textContent;

  fireEvent.change(textarea, { target: { value: "Draft, revised" } });
  expect(count()).toBe("14/280");

  textarea.closest("form")?.reset();

  expect(textarea).toHaveProperty("value", "Draft");
  await waitFor(() => {
    expect(count()).toBe("5/280");
  });
});
