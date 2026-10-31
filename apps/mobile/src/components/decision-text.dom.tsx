"use dom";

import { Fragment, useEffect } from "react";
import type { MouseEvent, ReactNode } from "react";

import dmSansRegular from "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf";
import dmSansMedium from "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf";
import dmSansSemiBold from "@expo-google-fonts/dm-sans/600SemiBold/DMSans_600SemiBold.ttf";
import { panic } from "better-result";
import type { DOMProps } from "expo/dom";

import { bundledFontUrl, useDomAppearance } from "@/components/dom-theme";
import type { DomAppearance } from "@/components/dom-theme";
import type { ReaderBlock, ReaderRun } from "@/state/decision-document";
import type { DecisionPage } from "@/state/decision-page";

type DecisionTextProps = {
  page: DecisionPage;
  /** The app's appearance, which sets the web view's `dark` class. */
  appearance: DomAppearance;
  /** The person's text size, as the platform scales the app's own text. */
  textScale: number;
  /**
   * A link in the page was tapped: the app opens it, so the web view itself
   * never leaves the decision.
   */
  onLink: (href: string) => void;
  dom?: DOMProps;
};

/**
 * A court decision as the reader shows it, set as a web page so it selects
 * as text does in Safari: any range, across paragraphs, with the system's
 * Copy, Look Up, Translate and Share. The app keeps the screen's header and
 * opens every link.
 */
const DecisionText = ({
  page,
  appearance,
  textScale,
  onLink,
}: DecisionTextProps) => {
  useDomAppearance(appearance);

  useEffect(() => {
    document.documentElement.style.fontSize = `${String(16 * textScale)}px`;
  }, [textScale]);

  // One listener for every link, so the page carries data and no handlers.
  const follow = (event: MouseEvent<HTMLElement>) => {
    const anchor =
      event.target instanceof Element ? event.target.closest("a") : null;
    const href = anchor?.getAttribute("href") ?? null;
    if (href === null) {
      return;
    }
    event.preventDefault();
    onLink(href);
  };

  return (
    <>
      <style>{STYLES}</style>
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- delegates the links' own activation */}
      <article className="reader" onClick={follow}>
        <header className="decision">
          <div className="identity">
            <h1>{page.caseNumber}</h1>
            <p className="caption">{page.details.join(" · ")}</p>
            {page.ecli === null ? null : <p className="caption">{page.ecli}</p>}
          </div>
          {page.headnote === null ? null : (
            <section className="headnote">
              <h2>{page.headnote.label}</h2>
              <p className="reading">{page.headnote.text}</p>
            </section>
          )}
        </header>
        {page.blocks.length === 0 ? (
          <div className="unavailable">
            <p className="caption">{page.unavailable}</p>
            {page.source === null ? null : <SourceLink {...page.source} />}
          </div>
        ) : (
          <>
            {page.blocks.map((block) => (
              <Block block={block} key={block.id} />
            ))}
            {page.source === null ? null : (
              <footer className="source">
                <SourceLink {...page.source} />
              </footer>
            )}
          </>
        )}
      </article>
    </>
  );
};

