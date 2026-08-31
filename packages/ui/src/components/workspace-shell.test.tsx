import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { WorkspaceEndRail, WorkspaceShell } from "./workspace-shell";

describe("WorkspaceShell", () => {
  test("owns sibling rails, sticky chrome, and one content scroller", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell
        endDock={<aside data-test="end-dock">Inspector</aside>}
        navigation={{
          content: <nav data-test="navigation">Navigation</nav>,
          mode: "responsive",
        }}
        topBar={() => <header data-test="top-bar">Header</header>}
      >
        <article data-test="content">Content</article>
      </WorkspaceShell>,
    );

    expect(markup).toMatch(
      /<nav data-test="navigation">Navigation<\/nav><main[^>]*data-slot="workspace-shell-main"[^>]*>.*<header data-test="top-bar">Header<\/header>.*<article data-test="content">Content<\/article>.*<\/main><aside data-test="end-dock">Inspector<\/aside>/su,
    );
    expect(markup).toContain("flex h-dvh min-h-0 w-full overflow-hidden");
    expect(markup).toContain('data-slot="workspace-shell-top-bar"');
    expect(markup).toContain("sticky top-0 z-20 shrink-0");
    expect(markup).toContain('data-slot="workspace-shell-content"');
  });

  test("owns a controlled compact navigation without mounting its portal on desktop", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell
        endDock={<aside>Inspector</aside>}
        navigation={{
          compact: {
            content: <nav>Compact navigation</nav>,
            label: "Open navigation",
            onOpenChange: () => undefined,
            open: true,
            trigger: <button type="button">Menu</button>,
          },
          desktop: <nav data-test="desktop-navigation">Desktop</nav>,
          mode: "shell-managed",
        }}
        topBar={({ compactNavigationTrigger }) => (
          <header>{compactNavigationTrigger}Header</header>
        )}
      >
        <article>Content</article>
      </WorkspaceShell>,
    );

    expect(markup).toContain('data-test="desktop-navigation"');
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).toContain("Menu");
    expect(markup).not.toContain("Compact navigation");
    expect(markup).not.toContain('data-slot="sheet-backdrop"');
  });

  test("does not render a dead compact trigger when the host has no compact navigation", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell
        endDock={<aside>Inspector</aside>}
        navigation={{
          compact: {
            content: <nav>Compact navigation</nav>,
            label: "Open navigation",
            onOpenChange: () => undefined,
            open: false,
            trigger: null,
          },
          desktop: <nav data-test="desktop-navigation">Desktop</nav>,
          mode: "shell-managed",
        }}
        topBar={({ compactNavigationTrigger }) => (
          <header>{compactNavigationTrigger}Header</header>
        )}
      >
        <article>Content</article>
      </WorkspaceShell>,
    );

    expect(markup).toContain('data-test="desktop-navigation"');
    expect(markup).toContain("Header");
    expect(markup).not.toContain('aria-label="Open navigation"');
  });
});

describe("WorkspaceEndRail", () => {
  test("pins a working chat action after the scrolling rail content", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceEndRail
        chatAction={{
          label: "New chat",
          onActivate: () => undefined,
          status: "enabled",
        }}
        label="Workspace inspector"
        overlay={<div data-test="overlay">Menu</div>}
        topAction={<button type="button">Toggle pane</button>}
      >
        <button type="button">Document tab</button>
      </WorkspaceEndRail>,
    );

    expect(markup).toContain('aria-label="Workspace inspector"');
    expect(markup).toMatch(
      /data-slot="inspector-rail-cell"[^>]*>.*Toggle pane.*data-slot="inspector-rail-content"[^>]*>.*Document tab.*data-slot="inspector-rail-footer"[^>]*>.*aria-label="New chat"/su,
    );
    expect(markup).toMatch(
      /data-slot="inspector-rail-content"[^>]*>.*<\/div><div data-test="overlay">Menu<\/div><div[^>]*data-slot="inspector-rail-footer"/su,
    );
    expect(markup).toContain("size-11");
    expect(markup).not.toContain('disabled=""');
  });

  test("fails closed with a visible reason and no activation handler", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceEndRail
        chatAction={{
          label: "New chat",
          reason: "AI provider is unavailable",
          status: "unavailable",
        }}
        label="Workspace inspector"
        topAction={null}
      />,
    );

    expect(markup).toContain(
      'aria-label="New chat: AI provider is unavailable"',
    );
    expect(markup).toContain('title="AI provider is unavailable"');
    expect(markup).toContain("disabled");
  });
});
