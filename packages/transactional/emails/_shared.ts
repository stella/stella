import type React from "react";

export const ICON_URL = "https://assets.stll.app/email/stella-icon.png";

export const brand = {
  blue: "#205ea6",
  foreground: "#111827",
  textPrimary: "#374151",
  textMuted: "#6b7280",
  border: "#e5e7eb",
  backgroundPage: "#f6f9fc",
  backgroundCard: "#ffffff",
  backgroundCodeBlock: "#f3f4f6",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

export const sharedStyles = {
  body: {
    margin: "0",
    backgroundColor: brand.backgroundPage,
    padding: "24px 0",
    fontFamily: brand.fontFamily,
  },
  container: {
    margin: "0 auto",
    maxWidth: "520px",
    borderRadius: "12px",
    backgroundColor: brand.backgroundCard,
    padding: "24px",
    border: `1px solid ${brand.border}`,
  },
  wordmarkSection: {
    margin: "0 0 20px",
    textAlign: "center" as const,
  },
  heading: {
    margin: "0 0 12px",
    color: brand.foreground,
    fontSize: "24px",
    lineHeight: "32px",
    fontWeight: "700",
    textAlign: "center",
  },
  text: {
    margin: "0 0 16px",
    color: brand.textPrimary,
    fontSize: "16px",
    lineHeight: "24px",
    textAlign: "center",
  },
  muted: {
    margin: "0 0 16px",
    color: brand.textMuted,
    fontSize: "14px",
    lineHeight: "20px",
    textAlign: "center",
  },
  hr: {
    margin: "0 0 16px",
    borderColor: brand.border,
  },
  footer: {
    margin: "0 0 16px",
    color: brand.textMuted,
    fontSize: "13px",
    lineHeight: "20px",
    textAlign: "center",
  },
  brandFooter: {
    margin: "0",
    color: "#9ca3af",
    fontSize: "12px",
    lineHeight: "18px",
    textAlign: "center",
  },
} satisfies Record<string, React.CSSProperties>;
