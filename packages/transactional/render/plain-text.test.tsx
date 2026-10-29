import type React from "react";

import { describe, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import { Body } from "../components/body";
import { Button } from "../components/button";
import { Head } from "../components/head";
import { Html } from "../components/html";
import { Preview } from "../components/preview";
import { BRAND_FOOTER_TEXT } from "../emails/_shared";
import * as BetterAuthOTP from "../emails/better-auth-otp";
import * as NewDeviceLogin from "../emails/new-device-login";
import * as OrganizationInvitation from "../emails/organization-invitation";
import * as ProductFeedback from "../emails/product-feedback";
import * as ReportExportStatus from "../emails/report-export-status";
import { getTranslator } from "../i18n/translate";
import { EmailMarkupError, toPlainText } from "./plain-text";
import { renderEmail } from "./render";

/**
 * The plain-text part is what text-only clients and screen readers that
 * prefer it show, so its layout is asserted on the real templates: heading,
 * paragraphs, call-to-action link, divider and footer, in that order.
 */

const DIVIDER = "-".repeat(40);

describe("plain text of the real templates", () => {
  test("OTP email: uppercased heading, blank-line paragraphs, divider, no preview or image", () => {
    const { text } = renderEmail(
      <BetterAuthOTP.Email lang="en" otp="951753" type="sign-in" />,
    );
    expect(text).toBe(
      [
        "YOUR STELLA ONE-TIME CODE",
        "",
        "Use this code to sign in to your stella account.",
        "",
        "951753",
        "",
        "This code expires in 5 minutes.",
        "",
        DIVIDER,
        "",
        "If you didn't request this code, you can ignore this email.",
        "",
        "stella | open source legal workspace",
      ].join("\n"),
    );
  });

  test("a call-to-action button is its label followed by its decoded URL", () => {
    const { text } = renderEmail(
      <OrganizationInvitation.Email
        invitedByUsername="Jane Doe"
        inviteLink="https://app.stella.test/accept?token=a&next=/x"
        lang="en"
        organizationName="Acme Inc"
      />,
    );
    expect(text.split("\n")).toContain(
      "Accept invitation https://app.stella.test/accept?token=a&next=/x",
    );
  });

  test("the preview line is left out, so text shared with the body appears once", () => {
    const { html, text } = renderEmail(
      <OrganizationInvitation.Email
        invitedByUsername="Jane Doe"
        inviteLink="https://app.stella.test/accept/tok"
        lang="en"
        organizationName="Acme Inc"
      />,
    );
    const body =
      "You've been invited to join Acme Inc by Jane Doe. Click below to accept.";
    // Twice in the HTML (preview and paragraph), once in the text.
    expect(html.split("You&#x27;ve been invited").length - 1).toBe(2);
    expect(text.split(body).length - 1).toBe(1);
    expect(text).not.toContain("\u{200C}");
    expect(text).not.toContain("\u{FEFF}");
  });

  test("bold labels stay inline with their values, one detail per paragraph", () => {
    const { text } = renderEmail(
      <NewDeviceLogin.Email
        device="Chrome on macOS"
        ipAddress="203.0.113.42"
        lang="en"
        sessionsUrl="https://app.stella.test/account/sessions"
        time="Mar 6, 2026, 2:30 PM UTC"
      />,
    );
    expect(text).toContain(
      [
        "Device: Chrome on macOS",
        "",
        "IP address: 203.0.113.42",
        "",
        "Time: Mar 6, 2026, 2:30 PM UTC",
        "",
        "Review sessions https://app.stella.test/account/sessions",
        "",
        DIVIDER,
      ].join("\n"),
    );
  });

  test("escaped user input comes back as the literal characters", () => {
    const injection = "<script>alert('xss')</script> & \"quotes\"";
    const { html, text } = renderEmail(
      <OrganizationInvitation.Email
        invitedByUsername="Jane Doe"
        inviteLink="https://app.stella.test/accept/tok"
        lang="en"
        organizationName={injection}
      />,
    );
    expect(html).not.toContain(injection);
    expect(text).toContain(`join ${injection} by Jane Doe.`);
  });

  test("the maintainer feedback email lists only the fields that are set", () => {
    const { text } = renderEmail(
      <ProductFeedback.Email
        receipt="FB-CCCC-DDDD"
        report={{
          kind: "docs",
          area: "mcp_cli",
          title: "Docs typo",
          whatHappened: "The   quick-start page misspells   stella.",
        }}
        reporter={{ via: "intake", instance: "https://self-hosted.example" }}
        serverVersion="1.2.3"
      />,
    );
    expect(text).toBe(
      [
        "DOCUMENTATION",
        "",
        "Docs typo",
        "",
        "Receipt: FB-CCCC-DDDD",
        "",
        "Area: mcp_cli",
        "",
        "Server version: 1.2.3",
        "",
        "What happened",
        "",
        "The quick-start page misspells stella.",
        "",
        DIVIDER,
        "",
        "Reporter (private, not published)",
        "",
        "Channel: public intake (no user identity)",
        "",
        "Instance: https://self-hosted.example",
        "",
        "stella | open source legal workspace",
      ].join("\n"),
    );
  });

  test("every template in every locale converts without markup leaking into the text", () => {
    for (const lang of UI_LOCALES) {
      const t = getTranslator(lang);
      // Each email with its closing paragraph: the brand footer, or the
      // translated notice for the email that has no footer.
      const emails: [React.ReactElement, string][] = [
        [
          <BetterAuthOTP.Email
            key="otp"
            lang={lang}
            otp="123456"
            type="sign-in"
          />,
          BRAND_FOOTER_TEXT,
        ],
        [
          <NewDeviceLogin.Email
            key="device"
            device="Chrome on macOS"
            ipAddress="203.0.113.42"
            lang={lang}
            sessionsUrl="https://app.stella.test/account/sessions"
            time="Mar 6, 2026, 2:30 PM UTC"
          />,
          t("newDeviceLogin.ignore"),
        ],
        [
          <OrganizationInvitation.Email
            key="invitation"
            invitedByUsername="Jane Doe"
            inviteLink="https://app.stella.test/accept/tok"
            lang={lang}
            organizationName="Acme Inc"
          />,
          BRAND_FOOTER_TEXT,
        ],
        [
          <ReportExportStatus.Email
            key="export"
            appUrl="https://app.stella.test/workspaces"
            lang={lang}
            status="completed"
          />,
          BRAND_FOOTER_TEXT,
        ],
      ];
      for (const [email, closing] of emails) {
        const { text } = renderEmail(email);
        expect(text).not.toMatch(/[<>]|&#?\w+;|mso/u);
        expect(text.split("\n")).toContain(DIVIDER);
        expect(text.split("\n").at(-1)).toBe(closing);
      }
    }
  });
});

describe("toPlainText on component markup", () => {
  test("a link whose text is its URL is not repeated", () => {
    const { text } = renderEmail(
      <Html lang="en" dir="ltr">
        <Head />
        <Preview>Preview</Preview>
        <Body style={{ margin: "0" }}>
          <Button href="https://stella.test/x" style={{ padding: "12px" }}>
            https://stella.test/x
          </Button>
        </Body>
      </Html>,
    );
    expect(text).toBe("https://stella.test/x");
  });

  test("markup outside the email components is refused, not guessed at", () => {
    expect(() =>
      toPlainText("<html><body><ul><li>item</li></ul></body></html>"),
    ).toThrow(EmailMarkupError);
    expect(() =>
      toPlainText("<html><body><ul><li>item</li></ul></body></html>"),
    ).toThrow("unsupported <ul>");
    expect(() => toPlainText("<html><head></head></html>")).toThrow(
      "no <body>",
    );
  });
});
