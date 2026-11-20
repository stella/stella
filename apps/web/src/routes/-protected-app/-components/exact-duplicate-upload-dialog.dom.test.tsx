import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { useExactDuplicateUploadStore } =
  await import("@/lib/files/exact-duplicate-upload-store");
const { ExactDuplicateUploadDialog } =
  await import("./exact-duplicate-upload-dialog");

const labels = messages.workspaces.files.duplicateUpload;

/** Opens the dialog for one duplicate and records how the batch continues. */
const ask = () => {
  const resolutions: (readonly File[])[] = [];
  const duplicate = new File(["bytes"], "contract.pdf");
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ExactDuplicateUploadDialog />
    </IntlProvider>,
  );
  act(() => {
    useExactDuplicateUploadStore.getState().ask({
      duplicates: [{ file: duplicate, entityName: "Contract.pdf" }],
      onResolved: (uploadAnywayFiles) => {
        resolutions.push(uploadAnywayFiles);
      },
    });
  });
  return { resolutions };
};

const dialogIsClosed = () =>
  expect(useExactDuplicateUploadStore.getState().prompts).toEqual([]);

afterEach(async () => {
  await act(async () => cleanup());
  useExactDuplicateUploadStore.setState({ prompts: [], nextPromptId: 1 });
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("names the document the file duplicates", async () => {
  ask();

  expect(await screen.findByText("Contract.pdf")).toBeTruthy();
});

test("skipping the duplicates still continues the rest of the batch", async () => {
  const { resolutions } = ask();

  fireEvent.click(await screen.findByRole("button", { name: labels.skipAll }));

  expect(resolutions).toEqual([[]]);
  dialogIsClosed();
});

test("closing the dialog skips the duplicates instead of dropping the batch", async () => {
  const { resolutions } = ask();
  const dialog = await screen.findByRole("dialog");

  fireEvent.keyDown(dialog, { key: "Escape" });

  await waitFor(() => expect(resolutions).toEqual([[]]));
  dialogIsClosed();
});

test("confirming untouched choices uploads none of the duplicates, once", async () => {
  const { resolutions } = ask();

  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.uploadFiles }),
  );

  await waitFor(dialogIsClosed);
  expect(resolutions).toEqual([[]]);
});
