import type React from "react";

import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import { renderEmail } from "../render/render";
import { ICON_URL } from "./_shared";
import * as BetterAuthOTP from "./better-auth-otp";
import { subject as otpSubject } from "./better-auth-otp-subject";
import * as InvoiceLink from "./invoice-link";
import { subject as invoiceLinkSubject } from "./invoice-link-subject";
import * as NewDeviceLogin from "./new-device-login";
import { subject as newDeviceLoginSubject } from "./new-device-login-subject";
import * as OrganizationInvitation from "./organization-invitation";
import { subject as invitationSubject } from "./organization-invitation-subject";
import * as ProductFeedback from "./product-feedback";

const renderHtml = (email: React.ReactElement) => renderEmail(email).html;

const PRAGUE_WITH_MAP = {
  type: "known",
  city: "Prague",
  region: "Hlavni mesto Praha",
  countryCode: "CZ",
  map: { contentId: "sign-in-location-map" },
} as const satisfies NewDeviceLogin.SignInLocation;

/**
 * Render tests for the transactional emails. A broken OTP or invite render is
 * a silent sign-in / onboarding lockout: SMTP is not exercised in e2e, so
 * these are the only automated guard that every locale of every critical
 * template produces valid, correctly-interpolated, injection-safe HTML.
 */

const LOCALES = UI_LOCALES;

const OTP_TYPES = [
  "sign-in",
  "email-verification",
  "forget-password",
  "change-email",
  "delete-account",
] as const;

// use-intl reports missing messages and malformed interpolation through
// `onError`, whose default is `console.error(intlError)`. Capturing those
// calls turns "renders but silently falls back to the message key" into a
// test failure.
const INTL_ERROR_CODES = [
  "MISSING_MESSAGE",
  "MISSING_FORMAT",
  "FORMATTING_ERROR",
  "INVALID_MESSAGE",
  "INVALID_KEY",
  "INSUFFICIENT_PATH",
  "ENVIRONMENT_FALLBACK",
];

let intlErrors: string[];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  intlErrors = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (INTL_ERROR_CODES.some((code) => text.includes(code))) {
      intlErrors.push(text);
    } else {
      originalConsoleError(...args);
    }
  };
});

afterEach(() => {
  console.error = originalConsoleError;
});

const expectNoIntlErrors = () => {
  expect(intlErrors).toEqual([]);
};

describe("OTP email", () => {
  test("renders the one-time code for every OTP type", () => {
    for (const type of OTP_TYPES) {
      const html = renderHtml(
        <BetterAuthOTP.Email lang="en" otp="951753" type={type} />,
      );
      expect(html).toContain("951753");
      expectNoIntlErrors();
    }
  });

  test("subject is present for every locale", () => {
    for (const lang of LOCALES) {
      expect(otpSubject(lang).length).toBeGreaterThan(0);
    }
  });
});

describe("link/CTA emails carry the correct href", () => {
  test("organization invitation embeds the invite link", () => {
    const inviteLink =
      "https://app.stella.test/auth/accept-invitation/tok_abc123";
    const html = renderHtml(
      <OrganizationInvitation.Email
        invitedByUsername="Jane Doe"
        inviteLink={inviteLink}
        lang="en"
        organizationName="Acme Inc"
      />,
    );
    expect(html).toContain(`href="${inviteLink}"`);
    expect(html).toContain("Acme Inc");
    expectNoIntlErrors();
  });

  test("new-device-login embeds the sessions URL", () => {
    const sessionsUrl = "https://app.stella.test/account/sessions";
    const html = renderHtml(
      <NewDeviceLogin.Email
        device={{ type: "browserOnOs", browser: "Chrome", os: "macOS" }}
        ipAddress={{ type: "known", address: "203.0.113.42" }}
        lang="en"
        location={{ type: "unknown" }}
        sessionsUrl={sessionsUrl}
        time="Mar 6, 2026, 2:30 PM UTC"
      />,
    );
    expect(html).toContain(`href="${sessionsUrl}"`);
    expectNoIntlErrors();
  });

  test("ampersands in an invite link are HTML-escaped, not left raw", () => {
    const html = renderHtml(
      <OrganizationInvitation.Email
        invitedByUsername="Jane Doe"
        inviteLink="https://app.stella.test/accept?token=a&next=/x"
        lang="en"
        organizationName="Acme Inc"
      />,
    );
    expect(html).toContain(
      'href="https://app.stella.test/accept?token=a&amp;next=/x"',
    );
  });
});

