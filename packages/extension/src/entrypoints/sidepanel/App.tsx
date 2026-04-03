import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@stella/ui/components/button";

import { API_BASE } from "../../lib/config";
import { storage } from "../../lib/storage";
import type { Matter } from "../../types";
import { ClipForm } from "./ClipForm";
import { MatterPicker } from "./MatterPicker";
import { RecentClips } from "./RecentClips";
import { SignIn } from "./SignIn";

type SessionUser = {
  name: string | null;
  email: string;
};

type AuthState =
  | { type: "loading" }
  | { type: "unauthenticated" }
  | { type: "authenticated"; user: SessionUser };

export const App = () => {
  const [activeMatter, setActiveMatter] =
    useState<Matter | null>(null);
  const [authState, setAuthState] = useState<AuthState>({
    type: "loading",
  });

  const checkSession = useCallback(async () => {
    const token = await storage.getBearerToken();
    if (!token) {
      setAuthState({ type: "unauthenticated" });
      return;
    }

    try {
      const res = await fetch(
        `${API_BASE}/api/auth/get-session`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!res.ok) {
        // Only clear token on auth failures; transient
        // server errors should not log the user out.
        if (res.status === 401 || res.status === 403) {
          await storage.clearBearerToken();
        }
        setAuthState({ type: "unauthenticated" });
        return;
      }

      // SAFETY: better-auth session response shape.
      // eslint-disable-next-line typescript/consistent-type-assertions
      const data = (await res.json()) as {
        user: { name: string | null; email: string };
      };
      setAuthState({
        type: "authenticated",
        user: data.user,
      });
    } catch {
      // Network / timeout error; do NOT clear the token.
      // The server may just be temporarily unreachable.
      setAuthState({ type: "unauthenticated" });
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  if (authState.type === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Loading...
        </p>
      </div>
    );
  }

  if (authState.type === "unauthenticated") {
    return <SignIn onSuccess={checkSession} />;
  }

  const { user } = authState;
  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : user.email.slice(0, 2).toUpperCase();

  const handleSignOut = async () => {
    const token = await storage.getBearerToken();
    if (token) {
      await fetch(`${API_BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Sign out locally even if the server call fails.
      });
    }
    await storage.clearBearerToken();
    setAuthState({ type: "unauthenticated" });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <UserHeader
        user={user}
        initials={initials}
        onSignOut={handleSignOut}
      />
      <div className="flex-1 overflow-y-auto p-4">
        <MatterPicker onMatterChange={setActiveMatter} />
        <ClipForm activeMatter={activeMatter} />
        <RecentClips />
      </div>
    </div>
  );
};

type UserHeaderProps = {
  user: SessionUser;
  initials: string;
  onSignOut: () => void;
};

const UserHeader = ({
  user,
  initials,
  onSignOut,
}: UserHeaderProps) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {return;}
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        // eslint-disable-next-line typescript/consistent-type-assertions
        !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () =>
      document.removeEventListener(
        "mousedown",
        handleClickOutside,
      );
  }, [open]);

  return (
    <header className="relative flex items-center justify-between border-b border-border px-4 py-2">
      <span className="text-xs font-medium text-muted-foreground">
        stella
      </span>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        {initials}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="absolute right-4 top-10 z-10 w-48 rounded-lg border border-border bg-card p-2 shadow-md"
        >
          <p className="truncate px-2 py-1 text-sm font-medium text-foreground">
            {user.name ?? user.email}
          </p>
          <p className="truncate px-2 pb-2 text-xs text-muted-foreground">
            {user.email}
          </p>
          <div className="border-t border-border pt-1">
            <Button
              variant="ghost"
              className="h-7 w-full justify-start px-2 text-xs"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
};
