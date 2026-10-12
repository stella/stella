import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import { professionalUseOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { redirectToSchema } from "@/lib/redirect";
import { ProfessionalUsePanel } from "@/routes/auth/-components/professional-use-panel";

const searchSchema = v.strictObject({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/professional-use")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, location, search }) => {
    if (!context.session) {
      redirect({
        to: "/auth",
        search: { redirectTo: location.pathname + location.searchStr },
        replace: true,
        throw: true,
      });
      return panic("TanStack Router did not throw the sign-in redirect.");
    }
    const userId = context.session.userId;
    const professionalUse = await ensureRouteQueryData(
      context.queryClient,
      professionalUseOptions(userId),
    );
    switch (professionalUse.status) {
      case PROFESSIONAL_USE_STATUS.required:
        return { userId };
      case PROFESSIONAL_USE_STATUS.accepted:
        redirect({ to: search.redirectTo, replace: true, throw: true });
        return panic("TanStack Router did not throw the continue redirect.");
      default:
        professionalUse satisfies never;
        return panic("Unhandled professional-use state");
    }
  },
  component: ProfessionalUse,
});

function ProfessionalUse() {
  const userId = Route.useRouteContext({ select: (context) => context.userId });
  const redirectTo = Route.useSearch({ select: (search) => search.redirectTo });
  return <ProfessionalUsePanel redirectTo={redirectTo} userId={userId} />;
}
