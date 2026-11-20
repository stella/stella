import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import * as v from "valibot";

import {
  documentReviewPartiesOptions,
  documentReviewRunsOptions,
} from "@/components/ai-suggestions/document-review-queries";
import { DOCUMENT_PANE_SEARCH_VALUES } from "@/components/inspector/document-pane";
import { getAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME, getNativeOfficeViewerFormat } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { documentPropertiesOptions, fileOptions } from "@/lib/files/queries";
import { PDF_COLOR_MODES } from "@/lib/pdf/pdf-color-mode";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import {
  optionalFlagSearchSchema,
  optionalIntegerSearchSchema,
} from "@/lib/schema";
import { docxSuggestionsOptions } from "@/lib/workspaces/queries/docx-suggestions";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { entityVersionsOptions } from "@/lib/workspaces/queries/entity-versions";
import { justificationsOptions } from "@/lib/workspaces/queries/workspace";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";

import { DocumentPage } from "./-$viewId.document.page";
import { DocumentPagePending } from "./-$viewId.document.pending";
import { loadDocumentEntityWithChatPrefetch } from "./-document-loader";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/document",
)({
  staticData: {
    presentation: routePresentation({ type: "entity", entity: "pdf" }),
  },
  component: DocumentPage,
  // v.object: validateSearch receives the full URL search params
  // including params from parent routes; strictObject would reject them.
  validateSearch: routeSearchSchema({
    entity: v.optional(v.string()),
    field: v.optional(v.string()),
    justification: v.optional(v.string()),
    justificationPage: optionalIntegerSearchSchema({ min: 1 }),
    pdfPage: optionalIntegerSearchSchema({ min: 1 }),
    pdfMode: v.optional(v.picklist(["organize"])),
    pdfColorMode: v.optional(v.picklist(PDF_COLOR_MODES)),
    // Folio block to land on in a DOCX (report citation links). Consumed once
    // on mount through the inspector's pending block scroll.
    block: v.optional(v.string()),
    panel: v.optional(v.picklist(["versions"])),
    editing: optionalFlagSearchSchema,
    // Which pane reads the document review. Absent is the default
    // arrangement: the document here, the review in the inspector.
    pane: v.optional(v.picklist(DOCUMENT_PANE_SEARCH_VALUES)),
  }),
  search: {
    middlewares: [stripSearchParams({ pdfPage: 1 })],
  },
  // The entity query is keyed on the `entity` search param, so the loader must
  // re-run when it changes; `field` gates whether the detail view mounts at all.
  loaderDeps: ({ search }) => ({ entity: search.entity, field: search.field }),
  loader: async ({ context, params, deps }) => {
    // Mirror the component guard: the entity query only runs when both `entity`
    // and `field` are present (otherwise the route redirects without mounting
    // the detail view). Prime it so the fetch starts during navigation instead
    // of after the component mounts and suspends.
    if (!deps.entity || !deps.field) {
      return;
    }
    const entityId = deps.entity;

    const entityPromise = loadDocumentEntityWithChatPrefetch({
      activeOrganizationId: context.user.activeOrganizationId,
      captureError: (error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey:
            "workspaces.workspaceId.viewId.document.loader:failure",
          scope: {
            type: "request",
            method: "GET",
            routeTemplate:
              "/_protected/workspaces/$workspaceId/$viewId/document",
          },
        });
      },
      loadEntity: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          entityOptions(params.workspaceId, entityId),
        ),
      queryClient: context.queryClient,
    });

    // Versions power the inspector and field switching. Start the request at
    // navigation time alongside the entity read so direct document links do
    // not add a component-mount waterfall. A fresh entity-version read is
    // reused through the shared query key and route stale time.
    detached(
      prefetchRouteQuery(
        context.queryClient,
        entityVersionsOptions({
          workspaceId: params.workspaceId,
          entityId: deps.entity,
        }),
        (error: unknown) => {
          getAnalytics().captureError(error, {
            fingerprintKey:
              "workspaces.workspaceId.viewId.document.loader:failure-2",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate:
                "/_protected/workspaces/$workspaceId/$viewId/document",
            },
          });
        },
      ),
      "document.prefetch",
    );

    const entity = await entityPromise;

    // useSyncJustifications mounts with entityIds=[deps.entity] as soon as the
    // component renders; warm the same query so it's a cache hit. The hook
    // normalizes entityIds (dedupe + sort) before building the key, but for a
    // single-element array that's a no-op, so the key matches exactly.
    detached(
      prefetchRouteQuery(
        context.queryClient,
        justificationsOptions({
          workspaceId: params.workspaceId,
          entityIds: [deps.entity],
        }),
        (error: unknown) => {
          getAnalytics().captureError(error, {
            fingerprintKey:
              "workspaces.workspaceId.viewId.document.loader:failure-3",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate:
                "/_protected/workspaces/$workspaceId/$viewId/document",
            },
          });
        },
      ),
      "document.prefetch",
    );

    // `field` is the fieldId FullscreenPdfViewer eventually reads via
    // usePDFStore, but on a cold navigation that store is only just created
    // (PDFProvider seeds it from this same search param, see `key={fieldId}`
    // below), so the value is already known here. Only PDF-family fields
    // render through PdfViewer/fileOptions; docx fields take an entirely
    // different display path (DocxBrowserEditor/fieldFileOptions) that never
    // reads fileOptions, while XLSX/PPTX need their originals. Gate each
    // prefetch on the resolved mimeType so no unused derivative is downloaded.
    const field = entity.fields.find((f) => f.id === deps.field);

    // The DOCX editor hydrates its review store from persisted AI suggestions
    // on open (useSyncDocxSuggestions runs a useQuery on this same key). Warm
    // it here so the request starts during navigation — loader-consistent with
    // the entity/justifications prefetch above and no extra waterfall level —
    // instead of firing on the editor's mount. DOCX fields only; other field
    // types never mount the review surface.
    const isDocxField =
      field?.content.type === "file" && field.content.mimeType === DOCX_MIME;
    if (isDocxField) {
      detached(
        prefetchRouteQuery(
          context.queryClient,
          docxSuggestionsOptions({
            workspaceId: params.workspaceId,
            entityId: deps.entity,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.document.loader:failure-4",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate:
                  "/_protected/workspaces/$workspaceId/$viewId/document",
              },
            });
          },
        ),
        "document.prefetch",
      );

      // Opening the document reads only an existing answer. Detection starts
      // when the reviewer opens the launcher and sees "We act for".
      detached(
        prefetchRouteQuery(
          context.queryClient,
          documentReviewPartiesOptions(
            {
              workspaceId: params.workspaceId,
              entityId: deps.entity,
              fileFieldId: deps.field,
            },
            "cached",
          ),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.document.loader:failure-5",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate:
                  "/_protected/workspaces/$workspaceId/$viewId/document",
              },
            });
          },
        ),
        "document.prefetch",
      );
    }

    // The inspector's metadata facet is the document route's default, so its
    // document-properties read always fires on open. Loader-started, the
    // request runs exactly once; observer-started it lands inside StrictMode's
    // dev-only subscribe churn and fires an aborted duplicate.
    if (field?.content.type === "file") {
      detached(
        prefetchRouteQuery(
          context.queryClient,
          documentPropertiesOptions({
            workspaceId: params.workspaceId,
            fieldId: deps.field,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.document.loader:failure-6",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate:
                  "/_protected/workspaces/$workspaceId/$viewId/document",
              },
            });
          },
        ),
        "document.prefetch",
      );
    }

    const officeViewerFormat =
      field?.content.type === "file"
        ? getNativeOfficeViewerFormat(field.content.mimeType)
        : null;
    if (officeViewerFormat !== null) {
      detached(
        prefetchRouteQuery(
          context.queryClient,
          fileOptions({
            workspaceId: params.workspaceId,
            fieldId: deps.field,
            purpose: "native-display",
          }),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.document.loader:failure-7",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate:
                  "/_protected/workspaces/$workspaceId/$viewId/document",
              },
            });
          },
        ),
        "document.prefetch",
      );
    }

    const rendersInPdfViewer =
      field?.content.type === "file" &&
      field.content.mimeType !== DOCX_MIME &&
      officeViewerFormat === null;
    if (rendersInPdfViewer) {
      // Warm the file query without blocking route commit: a large PDF
      // download shouldn't hold the user on the pendingComponent. The
      // component's useSuspenseQuery scopes the wait to the PDF area.
      detached(
        prefetchRouteQuery(
          context.queryClient,
          fileOptions({ workspaceId: params.workspaceId, fieldId: deps.field }),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.document.loader:failure-8",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate:
                  "/_protected/workspaces/$workspaceId/$viewId/document",
              },
            });
          },
        ),
        "document.prefetch",
      );
    }

    if (isDocxField) {
      // Resolve history before route commit: it seeds the latest run detail
      // and decides which review to restore. Noncritical reads above start
      // before this gate; only DOCX fields mount the review facet.
      await ensureRouteQueryData(
        context.queryClient,
        documentReviewRunsOptions({
          workspaceId: params.workspaceId,
          entityId: deps.entity,
          fileFieldId: deps.field,
        }),
      );
    }
  },
  pendingComponent: DocumentPagePending,
});