describe("every supported locale renders without missing-interpolation errors", () => {
  test("OTP, invitation, and new-device-login render cleanly in all locales", () => {
    // Sequential renders so a captured console.error stays attributable to a
    // single locale rather than interleaving across parallel renders.
    for (const lang of LOCALES) {
      const otpHtml = renderHtml(
        <BetterAuthOTP.Email lang={lang} otp="123456" type="sign-in" />,
      );
      expect(otpHtml).toContain("123456");

      const inviteHtml = renderHtml(
        <OrganizationInvitation.Email
          invitedByUsername="Jane Doe"
          inviteLink="https://app.stella.test/accept/tok"
          lang={lang}
          organizationName="Acme Inc"
        />,
      );
      // A missing `invitation.body` message would drop the interpolated org
      // name; its presence proves the ICU string resolved and interpolated.
      expect(inviteHtml).toContain("Acme Inc");
      expect(inviteHtml).toContain("Jane Doe");

      const deviceHtml = renderHtml(
        <NewDeviceLogin.Email
          device={{ type: "browserOnOs", browser: "Chrome", os: "macOS" }}
          ipAddress={{ type: "known", address: "203.0.113.42" }}
          lang={lang}
          location={PRAGUE_WITH_MAP}
          sessionsUrl="https://app.stella.test/account/sessions"
          time="Mar 6, 2026, 2:30 PM UTC"
        />,
      );
      expect(deviceHtml).toContain("Chrome");
      expect(deviceHtml).toContain("macOS");

      // The subject helpers hit a second, separately-namespaced key path.
      expect(otpSubject(lang).length).toBeGreaterThan(0);
      expect(newDeviceLoginSubject(lang).length).toBeGreaterThan(0);
      expect(
        invitationSubject(lang, { organizationName: "Acme Inc" }).length,
      ).toBeGreaterThan(0);

      expectNoIntlErrors();
    }
  });

  const DEVICES: readonly {
    device: NewDeviceLogin.SignInDevice;
    names: readonly string[];
  }[] = [
    {
      device: { type: "browserOnOs", browser: "Chrome", os: "macOS" },
      names: ["Chrome", "macOS"],
    },
    { device: { type: "browser", browser: "Chrome" }, names: ["Chrome"] },
    { device: { type: "os", os: "macOS" }, names: ["macOS"] },
    { device: { type: "unknown" }, names: [] },
  ];

  test.each(LOCALES.filter((lang) => lang !== "en"))(
    "%s words the device and a missing address in its own language",
    (lang) => {
      for (const { device, names } of DEVICES) {
        const { text } = renderEmail(
          <NewDeviceLogin.Email
            device={device}
            ipAddress={{ type: "unknown" }}
            lang={lang}
            location={{ type: "unknown" }}
            sessionsUrl="https://app.stella.test/account/sessions"
            time="Mar 6, 2026, 2:30 PM UTC"
          />,
        );
        // Browser and OS names are proper nouns and print as parsed; the
        // words around them are the locale's.
        for (const name of names) {
          expect(text).toContain(name);
        }
        expect(text).not.toMatch(/\bUnknown\b|\bon macOS\b/u);
      }
      expectNoIntlErrors();
    },
  );

  test("Arabic renders right-to-left and Latin locales left-to-right", () => {
    const arabic = renderHtml(
      <BetterAuthOTP.Email lang="ar" otp="123456" type="sign-in" />,
    );
    expect(arabic).toContain('dir="rtl"');

    const english = renderHtml(
      <BetterAuthOTP.Email lang="en" otp="123456" type="sign-in" />,
    );
    expect(english).toContain('dir="ltr"');
  });
});

