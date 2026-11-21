import { test } from "../helpers/test";
import captureVisualDesign from "../visual-design-capture.flow";

test("generated showcase keeps labels legible, mobile tiles in bounds and content clear at the end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await captureVisualDesign({
    page,
    webUrl: test.info().project.use.baseURL ?? "http://localhost:3000",
    snap: async () => {},
  });
});
