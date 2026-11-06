import { APIError } from "@/lib/errors/api";

type SellerSelection =
  | { type: "all" }
  | { type: "profile"; name: string }
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "error" };

type SellerSelectionOptions = {
  value: string | null;
  profileName: string | undefined;
  error: unknown;
};

export const sellerSelection = ({
  value,
  profileName,
  error,
}: SellerSelectionOptions): SellerSelection => {
  if (value === null) {
    return { type: "all" };
  }
  // The active-profile endpoint returns 404 for an archived seller too.
  if (APIError.is(error) && error.status === 404) {
    return { type: "unavailable" };
  }
  if (error !== null) {
    return { type: "error" };
  }
  if (profileName !== undefined) {
    return { type: "profile", name: profileName };
  }
  return { type: "loading" };
};
