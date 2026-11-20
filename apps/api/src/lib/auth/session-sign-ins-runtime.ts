import { rootDb } from "@/api/db/root";
import {
  createSessionSignInStore,
  type SessionSignInStore,
} from "@/api/lib/auth/session-sign-ins";

let store: SessionSignInStore | undefined;

/**
 * The process-wide sign-in store. Session rows are auth data outside row
 * security, so it binds the owner connection; every query scopes itself to
 * the authenticated user's own sessions.
 */
export const getSessionSignInStore = (): SessionSignInStore =>
  (store ??= createSessionSignInStore({ database: rootDb }));
