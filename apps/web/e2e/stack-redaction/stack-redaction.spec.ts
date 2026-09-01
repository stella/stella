import { expect, test } from "@playwright/test";

const hasOnlyDecimalDigits = (value: string): boolean => {
  if (value === "") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined || code < 48 || code > 57) {
      return false;
    }
  }
  return true;
};

test("retains Firefox and WebKit frames without URL metadata", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const captured = await page.evaluate(() => window.captureBrowserError());

  expect(captured.originalMessage).toBe("Privileged matter client name");
  expect(captured.originalStack).toContain("?matter=private#client");
  expect(captured.name).toBe("TypeError");
  expect(captured.message).toBe("");
  if (captured.redactedStack === undefined) {
    throw new TypeError("Expected a redacted browser stack");
  }
  const [header, ...frames] = captured.redactedStack.split("\n");
  expect(header).toBe("TypeError:");
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    const symbolSeparator = frame.indexOf("@");
    const columnSeparator = frame.lastIndexOf(":");
    const lineSeparator = frame.lastIndexOf(":", columnSeparator - 1);
    const line = frame.slice(lineSeparator + 1, columnSeparator);
    const column = frame.slice(columnSeparator + 1);
    expect(symbolSeparator).toBeGreaterThanOrEqual(0);
    expect(lineSeparator).toBeGreaterThan(symbolSeparator);
    expect(columnSeparator).toBeGreaterThan(lineSeparator);
    expect(hasOnlyDecimalDigits(line)).toBe(true);
    expect(hasOnlyDecimalDigits(column)).toBe(true);
  }
  expect(captured.redactedStack).toContain("captureBrowserError@");
  expect(captured.redactedStack).not.toContain("Privileged matter client name");
  expect(captured.redactedStack).not.toContain("matter=private");
  expect(captured.redactedStack).not.toContain("client");
});