describe("user-supplied strings are HTML-escaped in the rendered output", () => {
  const INJECTION = "<script>alert('xss')</script>";

  test("invitation escapes the organization name and inviter name", () => {
    const html = renderHtml(
      <OrganizationInvitation.Email
        invitedByUsername={INJECTION}
        inviteLink="https://app.stella.test/accept/tok"
        lang="en"
        organizationName={INJECTION}
      />,
    );
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;script&gt;");
  });

  test("new-device-login escapes the device string", () => {
    const html = renderHtml(
      <NewDeviceLogin.Email
        device={{ type: "browserOnOs", browser: INJECTION, os: INJECTION }}
        ipAddress={{ type: "known", address: "203.0.113.42" }}
        lang="en"
        location={{
          type: "known",
          city: INJECTION,
          region: INJECTION,
          countryCode: "CZ",
          map: null,
        }}
        sessionsUrl="https://app.stella.test/account/sessions"
        time="Mar 6, 2026, 2:30 PM UTC"
      />,
    );
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;script&gt;");
  });

  test("product-feedback escapes every reporter-supplied field", () => {
    const html = renderHtml(
      <ProductFeedback.Email
        receipt="FB-7K2M-9QXZ"
        report={{
          kind: "bug",
          area: "documents",
          title: INJECTION,
          whatHappened: INJECTION,
          expected: INJECTION,
          steps: INJECTION,
          evidence: INJECTION,
          context: { client: "mcp", route: INJECTION },
        }}
        reporter={{ via: "mcp", userId: "user_1", organizationId: "org_1" }}
        serverVersion="1.2.3"
      />,
    );
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("new-device-login location", () => {
  const renderNotice = (
    location: NewDeviceLogin.SignInLocation,
    lang: "en" | "ar" = "en",
  ) =>
    renderEmail(
      <NewDeviceLogin.Email
        device={{ type: "browserOnOs", browser: "Firefox", os: "Linux" }}
        ipAddress={{ type: "known", address: "198.51.100.7" }}
        lang={lang}
        location={location}
        sessionsUrl="https://app.stella.test/account/sessions"
        time="Mar 6, 2026, 2:30 PM UTC"
      />,
    );

  const imageSources = (html: string) =>
    [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gu)].map(([, src]) => src);

  test("a known location shows the place, the inline map and its sources", () => {
    const { html, text } = renderNotice(PRAGUE_WITH_MAP);

    // The logo is first-party; the map is a part of the message itself.
    expect(imageSources(html)).toEqual([ICON_URL, "cid:sign-in-location-map"]);
    expect(html).toContain(
      'alt="Map showing the approximate sign-in location: Prague, Hlavni mesto Praha, Czechia"',
    );
    expect(text).toMatchInlineSnapshot(`
      "NEW SIGN-IN TO YOUR ACCOUNT

      Someone just signed in to your account from a new device or location.

      Device: Firefox on Linux

      Location: Prague, Hlavni mesto Praha, Czechia (approximate)

      IP address: 198.51.100.7

      Time: Mar 6, 2026, 2:30 PM UTC

      If this was you, you don't need to do anything. If you don't recognize this sign-in, sign this device out.

      Review signed-in devices https://app.stella.test/account/sessions

      The button opens Settings › Security at this sign-in.

      ----------------------------------------

      stella | open source legal workspace"
    `);
    expectNoIntlErrors();
  });

  test("a known location without coordinates shows the place but no map", () => {
    const { html, text } = renderNotice({ ...PRAGUE_WITH_MAP, map: null });

    expect(imageSources(html)).toEqual([ICON_URL]);
    expect(text).toContain(
      "Location: Prague, Hlavni mesto Praha, Czechia (approximate)",
    );
    expectNoIntlErrors();
  });

  test("an unknown location leaves location and map out", () => {
    const { html, text } = renderNotice({ type: "unknown" });

    expect(imageSources(html)).toEqual([ICON_URL]);
    expect(text).toMatchInlineSnapshot(`
      "NEW SIGN-IN TO YOUR ACCOUNT

      Someone just signed in to your account from a new device or location.

      Device: Firefox on Linux

      IP address: 198.51.100.7

      Time: Mar 6, 2026, 2:30 PM UTC

      If this was you, you don't need to do anything. If you don't recognize this sign-in, sign this device out.

      Review signed-in devices https://app.stella.test/account/sessions

      The button opens Settings › Security at this sign-in.

      ----------------------------------------

      stella | open source legal workspace"
    `);
    expectNoIntlErrors();
  });

  test("a region named like its city is said once", () => {
    const { text } = renderNotice({
      type: "known",
      city: "Vienna",
      region: "Vienna",
      countryCode: "AT",
      map: null,
    });

    expect(text).toContain("Location: Vienna, Austria (approximate)");
  });

  test("a location with only a country names the country", () => {
    const { text } = renderNotice({
      type: "known",
      city: null,
      region: null,
      countryCode: "PT",
      map: null,
    });

    expect(text).toContain("Location: Portugal (approximate)");
  });

  test("Arabic names the country in Arabic and separates with the Arabic comma", () => {
    const { text } = renderNotice({ ...PRAGUE_WITH_MAP, map: null }, "ar");

    const country =
      new Intl.DisplayNames(["ar"], { type: "region" }).of("CZ") ??
      panic("Arabic has a name for Czechia");
    expect(country).not.toBe("Czechia");
    expect(text).toContain(`Prague، Hlavni mesto Praha، ${country}`);
    expectNoIntlErrors();
  });
});

describe("invoice link email", () => {
  const LINK =
    "https://app.stella.test/invoice-link#0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const DOCUMENT_TYPES = ["invoice", "advance", "credit_note"] as const;

  const props = (
    overrides: Partial<InvoiceLink.InvoiceLinkEmailProps> = {},
  ): InvoiceLink.InvoiceLinkEmailProps => ({
    lang: "en",
    documentType: "invoice",
    invoiceNumber: "2026-0042",
    firmName: "Example Law Office",
    amountDue: "EUR 1,250.00",
    dueDate: "14 November 2026",
    expiresOn: "26 December 2026",
    message: null,
    link: LINK,
    ...overrides,
  });

  test("every locale and document type renders the link, number and firm", () => {
    for (const lang of LOCALES) {
      for (const documentType of DOCUMENT_TYPES) {
        const html = renderHtml(
          <InvoiceLink.Email {...props({ lang, documentType })} />,
        );
        expect(html, `${lang} ${documentType}`).toContain(`href="${LINK}"`);
        expect(html, `${lang} ${documentType}`).toContain("2026-0042");
        expect(html, `${lang} ${documentType}`).toContain("Example Law Office");
        const title = invoiceLinkSubject(lang, {
          documentType,
          invoiceNumber: "2026-0042",
          firmName: "Example Law Office",
        });
        expect(title, `${lang} ${documentType}`).toContain("2026-0042");
        expect(title, `${lang} ${documentType}`).toContain(
          "Example Law Office",
        );
        expectNoIntlErrors();
      }
    }
  });

  test("names the document type in the subject", () => {
    expect(
      invoiceLinkSubject("cs", {
        documentType: "credit_note",
        invoiceNumber: "D-7",
        firmName: "Kancelář",
      }),
    ).toBe("Dobropis D-7 od Kancelář");
    expect(
      invoiceLinkSubject("en", {
        documentType: "advance",
        invoiceNumber: "Z-1",
        firmName: "Firm",
      }),
    ).toBe("Advance invoice Z-1 from Firm");
  });

  test("omits the amount and due date when nothing is due", () => {
    const html = renderHtml(
      <InvoiceLink.Email {...props({ amountDue: null, dueDate: null })} />,
    );
    expect(html).not.toContain("Amount due");
    expect(html).not.toContain("Due date");
  });

  test("escapes the firm name and the sender's message", () => {
    const INJECTION = "<script>alert('xss')</script>";
    const html = renderHtml(
      <InvoiceLink.Email
        {...props({ firmName: INJECTION, message: INJECTION })}
      />,
    );
    expect(html).not.toContain(INJECTION);
    expect(html).toContain("&lt;script&gt;");
  });

  test("the text part carries the amount, the sender's note and the link", () => {
    const { text } = renderEmail(
      <InvoiceLink.Email
        {...props({ message: "Please pay by Friday.\nThank you." })}
      />,
    );
    expect(text).toContain("EUR 1,250.00");
    expect(text).toContain("Please pay by Friday.");
    expect(text).toContain("Thank you.");
    expect(text).toContain(LINK);
  });
});
