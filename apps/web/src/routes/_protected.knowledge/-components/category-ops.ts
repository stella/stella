import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import type { ToAPIErrorProps } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import type {
  CategoryEntity,
  CategoryOps,
} from "@/routes/_protected.knowledge/-components/category-sidebar";

type CategoryRequestResult<TData> =
  | { data: TData; error: null }
  | { data: null; error: ToAPIErrorProps };

type CategoryRequests = {
  create: (name: string) => Promise<CategoryRequestResult<CategoryEntity>>;
  rename: (id: string, name: string) => Promise<CategoryRequestResult<unknown>>;
  remove: (id: string) => Promise<CategoryRequestResult<unknown>>;
};

type UseCategoryOpsOptions = {
  deleteFailedTitle: string;
  requests: CategoryRequests;
  saveFailedTitle: string;
};

/** Category CRUD over a feature's own API routes. Each op surfaces its own
 *  error toast and resolves to the shared `CategoryOps` contract (created
 *  category or `null`; success boolean). */
export const useCategoryOps = ({
  deleteFailedTitle,
  requests,
  saveFailedTitle,
}: UseCategoryOpsOptions): CategoryOps => {
  const t = useTranslations();

  const toastFailure = (title: string, error: ToAPIErrorProps) => {
    stellaToast.add({
      type: "error",
      title,
      description: userErrorMessage(error, t("common.unexpectedError")),
    });
  };

  return {
    create: async (name) => {
      const response = await requests.create(name);
      if (response.error) {
        toastFailure(saveFailedTitle, response.error);
        return null;
      }
      return { id: response.data.id, name: response.data.name };
    },
    rename: async (id, name) => {
      const response = await requests.rename(id, name);
      if (response.error) {
        toastFailure(saveFailedTitle, response.error);
        return false;
      }
      return true;
    },
    remove: async (id) => {
      const response = await requests.remove(id);
      if (response.error) {
        toastFailure(deleteFailedTitle, response.error);
        return false;
      }
      return true;
    },
  };
};
