import { useRef, useState } from "react";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";

import { API_BASE } from "../../lib/config";
import { storage } from "../../lib/storage";

/**
 * Parse a Response body as JSON with a type assertion.
 * Single suppression point for chrome/fetch untyped JSON.
 */
// eslint-disable-next-line typescript/no-unnecessary-type-parameters
const parseJson = async <T,>(
  res: Response,
  // SAFETY: caller verifies shape; used for known API contracts.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
): Promise<T> => (await res.json()) as T;

type SignInStep = { type: "email" } | { type: "otp"; email: string };

type SignInProps = {
  onSuccess: () => void;
};

type ErrorBody = { message?: string };

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
    if (!email.trim()) {
      return;
    }
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
        const body = await parseJson<ErrorBody>(res).catch(() => null);
        setError(body?.message ?? "Failed to send code");
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
    if (step.type !== "otp" || !otp.trim()) {
      return;
    }
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    setLoading(true);
    setError(null);

    try {
      // Sign in via direct fetch to capture the
      // set-auth-token response header for bearer auth.
      const res = await fetch(`${API_BASE}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: step.email,
          otp: otp.trim(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await parseJson<ErrorBody>(res).catch(() => null);
        setError(body?.message ?? "Invalid code");
        return;
      }

      const token = res.headers.get("set-auth-token");
      if (!token) {
        setError("No auth token received");
        return;
      }

      await storage.setBearerToken(token);

      // Set active organization.
      const orgsRes = await fetch(`${API_BASE}/api/auth/organization/list`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (orgsRes.ok) {
        let orgs = await parseJson<{ id: string }[]>(orgsRes);

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
                name: step.email.split("@")[1] ?? "My Organization",
                slug: `org-${Date.now()}`,
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (createRes.ok) {
            const created = await parseJson<{
              id: string;
            }>(createRes);
            orgs = [created];
          }
        }

        const firstOrg = orgs.at(0);
        if (firstOrg) {
          await fetch(`${API_BASE}/api/auth/organization/set-active`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              organizationId: firstOrg.id,
            }),
            signal: AbortSignal.timeout(10_000),
          });
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
            <h1 className="text-foreground text-xl font-semibold">stella</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Sign in to start clipping.
            </p>
          </div>

          {step.type === "email" ? (
            <div className="flex w-full flex-col gap-3">
              <label
                htmlFor="sign-in-email"
                className="text-foreground text-xs font-medium"
              >
                Email
              </label>
              <Input
                id="sign-in-email"
                nativeInput
                type="email"
                placeholder="you@firm.com"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleSendOtp();
                  }
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
              <p className="text-muted-foreground text-sm">
                Enter the code sent to{" "}
                <span className="text-foreground font-medium">
                  {step.email}
                </span>
              </p>
              <label
                htmlFor="sign-in-otp"
                className="text-foreground text-xs font-medium"
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
                onChange={(e) => setOtp(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleVerifyOtp();
                  }
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
                className="text-muted-foreground hover:text-foreground text-xs underline"
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

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>
      </div>
    </div>
  );
};
