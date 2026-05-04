import { cn } from "@stll/ui/lib/utils";

import { primaryCapabilities } from "../../data/capabilities";

export default function ProductShowcase() {
  return (
    <div className="w-full">
      <div className="showcase-grid flex snap-x snap-mandatory gap-4 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:items-start md:overflow-visible md:pb-0">
        {primaryCapabilities.map((item) => (
          <article
            className="showcase-tile min-w-[82%] snap-center self-start transition-[opacity,transform] duration-300 ease-out sm:min-w-[20rem] md:min-w-0"
            key={item.title}
          >
            <div
              className={cn(
                "group border-border/45 relative flex aspect-[0.75] min-h-[20rem] items-center justify-center overflow-hidden rounded-[1.45rem] border bg-[color-mix(in_srgb,var(--background)_90%,var(--auth-gradient-end)_10%)] shadow-[0_14px_34px_-28px_rgba(0,0,0,0.16)] transition-[border-color,box-shadow,transform] duration-300 ease-out sm:min-h-[24rem]",
              )}
              data-showcase-shell
            >
              <div className="p-4">
                <img
                  src={`/images/${item.screenshotName}`}
                  alt=""
                  className="h-full w-full rounded-xl object-contain"
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-black/4 transition-opacity duration-300 group-hover:opacity-70 dark:ring-white/6" />
              <div className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <div className="absolute inset-x-6 top-0 h-24 rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.36),rgba(255,255,255,0))] blur-2xl dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0))]" />
                <div className="absolute inset-0 rounded-[inherit] ring-1 ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_56%,white_44%)] dark:ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_52%,white_16%)]" />
              </div>
            </div>

            <div className="px-1 pt-4">
              <h3 className="showcase-title text-base font-medium tracking-tight transition-colors duration-300">
                {item.title}
              </h3>
              <p className="showcase-description text-muted-foreground mt-2 text-sm leading-6 transition-colors duration-300">
                {item.description}
              </p>
            </div>
          </article>
        ))}
      </div>

      <style>{`
        @media (hover: hover) and (pointer: fine) {
          .showcase-grid:hover .showcase-tile {
            opacity: 0.88;
          }
          .showcase-grid:hover .showcase-tile:hover,
          .showcase-grid:hover .showcase-tile:focus-within {
            opacity: 1;
            transform: translateY(-1px);
          }
          .showcase-grid:hover .showcase-tile .showcase-title {
            color: color-mix(in srgb, var(--foreground) 74%, var(--muted-foreground) 26%);
          }
          .showcase-grid:hover .showcase-tile .showcase-description {
            color: color-mix(in srgb, var(--muted-foreground) 92%, transparent);
          }
          .showcase-grid:hover .showcase-tile:hover .showcase-title,
          .showcase-grid:hover .showcase-tile:focus-within .showcase-title {
            color: var(--foreground);
          }
          .showcase-grid:hover .showcase-tile:hover .showcase-description,
          .showcase-grid:hover .showcase-tile:focus-within .showcase-description {
            color: color-mix(in srgb, var(--foreground) 72%, var(--muted-foreground) 28%);
          }
          .showcase-grid:hover .showcase-tile:hover [data-showcase-shell],
          .showcase-grid:hover .showcase-tile:focus-within [data-showcase-shell] {
            border-color: color-mix(in srgb, var(--auth-gradient-end) 50%, var(--border) 50%);
            box-shadow: 0 18px 38px -30px rgba(0, 0, 0, 0.22);
          }
        }
      `}</style>
    </div>
  );
}
