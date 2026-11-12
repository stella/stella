import type { signInSocial, signOut } from "better-auth/api";
import type { emailOTP } from "better-auth/plugins/email-otp";
import type { organization } from "better-auth/plugins/organization";
import { expectTypeOf } from "bun:test";

import type { AuthEndpointBodies } from "@/lib/auth-endpoint-bodies";

// A record as JSON carries it: a `Date` arrives as its ISO string, and a
// property that may be `undefined` may be missing.
type Json<Value> = Value extends Date
  ? string
  : Value extends readonly (infer Item)[]
    ? Json<Item>[]
    : Value extends object
      ? {
          [
            Key in keyof Value as undefined extends Value[Key] ? never : Key
          ]: Json<Value[Key]>;
        } & {
          [
            Key in keyof Value as undefined extends Value[Key] ? Key : never
          ]?: Json<Exclude<Value[Key], undefined>>;
        }
      : Value;

/** What an endpoint resolves to when called without options. */
type Result<Endpoint extends (...args: never[]) => Promise<unknown>> = Json<
  Awaited<ReturnType<Endpoint>>
>;

type Endpoints = ReturnType<typeof emailOTP>["endpoints"] &
  ReturnType<typeof organization>["endpoints"];

// Every mocked body must be a body the library can send: a field it drops,
// renames or newly requires fails here.
expectTypeOf<AuthEndpointBodies["email-otp/send-verification-otp"]>().toExtend<
  Result<Endpoints["sendVerificationOTP"]>
>();
expectTypeOf<AuthEndpointBodies["organization/list"]>().toExtend<
  Result<Endpoints["listOrganizations"]>
>();
expectTypeOf<AuthEndpointBodies["sign-in/social"]>().toExtend<
  Result<ReturnType<typeof signInSocial>>
>();
expectTypeOf<AuthEndpointBodies["sign-out"]>().toExtend<
  Result<typeof signOut>
>();
