import { describe, expect, test } from "bun:test";

import {
  assertValidMailManifest,
  renderManifest,
} from "../scripts/render-manifest";

const wrapDesktopFormFactor = (children: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp>
  <VersionOverrides>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          ${children}
        </DesktopFormFactor>
      </Host>
    </Hosts>
  </VersionOverrides>
</OfficeApp>`;

const READ_EXTENSION_POINT =
  '<ExtensionPoint xsi:type="MessageReadCommandSurface" />';

describe("renderManifest", () => {
  test("dev and prod render and pass validation", () => {
    for (const env of ["dev", "prod"] as const) {
      const xml = renderManifest(env);
      expect(xml).toContain("<DesktopFormFactor>");
      // GetStarted is the trap: it is Taskpane-only and breaks mail sideload.
      expect(xml).not.toContain("GetStarted");
    }
  });
});

describe("assertValidMailManifest", () => {
  test("accepts FunctionFile + ExtensionPoint", () => {
    expect(() =>
      assertValidMailManifest(
        wrapDesktopFormFactor(
          `<FunctionFile resid="Commands.Url" />${READ_EXTENSION_POINT}`,
        ),
      ),
    ).not.toThrow();
  });

  test("rejects a GetStarted child (Taskpane-only element)", () => {
    expect(() =>
      assertValidMailManifest(
        wrapDesktopFormFactor(
          `<FunctionFile resid="Commands.Url" /><GetStarted><Title resid="x" /></GetStarted>${READ_EXTENSION_POINT}`,
        ),
      ),
    ).toThrow(/GetStarted/u);
  });

  test("rejects any other unexpected child element", () => {
    expect(() =>
      assertValidMailManifest(wrapDesktopFormFactor("<MobileFormFactor />")),
    ).toThrow(/DesktopFormFactor/u);
  });

  test("requires a DesktopFormFactor", () => {
    expect(() =>
      assertValidMailManifest('<?xml version="1.0"?><OfficeApp></OfficeApp>'),
    ).toThrow(/DesktopFormFactor/u);
  });
});
