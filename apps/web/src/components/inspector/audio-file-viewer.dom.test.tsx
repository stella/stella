import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const router = await import("@tanstack/react-router");
await mock.module("@tanstack/react-router", () => ({
  ...router,
  useRouter: () => ({ state: { matches: [] } }),
}));

const { act } = await import("react");
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { fileOptions } = await import("@/lib/files/queries");
const { AudioFileViewer } = await import("./audio-file-viewer");

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const tab = {
  type: "pdf",
  id: "11111111-1111-4111-8111-111111111111",
  entityId: "22222222-2222-4222-8222-222222222222",
  label: "Hearing.mp3",
  fileName: "Hearing.mp3",
  mimeType: "audio/mpeg",
  pdfFileId: null,
  workspaceId: "33333333-3333-4333-8333-333333333333",
} as const;

const renderViewer = (onDownload: () => void) => {
  const client = new QueryClient();
  client.setQueryData(
    fileOptions({
      fieldId: tab.id,
      purpose: "native-display",
      workspaceId: tab.workspaceId,
    }).queryKey,
    {
      buffer: new ArrayBuffer(8),
      fileId: "file",
      fileName: tab.fileName,
      mimeType: tab.mimeType,
      originalMimeType: tab.mimeType,
    },
  );
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AudioFileViewer onDownload={onDownload} tab={tab} />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("plays the recording from its original bytes", async () => {
  renderViewer(() => undefined);
  const player = await screen.findByLabelText("Hearing.mp3");
  expect(player.tagName).toBe("AUDIO");
  expect(player.getAttribute("src")).toStartWith("blob:");
});

test("a recording the browser cannot play offers its download", async () => {
  let downloads = 0;
  renderViewer(() => {
    downloads += 1;
  });
  fireEvent.error(await screen.findByLabelText("Hearing.mp3"));
  await screen.findByText(messages.inspector.audioUnplayable);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(downloads).toBe(1);
});
