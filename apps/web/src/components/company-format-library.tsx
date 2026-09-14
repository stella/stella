import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldControl, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";

import { REGISTRY_DEFAULT_FORMAT } from "@/components/templates/registry-format-config";
import type { LookupRegistryOption } from "@/components/templates/registry-options";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { stringCursorSeed } from "@/lib/infinite-query";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

const FORMAT_PAGE_SIZE = 25;
const FORMAT_NAME_MAX_LENGTH = 120;
const BUILT_IN_FORMAT_ID = "built-in";
const companyFormatKeys = {
  list: ({
    organizationId,
    registry,
  }: {
    organizationId: string;
    registry: LookupRegistryOption["slug"];
  }) => ["company-output-formats", organizationId, registry] as const,
};

export const useCompanyFormatLibrary = ({
  registry,
  draftFormat,
  onSelect,
}: {
  registry: LookupRegistryOption["slug"];
  draftFormat: string | null;
  onSelect: (format: string) => void;
}) => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const canCreate = usePermissions({ template: ["create"] });
  const canUpdate = usePermissions({ template: ["update"] });
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryKey = companyFormatKeys.list({
    organizationId: activeOrganizationId,
    registry,
  });
  const saved = useInfiniteQuery({
    queryKey,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.templates["lookup-formats"].get({
          query: {
            registry,
            limit: FORMAT_PAGE_SIZE,
            ...(pageParam !== undefined && { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const firstPage = saved.data?.pages.at(0);
  const defaultFormat = firstPage?.defaultFormat ?? null;
  const userDefaultFormat = firstPage?.userDefaultFormat ?? null;
  const pageFormats = saved.data
    ? saved.data.pages.flatMap((page) => page.items)
    : [];
  // Both defaults come back whole, so either is selectable even when its row
  // sits on a page the picker has not fetched. They lead the list in the order
  // they take effect, and the same row chosen twice is listed once.
  const pinned: typeof pageFormats = [];
  for (const candidate of [userDefaultFormat, defaultFormat]) {
    if (candidate && !pinned.some((item) => item.id === candidate.id)) {
      pinned.push(candidate);
    }
  }
  const pinnedIds = new Set(pinned.map((item) => item.id));
  const formats = [
    ...pinned,
    ...pageFormats.filter((item) => !pinnedIds.has(item.id)),
  ];
  const effectiveDefault = userDefaultFormat ?? defaultFormat;
  const format =
    draftFormat ??
    effectiveDefault?.format ??
    REGISTRY_DEFAULT_FORMAT[registry];
  const selected = formats.find(
    (item) =>
      item.id === (selectedId ?? effectiveDefault?.id) &&
      item.format === format,
  );
  const builtIn = !selected && format === REGISTRY_DEFAULT_FORMAT[registry];
  const choose = (id: string | null) => {
    if (id === BUILT_IN_FORMAT_ID) {
      setSelectedId(BUILT_IN_FORMAT_ID);
      onSelect(REGISTRY_DEFAULT_FORMAT[registry]);
      return;
    }
    const item = formats.find((candidate) => candidate.id === id);
    if (item) {
      setSelectedId(item.id);
      onSelect(item.format);
    }
  };
  const onError = (error: unknown) => {
    getAnalytics().captureError(error);
    stellaToast.error(userErrorFromThrown(error, t("templates.saveFailed")));
  };
  const create = useMutation({
    mutationFn: async (draft: { name: string; format: string }) =>
      unwrapEden(
        await api.templates["lookup-formats"].post({ registry, ...draft }),
      ),
    onSuccess: async (item) => {
      setSelectedId(item.id);
      onSelect(item.format);
      setName("");
      stellaToast.success(t("templates.lookupFormatSaved"));
      await queryClient.invalidateQueries({ queryKey });
    },
    onError,
  });
  const setDefault = useMutation({
    mutationFn: async (formatId: NonNullable<typeof selected>["id"] | null) =>
      unwrapEden(
        await api.templates["lookup-formats"].default.post({
          registry,
          formatId,
        }),
      ),
    onSuccess: async () => {
      stellaToast.success(t("templates.lookupFormatSaved"));
      await queryClient.invalidateQueries({ queryKey });
    },
    onError,
  });
  // No permission gate: a personal default changes nothing a colleague sees.
  const setMyDefault = useMutation({
    mutationFn: async (formatId: NonNullable<typeof selected>["id"] | null) =>
      unwrapEden(
        await api.templates["lookup-formats"]["my-default"].post({
          registry,
          formatId,
        }),
      ),
    onSuccess: async () => {
      stellaToast.success(t("templates.lookupFormatSaved"));
      await queryClient.invalidateQueries({ queryKey });
    },
    onError,
  });
  return {
    saved,
    formats,
    defaultFormat,
    userDefaultFormat,
    selected,
    builtIn,
    format,
    choose,
    create,
    setDefault,
    setMyDefault,
    name,
    setName,
    canCreate,
    canUpdate,
  };
};

type CompanyFormatLibraryProps = {
  library: ReturnType<typeof useCompanyFormatLibrary>;
};

export const CompanyFormatPicker = ({ library }: CompanyFormatLibraryProps) => {
  const t = useTranslations();
  return (
    <Select
      value={
        library.selected?.id ?? (library.builtIn ? BUILT_IN_FORMAT_ID : null)
      }
      onValueChange={library.choose}
    >
      <SelectTrigger
        className="min-h-11 max-w-64 min-w-0"
        aria-label={t("templates.savedLookupFormats")}
        disabled={library.saved.isPending}
      >
        <SelectValue placeholder={t("templates.fieldLookupFormatTemplate")} />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={BUILT_IN_FORMAT_ID}>
          {t("templates.builtInLookupFormat")}
        </SelectItem>
        {library.formats.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
            {item.id === library.defaultFormat?.id && (
              <span className="text-muted-foreground ms-2 text-xs">
                {t("templates.defaultLookupFormat")}
              </span>
            )}
            {/* Only where the two disagree: labelling one row twice says
                nothing the organization badge has not already said. */}
            {item.id === library.userDefaultFormat?.id &&
              item.id !== library.defaultFormat?.id && (
                <span className="text-muted-foreground ms-2 text-xs">
                  {t("templates.myDefaultLookupFormat")}
                </span>
              )}
          </SelectItem>
        ))}
        {library.saved.hasNextPage && (
          <Button
            variant="ghost"
            disabled={library.saved.isFetchingNextPage}
            onClick={() =>
              detached(
                library.saved.fetchNextPage(),
                "company-formats.load-more",
              )
            }
          >
            {t("common.loadMore")}
          </Button>
        )}
      </SelectPopup>
    </Select>
  );
};

export const CompanyFormatLibrary = ({
  library,
}: CompanyFormatLibraryProps) => {
  const t = useTranslations();
  const isDefault = library.selected
    ? library.selected.id === library.defaultFormat?.id
    : library.builtIn && library.defaultFormat === null;
  // The built-in entry is how a personal default is given up, so its button
  // clears rather than sets; with nothing to clear it has nothing to do.
  const isMyDefault =
    library.selected !== undefined &&
    library.selected.id === library.userDefaultFormat?.id;
  const clearsMyDefault = library.builtIn;
  // Translated per branch: a key union handed to `t` is too wide to type.
  const myDefaultLabel = (() => {
    if (isMyDefault) {
      return t("templates.myDefaultLookupFormat");
    }
    return clearsMyDefault
      ? t("templates.clearMyLookupFormatDefault")
      : t("templates.useAsMyLookupFormatDefault");
  })();
  const choosable = library.selected !== undefined || library.builtIn;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {t("templates.lookupFormatsSharedHint")}
      </p>
      {choosable && (
        <div className="flex flex-wrap gap-2">
          {library.canUpdate && (
            <Button
              size="sm"
              variant="outline"
              disabled={isDefault || library.setDefault.isPending}
              onClick={() =>
                library.setDefault.mutate(library.selected?.id ?? null)
              }
            >
              {isDefault
                ? t("templates.defaultLookupFormat")
                : t("billing.rates.setAsDefault")}
            </Button>
          )}
          {/* Ungated: this is the caller's own preference, not the firm's. */}
          <Button
            size="sm"
            variant="outline"
            disabled={
              isMyDefault ||
              (clearsMyDefault && library.userDefaultFormat === null) ||
              library.setMyDefault.isPending
            }
            onClick={() =>
              library.setMyDefault.mutate(library.selected?.id ?? null)
            }
          >
            {myDefaultLabel}
          </Button>
        </div>
      )}
      {library.canCreate && (
        <div className="flex items-end gap-2">
          <Field className="min-w-0 flex-1">
            <FieldLabel>{t("templates.fieldLookupFormatKey")}</FieldLabel>
            <FieldControl
              render={
                <Input
                  value={library.name}
                  onChange={(event) => library.setName(event.target.value)}
                  maxLength={FORMAT_NAME_MAX_LENGTH}
                  disabled={library.create.isPending}
                />
              }
            />
          </Field>
          <Button
            disabled={
              library.create.isPending ||
              library.name.trim() === "" ||
              library.format.trim() === ""
            }
            onClick={() =>
              library.create.mutate({
                name: library.name.trim(),
                format: library.format,
              })
            }
          >
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
};
