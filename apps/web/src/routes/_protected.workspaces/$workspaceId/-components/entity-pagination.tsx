import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@stella/ui/components/pagination";

type EntityPaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

/**
 * Computes which page numbers to display.
 * Always shows first, last, and up to 2 pages around current.
 * Fills gaps with ellipsis markers (represented as null).
 */
type PageEntry =
  | { type: "page"; page: number }
  | { type: "ellipsis"; key: string };

const getPageNumbers = (current: number, total: number): PageEntry[] => {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => ({
      type: "page" as const,
      page: i + 1,
    }));
  }

  const pages: PageEntry[] = [{ type: "page", page: 1 }];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) {
    pages.push({ type: "ellipsis", key: "start" });
  }

  for (let i = start; i <= end; i++) {
    pages.push({ type: "page", page: i });
  }

  if (end < total - 1) {
    pages.push({ type: "ellipsis", key: "end" });
  }

  pages.push({ type: "page", page: total });
  return pages;
};

export const EntityPagination = ({
  page,
  totalPages,
  onPageChange,
}: EntityPaginationProps) => {
  const pageNumbers = getPageNumbers(page, totalPages);

  return (
    <Pagination className="border-t py-2">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            aria-disabled={page === 1}
            className={
              page === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"
            }
            onClick={() => {
              if (page > 1) {
                onPageChange(page - 1);
              }
            }}
          />
        </PaginationItem>
        {pageNumbers.map((entry) =>
          entry.type === "ellipsis" ? (
            <PaginationItem key={entry.key}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={entry.page}>
              <PaginationLink
                className="cursor-pointer"
                isActive={entry.page === page}
                onClick={() => onPageChange(entry.page)}
              >
                {entry.page}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext
            aria-disabled={page === totalPages}
            className={
              page === totalPages
                ? "pointer-events-none opacity-50"
                : "cursor-pointer"
            }
            onClick={() => {
              if (page < totalPages) {
                onPageChange(page + 1);
              }
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
};
