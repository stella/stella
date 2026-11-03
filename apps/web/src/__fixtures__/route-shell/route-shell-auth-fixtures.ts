import type { AuthCapabilities } from "@/components/auth/sign-in-panel.logic";
import type { api } from "@/lib/api";
import type { authClient } from "@/lib/auth-client";
import type { Route as InvitationRoute } from "@/routes/auth/accept-invitation.$invitationId";
import type { Route as ErrorRoute } from "@/routes/auth/error";
import type { Route as OrganizationRoute } from "@/routes/auth/organization";
import type { Route as OtpRoute } from "@/routes/auth/otp";

const userId = "user-fixture";
const organizationId = "org-fixture";

/** Leaf guards are bypassed by the shell fixture; these are their consumed outputs. */
export const authFixtureBeforeLoadData = (routeId: string, email: string) => {
  switch (routeId) {
    case "/auth/otp":
      return { otpEmail: email } satisfies Awaited<
        ReturnType<NonNullable<typeof OtpRoute.options.beforeLoad>>
      >;
    case "/auth/organization":
      return { userId, isOauthPostLoginFromSearch: false } satisfies Awaited<
        ReturnType<NonNullable<typeof OrganizationRoute.options.beforeLoad>>
      >;
    case "/auth/professional-use":
    case "/agent-claim":
    case "/consent":
      return { userId };
    default:
      return undefined;
  }
};

const invitation = {
  id: "invitation-fixture",
  email: "member@example.test",
  inviterId: userId,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  expiresAt: new Date("2099-10-01T00:00:00.000Z"),
  organizationSlug: "fixture-organization",
  organizationId,
  organizationName: "Fixture organization",
  inviterEmail: "member@example.test",
  role: "member",
  status: "pending",
} as const satisfies NonNullable<
  Awaited<ReturnType<typeof authClient.organization.getInvitation>>["data"]
>;

export const authFixtureLoaderData = (routeId: string) => {
  switch (routeId) {
    case "/auth/otp":
      return { devOtp: null } satisfies typeof OtpRoute.types.loaderData;
    case "/auth/error":
      return {
        method: null,
        provider: null,
      } satisfies typeof ErrorRoute.types.loaderData;
    case "/auth/accept-invitation/$invitationId":
      return { invitation } satisfies typeof InvitationRoute.types.loaderData;
    default:
      return undefined;
  }
};

const capabilities = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: { google: false, microsoft: false, apple: false },
} satisfies AuthCapabilities;

const organizations = [
  {
    id: organizationId,
    name: "Fixture organization",
    slug: "fixture-organization",
    logo: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  },
  {
    id: "org-fixture-second",
    name: "Second fixture organization",
    slug: "fixture-organization-second",
    logo: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  },
] satisfies NonNullable<
  Awaited<ReturnType<typeof authClient.organization.list>>["data"]
>;

export const authFixtureResponse = (pathname: string): Response | undefined => {
  switch (pathname) {
    case "/dev-public/last-otp":
      return Response.json({ otp: "123456" });
    case "/v1/auth/capabilities":
      return Response.json(capabilities);
    case "/api/auth/organization/list":
      return Response.json(organizations);
    case "/v1/catalogue/native-tool-deploy-availability":
      return Response.json({
        unavailableNativeToolBackendSlugs: [],
      } satisfies NonNullable<
        Awaited<
          ReturnType<
            (typeof api.catalogue)["native-tool-deploy-availability"]["get"]
          >
        >["data"]
      >);
    default:
      return undefined;
  }
};