const Block = ({ block }: { block: ReaderBlock }) => {
  switch (block.kind) {
    case "heading": {
      const Heading = block.level <= 2 ? "h2" : "h3";
      return (
        <Heading
          className={`text-heading ${block.level <= 2 ? "major" : "minor"}`}
        >
          <Runs runs={block.runs} />
        </Heading>
      );
    }
    case "paragraph":
      return (
        <p
          className="reading"
          style={{
            paddingInlineStart: (block.depth + (block.quote ? 1 : 0)) * INDENT,
          }}
        >
          {block.number === null ? null : (
            <strong>{`${block.number}. `}</strong>
          )}
          <Runs runs={block.runs} />
        </p>
      );
    case "table":
      return (
        <table className="table">
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => (
                  <td className="caption" key={cell.id}>
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    default:
      block satisfies never;
      return panic("Unhandled reader block");
  }
};

const Runs = ({ runs }: { runs: readonly ReaderRun[] }) =>
  runs.map((run) => {
    let text: ReactNode = run.text;
    if (run.emphasis) {
      text = <em>{text}</em>;
    }
    if (run.strong) {
      text = <strong>{text}</strong>;
    }
    return run.href === null ? (
      <Fragment key={run.id}>{text}</Fragment>
    ) : (
      <a href={run.href} key={run.id}>
        {text}
      </a>
    );
  });

const SourceLink = ({ label, href }: { label: string; href: string }) => (
  <a className="source-link" href={href}>
    {label}
  </a>
);

/** Points a list level or a quotation is set in from the margin. */
const INDENT = 16;

/** The app's interface face, DM Sans, from the files the app bundles. */
const fontFace = (source: unknown, weight: number): string => {
  const url = bundledFontUrl(source);
  return url === null
    ? ""
    : `@font-face{font-family:"DM Sans";font-weight:${String(weight)};font-display:swap;src:url(${JSON.stringify(url)}) format("truetype");}`;
};

/**
 * The reader's sizes, leading and spacing as the native text and the list
 * it replaces set them (packages/ui text.shared.ts), in `rem` so they follow
 * `textScale`, and every colour a stella token.
 */
const STYLES = `${fontFace(dmSansRegular, 400)}${fontFace(dmSansMedium, 500)}${fontFace(dmSansSemiBold, 600)}
html{-webkit-text-size-adjust:100%;background:var(--background);}
body{margin:0;background:var(--background);color:var(--foreground);-webkit-tap-highlight-color:transparent;}
.reader{box-sizing:border-box;display:flex;flex:1;flex-direction:column;gap:20px;width:100%;min-width:0;max-width:960px;margin:0 auto;padding:24px 16px 16px;font-family:"DM Sans",system-ui,sans-serif;font-size:1rem;line-height:1.5rem;overflow-wrap:break-word;-webkit-user-select:text;user-select:text;}
.reader h1,.reader h2,.reader h3,.reader p{margin:0;}
.reader a{color:inherit;text-decoration:underline;text-decoration-color:var(--muted-foreground);text-underline-offset:0.15em;-webkit-touch-callout:none;}
.decision{display:flex;flex-direction:column;gap:16px;padding-bottom:20px;}
.identity{display:flex;flex-direction:column;gap:4px;}
.identity h1{font-size:1.5rem;line-height:2rem;font-weight:600;}
.caption{font-size:0.875rem;line-height:1.25rem;color:var(--muted-foreground);}
.headnote{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--card);}
.headnote h2{font-size:0.75rem;line-height:1rem;font-weight:500;text-transform:uppercase;color:var(--muted-foreground);}
.reading{font-family:Georgia,serif;font-size:1rem;line-height:1.625rem;white-space:pre-line;}
.reader .text-heading{font-size:1.125rem;line-height:1.75rem;font-weight:600;}
.text-heading.major{padding:24px 0 8px;}
.text-heading.minor{padding:16px 0 4px;}
.reader>p.reading{padding-bottom:16px;}
.table{width:100%;margin-bottom:16px;border:1px solid var(--border);border-radius:8px;border-collapse:separate;border-spacing:0;table-layout:fixed;}
.table td{padding:8px 6px;vertical-align:top;}
.table td:first-child{padding-inline-start:12px;}
.table td:last-child{padding-inline-end:12px;}
.table tr+tr td{border-top:1px solid var(--border);}
.unavailable{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding-top:24px;}
.source{margin-top:24px;padding-top:12px;border-top:1px solid var(--border);}
.reader a.source-link{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid var(--input);border-radius:8px;background:var(--popover);color:var(--foreground);font-size:0.875rem;font-weight:500;text-decoration:none;}`;

export default DecisionText;
