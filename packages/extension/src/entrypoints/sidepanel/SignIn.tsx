import { useRef, useState } from "react";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";

import { API_BASE } from "../../lib/config";
import { storage } from "../../lib/storage";

type SignInStep =
  | { type: "email" }
  | { type: "otp"; email: string };

type SignInProps = {
  onSuccess: () => void;
};

export const SignIn = ({ onSuccess }: SignInProps) => {
  const [step, setStep] = useState<SignInStep>({
    type: "email",
  });
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const handleSendOtp = async () => {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/auth/email-otp/send-verification-otp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            type: "sign-in",
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        // SAFETY: error shape from better-auth.
        const body = await res.json().catch(() => null);
        setError(
          (body as { message?: string })?.message ??
            "Failed to send code",
        );
        return;
      }

      setStep({ type: "otp", email: email.trim() });
    } catch {
      setError("Failed to send code");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (step.type !== "otp" || !otp.trim()) return;
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);

    try {
      // Sign in via direct fetch to capture the
      // set-auth-token response header for bearer auth.
      const res = await fetch(
        `${API_BASE}/api/auth/sign-in/email-otp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: step.email,
            otp: otp.trim(),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        // SAFETY: error shape from better-auth.
        const body = await res.json().catch(() => null);
        setError(
          (body as { message?: string })?.message ??
            "Invalid code",
        );
        return;
      }

      const token = res.headers.get("set-auth-token");
      if (!token) {
        setError("No auth token received");
        return;
      }

      await storage.setBearerToken(token);

      // Set active organization.
      const orgsRes = await fetch(
        `${API_BASE}/api/auth/organization/list`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (orgsRes.ok) {
        // SAFETY: better-auth Organization[].
        let orgs = (await orgsRes.json()) as Array<{
          id: string;
        }>;

        // New users have no org; create one.
        // NOTE: In production, this should match the
        // web app's onboarding flow instead of creating
        // a standalone org. For dev/testing,
        // auto-creating is acceptable.
        if (orgs.length === 0) {
          const createRes = await fetch(
            `${API_BASE}/api/auth/organization/create`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                name: step.email.split("@")[1]
                  ?? "My Organization",
                slug: `org-${Date.now()}`,
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (createRes.ok) {
            // SAFETY: better-auth Organization.
            const created =
              (await createRes.json()) as {
                id: string;
              };
            orgs = [created];
          }
        }

        const firstOrg = orgs.at(0);
        if (firstOrg) {
          await fetch(
            `${API_BASE}/api/auth/organization/set-active`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                organizationId: firstOrg.id,
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
        }
      }

      onSuccess();
    } catch {
      setError("Sign in failed");
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8">
        <div className="flex w-full max-w-xs flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <img
              src="/icon-128.png"
              alt="stella"
              width={48}
              height={48}
              className="rounded-[10px]"
            />
            <h1 className="text-xl font-semibold text-foreground">
              stella
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sign in to start clipping.
            </p>
          </div>

          {step.type === "email" ? (
            <div className="flex w-full flex-col gap-3">
              <label
                htmlFor="sign-in-email"
                className="text-xs font-medium text-foreground"
              >
                Email
              </label>
              <Input
                id="sign-in-email"
                nativeInput
                type="email"
                placeholder="you@firm.com"
                value={email}
                onChange={(e) =>
                  setEmail(e.currentTarget.value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSendOtp();
                }}
                disabled={loading}
                autoFocus
              />
              <Button
                className="w-full"
                disabled={!email.trim() || loading}
                loading={loading}
                onClick={handleSendOtp}
              >
                Send code
              </Button>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Enter the code sent to{" "}
                <span className="font-medium text-foreground">
                  {step.email}
                </span>
              </p>
              <label
                htmlFor="sign-in-otp"
                className="text-xs font-medium text-foreground"
              >
                Verification code
              </label>
              <Input
                id="sign-in-otp"
                nativeInput
                type="text"
                inputMode="numeric"
                placeholder="000000"
                value={otp}
                onChange={(e) =>
                  setOtp(e.currentTarget.value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    handleVerifyOtp();
                }}
                disabled={loading}
                autoFocus
              />
              <Button
                className="w-full"
                disabled={!otp.trim() || loading}
                loading={loading}
                onClick={handleVerifyOtp}
              >
                Verify
              </Button>
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => {
                  setStep({ type: "email" });
                  setOtp("");
                  setError(null);
                }}
              >
                Use a different email
              </button>
            </div>
          )}

          {error ? (
            <p className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
};
