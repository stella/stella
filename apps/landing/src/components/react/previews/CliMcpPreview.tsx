import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { StellaMark } from "@stll/ui/components/stella-mark";
import { cn } from "@stll/ui/lib/utils";

import { CLI_DEMO_TOOLS } from "../../../data/cli-demo";
import {
  openingProductStory,
  type ProductStorySceneId,
  type ProductStoryWindowId,
  storyTeamsExchange,
} from "../../../data/product-story";
import { RecordedStellaScene } from "../product-story/RecordedStellaScene";

export const CliMcpPreview = ({
  backdrop = "wash",
  discoverLabel,
  initialScenarioId = "search",
  includeStyles = true,
  revealSideWindowsOnScroll = false,
  sceneId,
  showCompanions = true,
}: CliMcpPreviewProps) => {
  const [activeWindow, setActiveWindow] = useState(getInitialActiveWindow);
  const [hasManualWindowFocus, setHasManualWindowFocus] = useState(false);
  const [isAutoPlaying] = useState(() => sceneId === undefined);
  const [isInViewport, setIsInViewport] = useState(false);
  const [positions, setPositions] = useState<
    Record<DraggableWindow, { x: number; y: number }>
  >(() => ({
    client: { x: 0, y: 0 },
    source: { x: 0, y: 0 },
    terminal: { x: 0, y: 0 },
  }));
  const [storyFrame, setStoryFrame] = useState(0);
  const [teamsLoopFrame, setTeamsLoopFrame] = useState(0);
  const [terminalLoopFrame, setTerminalLoopFrame] = useState(0);
  const [selectedWindow, setSelectedWindow] = useState<PreviewWindow | null>(
    null,
  );
  const drag = useRef<DragState | null>(null);
  const selectionClearTimer = useRef<number | null>(null);
  const story = useRef<HTMLDivElement>(null);
  const initialScenarioIndex = Math.max(
    SCENARIOS.findIndex((scenario) => scenario.id === initialScenarioId),
    0,
  );
  const activeScenario =
    SCENARIOS[
      (initialScenarioIndex + (isAutoPlaying ? terminalLoopFrame : 0)) %
        SCENARIOS.length
    ] ?? SCENARIOS[0];
  const storyStep = storyFrame % STORY_PHASES.length;
  const storyPhase = STORY_PHASES.at(storyStep) ?? STORY_PHASES[0];
  const activeSceneId = sceneId ?? storyPhase.sceneId;
  const focusedWindow = getFocusedWindow({
    activeWindow,
    focus: storyPhase.focus,
    hasManualWindowFocus,
    isAutoPlaying,
    showCompanions,
  });

  useEffect(() => {
    const element = story.current;
    if (!element) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => setIsInViewport(entries.at(0)?.isIntersecting ?? false),
      { threshold: 0.12 },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (
      !isAutoPlaying ||
      !isInViewport ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      setStoryFrame((currentFrame) => currentFrame + 1);
    }, storyPhase.durationMs);

    return () => window.clearTimeout(timeout);
  }, [isAutoPlaying, isInViewport, storyPhase.durationMs, storyPhase.id]);

  useEffect(() => {
    if (
      !showCompanions ||
      !isInViewport ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return undefined;
    }

    const durationMs = teamsLoopFrame % 2 === 0 ? 1600 : 5000;
    const timeout = window.setTimeout(() => {
      setTeamsLoopFrame((currentFrame) => currentFrame + 1);
    }, durationMs);

    return () => window.clearTimeout(timeout);
  }, [isInViewport, showCompanions, teamsLoopFrame]);

  useEffect(() => {
    if (
      !showCompanions ||
      !isInViewport ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      setTerminalLoopFrame((currentFrame) => currentFrame + 1);
    }, TERMINAL_LOOP_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [isInViewport, showCompanions, terminalLoopFrame]);

  const activateWindow = (window: PreviewWindow) => {
    setActiveWindow(window);
    setHasManualWindowFocus(true);
  };

  // Selection frame + tag: hover or keyboard focus marks a window selected;
  // clearing is delayed so the pointer can travel to the tag below the
  // window without the selection collapsing on the way.
  const selectWindow = (target: PreviewWindow) => {
    if (selectionClearTimer.current !== null) {
      clearTimeout(selectionClearTimer.current);
      selectionClearTimer.current = null;
    }
    setSelectedWindow(target);
  };

  const scheduleSelectionClear = (target: PreviewWindow) => {
    if (selectionClearTimer.current !== null) {
      clearTimeout(selectionClearTimer.current);
    }
    selectionClearTimer.current = window.setTimeout(() => {
      selectionClearTimer.current = null;
      setSelectedWindow((current) => (current === target ? null : current));
    }, 200);
  };

  // Drag offsets go on the CSS `translate` property, not `transform`: the
  // side windows' reveal animations drive `transform` on the same elements
  // (with a persistent scroll-timeline fill), and `translate` composes with
  // an animated `transform` instead of being overridden by it. The whole
  // window is the drag surface; pointerdown also activates (click-to-front).
  const handleDragPointerDown = (
    dragWindow: DraggableWindow,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    activateWindow(dragWindow);
    if (!window.matchMedia("(min-width: 640px)").matches) {
      return;
    }
    const scene = story.current;
    const windowElement = event.currentTarget.closest(".mac-window");
    if (!scene || !(windowElement instanceof HTMLElement)) {
      return;
    }
    // Bounds keep the whole window inside the scene box, so the scene's
    // overflow clip can never cut it off mid-drag.
    const sceneRect = scene.getBoundingClientRect();
    const windowRect = windowElement.getBoundingClientRect();
    const { x: startX, y: startY } = positions[dragWindow];
    const baseLeft = windowRect.left - startX;
    const baseTop = windowRect.top - startY;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      window: dragWindow,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      startX,
      startY,
      minX: sceneRect.left - baseLeft,
      maxX: Math.max(
        sceneRect.left - baseLeft,
        sceneRect.right - windowRect.width - baseLeft,
      ),
      minY: sceneRect.top - baseTop,
      maxY: Math.max(
        sceneRect.top - baseTop,
        sceneRect.bottom - windowRect.height - baseTop,
      ),
    };
  };

  const handleDragPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const activeDrag = drag.current;
    if (activeDrag?.pointerId !== event.pointerId) {
      return;
    }
    setPositions((current) => {
      const next = { ...current };
      next[activeDrag.window] = {
        x: clamp(
          activeDrag.startX + event.clientX - activeDrag.pointerX,
          activeDrag.minX,
          activeDrag.maxX,
        ),
        y: clamp(
          activeDrag.startY + event.clientY - activeDrag.pointerY,
          activeDrag.minY,
          activeDrag.maxY,
        ),
      };
      return next;
    });
  };

  const handleDragPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  return (
    <div
      ref={story}
      className={cn(
        // overflow-clip, not hidden: a hidden box is a scroll container and
        // would capture the companions' view() reveal timeline (see the
        // scroll-staged reveal below), leaving them permanently visible.
        "cli-story relative h-full w-full overflow-clip",
        backdrop === "wash" && "bg-background",
        backdrop === "transparent" && "cli-story-transparent",
        isAutoPlaying && "cli-story-auto",
        revealSideWindowsOnScroll && "cli-story-with-scroll-reveal",
        !showCompanions && "cli-story-scene-only",
      )}
      dir="ltr"
    >
      {includeStyles && <style>{CLI_STYLES}</style>}

      <div aria-hidden="true" className="cli-story-wash absolute inset-0" />
      <div
        aria-hidden="true"
        className="cli-story-reflection absolute inset-0"
      />

      {showCompanions && (
        <div
          aria-label="Bring Microsoft Teams conversation to front"
          aria-pressed={focusedWindow === "client"}
          className={cn(
            "cli-client mac-window group bg-card focus-visible:outline-ring absolute start-[2.5%] top-[8%] hidden h-[30%] w-[15.5%] min-w-0 cursor-grab appearance-none overflow-hidden border p-0 text-start shadow-[0_28px_70px_-42px_rgba(15,23,42,.42)] focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing sm:block sm:touch-none",
            discoverLabel && selectedWindow === "client" && "cli-selected",
          )}
          onBlur={() => scheduleSelectionClear("client")}
          onFocus={() => {
            activateWindow("client");
            selectWindow("client");
          }}
          onPointerEnter={() => selectWindow("client")}
          onPointerLeave={() => scheduleSelectionClear("client")}
          onKeyDown={(event) =>
            activateWindowFromKeyboard(event, () => activateWindow("client"))
          }
          onPointerDown={(event) => handleDragPointerDown("client", event)}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          role="button"
          style={{
            borderColor:
              "color-mix(in srgb, var(--foreground) 11%, transparent)",
            translate: `${positions.client.x}px ${positions.client.y}px`,
            zIndex: getWindowZIndex({
              focusedWindow,
              hasManualWindowFocus,
              window: "client",
            }),
          }}
          tabIndex={0}
        >
          <div className="shrink-0">
            <WindowChrome
              icon={<TeamsMark />}
              label="Microsoft Teams"
              prominent
            />
          </div>
          <TeamsWindow
            showAnswer={!isAutoPlaying || teamsLoopFrame % 2 === 1}
          />
        </div>
      )}

      <div
        aria-label="Bring stella workspace to front"
        aria-pressed={focusedWindow === "workspace"}
        className={cn(
          "cli-main-window mac-window group bg-card focus-visible:outline-ring absolute start-[18.5%] top-[8%] h-[81%] w-[63%] cursor-pointer appearance-none overflow-hidden border p-0 text-start shadow-[0_42px_110px_-54px_rgba(15,23,42,.5)] focus-visible:outline-2 focus-visible:outline-offset-2",
          discoverLabel && selectedWindow === "workspace" && "cli-selected",
        )}
        onBlur={() => scheduleSelectionClear("workspace")}
        onFocus={() => {
          activateWindow("workspace");
          selectWindow("workspace");
        }}
        onPointerEnter={() => selectWindow("workspace")}
        onPointerLeave={() => scheduleSelectionClear("workspace")}
        onKeyDown={(event) =>
          activateWindowFromKeyboard(event, () => activateWindow("workspace"))
        }
        onPointerDown={() => activateWindow("workspace")}
        role="button"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 11%, transparent)",
          zIndex: getWindowZIndex({
            focusedWindow,
            hasManualWindowFocus,
            window: "workspace",
          }),
        }}
        tabIndex={0}
      >
        <WindowChrome label={getSceneChromeLabel(activeSceneId)} prominent />
        <div className="bg-background relative h-[calc(100%-var(--mac-titlebar-height))] overflow-hidden">
          <RecordedStellaScene
            isActive={isInViewport}
            sceneId={activeSceneId}
            variant={showCompanions ? "hero" : "wide"}
          />
        </div>
      </div>

      {showCompanions && (
        <div
          aria-label="Bring stella Editor to front"
          aria-pressed={focusedWindow === "source"}
          className={cn(
            "cli-response mac-window group bg-card focus-visible:outline-ring absolute end-[2%] top-[15%] hidden h-[42%] w-[16%] cursor-grab appearance-none overflow-hidden border p-0 text-start shadow-[0_34px_88px_-48px_rgba(15,23,42,.5)] focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing sm:block sm:touch-none",
            discoverLabel && selectedWindow === "source" && "cli-selected",
          )}
          key={activeScenario.id}
          onBlur={() => scheduleSelectionClear("source")}
          onFocus={() => {
            activateWindow("source");
            selectWindow("source");
          }}
          onPointerEnter={() => selectWindow("source")}
          onPointerLeave={() => scheduleSelectionClear("source")}
          onKeyDown={(event) =>
            activateWindowFromKeyboard(event, () => activateWindow("source"))
          }
          onPointerDown={(event) => handleDragPointerDown("source", event)}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          role="button"
          style={{
            borderColor:
              "color-mix(in srgb, var(--foreground) 11%, transparent)",
            translate: `${positions.source.x}px ${positions.source.y}px`,
            zIndex: getWindowZIndex({
              focusedWindow,
              hasManualWindowFocus,
              window: "source",
            }),
          }}
          tabIndex={0}
        >
          <div className="shrink-0">
            <WindowChrome label="stella Editor" />
          </div>
          <div className="bg-background relative h-[calc(100%-var(--mac-titlebar-height))] overflow-hidden">
            <RecordedStellaScene
              crop="document"
              isActive={isInViewport}
              sceneId="editor"
              variant="portrait"
            />
          </div>
        </div>
      )}

      {showCompanions && (
        <div
          aria-label="Bring stella terminal to front"
          aria-live="polite"
          aria-pressed={focusedWindow === "terminal"}
          className={cn(
            "cli-window mac-window group focus-visible:outline-ring absolute start-[5%] bottom-[4%] flex h-[76%] w-[90%] min-w-0 cursor-grab appearance-none flex-col overflow-hidden border p-0 text-start shadow-[0_42px_100px_-38px_rgba(0,0,0,.8)] focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing sm:start-[4.5%] sm:bottom-[14%] sm:h-[31%] sm:w-[14%] sm:touch-none",
            discoverLabel && selectedWindow === "terminal" && "cli-selected",
          )}
          onBlur={() => scheduleSelectionClear("terminal")}
          onFocus={() => {
            activateWindow("terminal");
            selectWindow("terminal");
          }}
          onPointerEnter={() => selectWindow("terminal")}
          onPointerLeave={() => scheduleSelectionClear("terminal")}
          onKeyDown={(event) =>
            activateWindowFromKeyboard(event, () => activateWindow("terminal"))
          }
          onPointerDown={(event) => handleDragPointerDown("terminal", event)}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          role="button"
          style={{
            background: "var(--terminal-chrome)",
            borderColor:
              "color-mix(in srgb, var(--terminal-foreground) 18%, transparent)",
            color: "var(--terminal-foreground)",
            translate: `${positions.terminal.x}px ${positions.terminal.y}px`,
            zIndex: getWindowZIndex({
              focusedWindow,
              hasManualWindowFocus,
              window: "terminal",
            }),
          }}
          tabIndex={0}
        >
          <div className="shrink-0">
            <WindowChrome label="stella CLI agent" />
          </div>

          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            key={`${activeScenario.id}-${terminalLoopFrame}`}
            style={{
              background: "var(--terminal-background)",
              fontVariantLigatures: "none",
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col p-[clamp(.25rem,.5vw,.45rem)] font-mono">
              <div
                className="flex min-h-[clamp(2.7rem,4.6vw,3.8rem)] min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-[.52rem] leading-relaxed sm:text-[clamp(.5rem,.66vw,.72rem)]"
                style={{ background: "var(--terminal-input)" }}
              >
                <span style={{ color: "var(--terminal-muted)" }}>&gt;</span>
                <span className="story-step story-step-visible min-w-0 flex-1">
                  <TypingCommand command={activeScenario.command} />
                </span>
              </div>

              <div className="story-step story-step-visible mt-[clamp(.2rem,.4vw,.35rem)] space-y-[clamp(.15rem,.32vw,.28rem)] text-[.42rem] leading-[1.3] sm:text-[clamp(.4rem,.53vw,.56rem)]">
                <div
                  className="cli-result flex items-start gap-2.5"
                  style={{ animationDelay: "1.7s" }}
                >
                  <span
                    className="mt-[.45em] h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: getScenarioAccent(activeScenario) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p style={{ color: "var(--terminal-muted)" }}>
                      {activeScenario.executionLabel}
                    </p>
                    <div className="mt-1 space-y-0.5 ps-1">
                      {activeScenario.steps.map((step, index) => (
                        <p
                          className="flex min-w-0 gap-2"
                          key={step.label}
                          style={{ color: "var(--terminal-muted)" }}
                        >
                          <span aria-hidden="true">
                            {index === activeScenario.steps.length - 1
                              ? "└"
                              : "├"}
                          </span>
                          <span className="min-w-0 truncate">{step.label}</span>
                          <span className="ms-auto shrink-0 tabular-nums">
                            {step.meta}
                          </span>
                        </p>
                      ))}
                    </div>
                  </div>
                </div>

                <div
                  className="cli-result cli-summary items-start gap-2"
                  style={{ animationDelay: "2.4s" }}
                >
                  <span
                    className="mt-[.4em] h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: getScenarioAccent(activeScenario) }}
                  />
                  <p style={{ color: "var(--terminal-muted)" }}>
                    <span style={{ color: "var(--terminal-foreground)" }}>
                      {activeScenario.result}
                    </span>{" "}
                    {activeScenario.detail}
                  </p>
                </div>

                <p
                  className="cli-result ps-4"
                  style={{
                    animationDelay: "2.8s",
                    color: "var(--terminal-muted)",
                  }}
                >
                  · {activeScenario.usage}
                </p>
              </div>

              <div
                aria-hidden="true"
                className="cli-idle-prompt mt-auto flex min-h-[clamp(1.6rem,2.4vw,2rem)] items-center rounded-md border px-2 text-[.46rem] sm:text-[clamp(.4rem,.56vw,.56rem)]"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--terminal-foreground) 14%, transparent)",
                  color: "var(--terminal-muted)",
                }}
              >
                <span>&gt;</span>
                <span
                  className="cli-cursor ms-2 h-[1.05em] w-[.08em]"
                  style={{ background: "var(--terminal-foreground)" }}
                />
              </div>
            </div>

            <div
              className="flex min-h-[clamp(1.45rem,2.2vw,1.9rem)] shrink-0 items-center border-t px-[clamp(.4rem,.7vw,.6rem)] font-mono text-[.4rem] sm:text-[clamp(.38rem,.52vw,.54rem)]"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--terminal-foreground) 12%, transparent)",
                color: "var(--terminal-muted)",
              }}
            >
              <SessionStatus scenario={activeScenario} />
            </div>
          </div>
        </div>
      )}

      {discoverLabel && selectedWindow && (
        <DiscoverTag
          dragOffset={
            selectedWindow === "workspace"
              ? undefined
              : positions[selectedWindow]
          }
          href={
            selectedWindow === "workspace"
              ? DISCOVER_PRODUCTS[activeSceneId].href
              : DISCOVER_WINDOW_PRODUCTS[selectedWindow].href
          }
          label={discoverLabel}
          onPointerEnter={() => selectWindow(selectedWindow)}
          onPointerLeave={() => scheduleSelectionClear(selectedWindow)}
          productName={
            selectedWindow === "workspace"
              ? DISCOVER_PRODUCTS[activeSceneId].name
              : DISCOVER_WINDOW_PRODUCTS[selectedWindow].name
          }
          window={selectedWindow}
        />
      )}
    </div>
  );
};

// The Teams chrome lives in the parent (wrapped in the drag handle); this is
// only the window body.
const TeamsWindow = ({ showAnswer }: { showAnswer: boolean }) => (
  <>
    <div
      className="border-b px-[clamp(.5rem,.9cqw,.8rem)] py-[clamp(.25rem,.5cqw,.45rem)]"
      style={{
        borderColor: "color-mix(in srgb, var(--foreground) 8%, transparent)",
      }}
    >
      <p className="text-foreground truncate text-[clamp(.5rem,.85cqw,.8rem)] font-semibold">
        {storyTeamsExchange.channel}
      </p>
      <p className="text-muted-foreground truncate text-[clamp(.42rem,.68cqw,.62rem)]">
        {storyTeamsExchange.context}
      </p>
    </div>
    <div className="space-y-[clamp(.42rem,.8cqw,.7rem)] p-[clamp(.5rem,.9cqw,.8rem)] text-[clamp(.45rem,.7cqw,.66rem)] leading-snug">
      <div className="story-step story-step-visible flex gap-2">
        <span className="bg-muted text-foreground flex h-[clamp(1.25rem,2.3cqw,1.9rem)] w-[clamp(1.25rem,2.3cqw,1.9rem)] shrink-0 items-center justify-center rounded-full font-semibold">
          P
        </span>
        <div className="min-w-0">
          <p className="text-foreground font-semibold">
            {storyTeamsExchange.role}
          </p>
          <p className="text-muted-foreground line-clamp-2">
            {storyTeamsExchange.prompt}
          </p>
        </div>
      </div>
      <div
        className={cn(
          "story-step flex gap-2",
          showAnswer && "story-step-visible",
        )}
      >
        <span
          className="flex h-[clamp(1.25rem,2.3cqw,1.9rem)] w-[clamp(1.25rem,2.3cqw,1.9rem)] shrink-0 items-center justify-center rounded-md"
          style={{ background: AGENT_ACCENT, color: AGENT_ACCENT_FOREGROUND }}
        >
          <StellaMark className="h-[62%] w-[62%]" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground font-semibold">
            stella agent
            <span className="bg-muted text-muted-foreground ms-1 rounded px-1 text-[.78em] font-medium">
              APP
            </span>
          </p>
          <p className="text-muted-foreground line-clamp-2">
            {storyTeamsExchange.response}
          </p>
          <div
            className={cn(
              "story-step mt-[clamp(.3rem,.6cqw,.5rem)] rounded-[clamp(.3rem,.6cqw,.5rem)] border p-[clamp(.32rem,.6cqw,.55rem)]",
              showAnswer && "story-step-visible",
            )}
            style={{
              background:
                "color-mix(in srgb, var(--card) 86%, var(--teams-accent) 14%)",
              borderColor:
                "color-mix(in srgb, var(--teams-accent) 24%, var(--border))",
            }}
          >
            <p className="text-foreground font-semibold">
              2 playbook deviations
            </p>
            <p className="text-muted-foreground mt-0.5 line-clamp-2">
              {storyTeamsExchange.result}
            </p>
            <p className="mt-1 font-medium" style={{ color: AGENT_ACCENT }}>
              Open in stella →
            </p>
          </div>
        </div>
      </div>
    </div>
  </>
);

const TeamsMark = () => (
  <svg
    aria-hidden="true"
    className="h-[clamp(.65rem,1vw,.85rem)] w-[clamp(.65rem,1vw,.85rem)] shrink-0"
    viewBox="0 0 20 20"
  >
    <rect fill="#6264a7" height="14" rx="3" width="14" x="1" y="4" />
    <circle cx="15.5" cy="5" fill="#7b83eb" r="2.5" />
    <path d="M5 7h7v2H9.7v6H7.3V9H5z" fill="white" />
    <path
      d="M15 8h2.5A1.5 1.5 0 0 1 19 9.5v5A1.5 1.5 0 0 1 17.5 16H15z"
      fill="#7b83eb"
    />
  </svg>
);

const TypingCommand = ({ command }: { command: string }) => {
  let characterIndex = 0;
  return (
    <span
      aria-label={command}
      className="cli-command min-w-0 flex-1 font-semibold whitespace-pre-wrap"
    >
      {command.split(/(\s+)/u).map((token, tokenIndex) => {
        if (/^\s+$/u.test(token)) {
          return (
            <span aria-hidden="true" key={`space-${tokenIndex}`}>
              {token}
            </span>
          );
        }
        return (
          <span
            aria-hidden="true"
            className="inline-block whitespace-nowrap"
            key={`${token}-${tokenIndex}`}
          >
            {/* eslint-disable-next-line no-misused-spread -- ASCII-only CLI command text, no grapheme clusters */}
            {[...token].map((character, index) => {
              const delay =
                COMMAND_TYPE_DELAY_MS +
                characterIndex * COMMAND_CHARACTER_DELAY_MS;
              characterIndex += 1;
              return (
                <span
                  className="cli-command-character"
                  key={`${character}-${index}`}
                  style={{ animationDelay: `${delay}ms` }}
                >
                  {character}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
};

const WindowChrome = ({
  icon,
  label,
  prominent = false,
}: WindowChromeProps) => (
  <div className="mac-titlebar relative flex shrink-0 items-center">
    <MacTrafficLights />
    <div
      className={cn(
        "text-muted-foreground pointer-events-none absolute inset-0 flex min-w-0 items-center justify-center gap-[clamp(.2rem,.35vw,.32rem)] px-[28%] text-[clamp(.38rem,.62vw,.62rem)]",
        prominent && "text-foreground font-medium",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </div>
  </div>
);

const MacTrafficLights = () => (
  <div
    aria-hidden="true"
    className="relative z-1 flex items-center gap-[clamp(.28rem,.48vw,.48rem)]"
  >
    <span className="mac-traffic-light bg-[var(--mac-close)]">
      <span className="mac-traffic-glyph">×</span>
    </span>
    <span className="mac-traffic-light bg-[var(--mac-minimize)]">
      <span className="mac-traffic-glyph mac-traffic-minus">−</span>
    </span>
    <span className="mac-traffic-light bg-[var(--mac-maximize)]">
      <span className="mac-traffic-glyph">+</span>
    </span>
  </div>
);

type WindowChromeProps = {
  icon?: ReactNode;
  label: string;
  prominent?: boolean;
};

type CliMcpPreviewProps = {
  /**
   * "wash": opaque scene background (standalone embeds).
   * "transparent": only the radial blooms; the surface behind the scene
   * (e.g. the homepage hero gradient) shows through.
   */
  backdrop?: "wash" | "transparent";
  /**
   * Translated "Discover" label; when set, each window shows a hover/focus
   * chip linking to its product page (the main window follows the active
   * scene). Omitted in embeds that have their own product links.
   */
  discoverLabel?: string;
  includeStyles?: boolean;
  initialScenarioId?: CliScenarioId;
  revealSideWindowsOnScroll?: boolean;
  sceneId?: ProductStorySceneId;
  showCompanions?: boolean;
};

type CliScenarioId = "search" | "template" | "case-law";

const PREVIEW_WINDOW_Z_INDEX = {
  client: 1,
  workspace: 3,
  source: 2,
  terminal: 4,
} as const;

type PreviewWindow = keyof typeof PREVIEW_WINDOW_Z_INDEX;

const STORY_PHASES = openingProductStory;

// The floating companion windows; the main workspace window is the scene
// backdrop and stays fixed.
type DraggableWindow = Exclude<PreviewWindow, "workspace">;

type DragState = {
  window: DraggableWindow;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  startX: number;
  startY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type CliScenario = {
  id: CliScenarioId;
  type: "agent" | "cli";
  command: string;
  result: string;
  detail: string;
  executionLabel: string;
  usage: string;
  steps: readonly { label: string; meta: string }[];
};

const SCENARIOS: readonly CliScenario[] = [
  {
    id: "search",
    type: "agent",
    command: "Compare change-of-control clauses across this matter",
    result: "Compared every clause",
    detail: "and linked 3 cited passages",
    executionLabel: "Ran 2 MCP tools",
    usage: "Worked 3s · 3.2K tokens",
    steps: [
      { label: CLI_DEMO_TOOLS.searchAcrossMatters, meta: "18 documents" },
      { label: CLI_DEMO_TOOLS.readDocument, meta: "3 passages" },
      { label: "Grounded the answer", meta: "3 citations" },
    ],
  },
  {
    id: "template",
    type: "agent",
    command: "Fill missing SAFE fields from this matter",
    result: "Created Internal SAFE.docx",
    detail: "with 12 resolved fields",
    executionLabel: "Ran 3 MCP tools",
    usage: "Worked 6s · 4.8K tokens",
    steps: [
      { label: CLI_DEMO_TOOLS.listTemplates, meta: "SAFE" },
      { label: "Read matter and registry fields", meta: "12 values" },
      { label: CLI_DEMO_TOOLS.fillTemplate, meta: "complete" },
    ],
  },
  {
    id: "case-law",
    type: "cli",
    command: 'stella case-law search "MAC clause" --country SK',
    result: "Found 12 decisions",
    detail: "from official sources",
    executionLabel: "Ran 1 CLI command",
    usage: "Completed in 0.7s · 12 results",
    steps: [
      { label: "Queried connected court sources", meta: "0.7s" },
      { label: "Ranked matching decisions", meta: "12 results" },
      { label: "Opened the leading decision", meta: "verified" },
    ],
  },
] as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const AGENT_ACCENT = "#d97757";
// White in both themes: the accent chip is a fixed brand color (like the
// Teams mark above), so its glyph must not follow the theme's foreground.
const AGENT_ACCENT_FOREGROUND = "#fff";
const ACTIVE_WINDOW_Z_INDEX = 20;
const PINNED_MAIN_Z_INDEX = 0;
const COMMAND_TYPE_DELAY_MS = 350;
const COMMAND_CHARACTER_DELAY_MS = 24;
const TERMINAL_LOOP_DURATION_MS = 9000;

const getInitialActiveWindow = (): PreviewWindow => "terminal";

// Product destination per scene for the main window's discover chip; the
// companion windows have fixed products. Names match the product eyebrows
// used across the nav (brand-constant, not translated).
const DISCOVER_PRODUCTS: Record<
  ProductStorySceneId,
  { href: string; name: string }
> = {
  workspace: { href: "/product/workspace", name: "Workspace" },
  review: { href: "/product/tabular-review", name: "Tabular Review" },
  editor: { href: "/product/editor", name: "Editor" },
  agent: { href: "/product/agent", name: "AI agent" },
  cli: { href: "/product/cli-mcp", name: "CLI & MCP" },
};

// Geometry for the selection tag rendered UNDER each window. The windows
// clip their children (overflow-hidden), so the tag is a scene-level
// sibling; these values mirror the windows' inset/size classes below and
// must move together with them.
const DISCOVER_TAG_POSITIONS: Record<PreviewWindow, CSSProperties> = {
  // Teams: centred on start 2.5% + half of 15.5%; below top 8% + 30% height.
  client: { insetInlineStart: "10.25%", top: "calc(38% + 0.55rem)" },
  // Main: centred on start 18.5% + half of 63%; below top 8% + 81% height.
  workspace: { insetInlineStart: "50%", top: "calc(89% + 0.55rem)" },
  // Editor: centred on end 2% + half of 16%; below top 15% + 42% height.
  source: { insetInlineEnd: "10%", top: "calc(57% + 0.55rem)" },
  // Terminal (sm layout): start 4.5% + half of 14%; bottom edge at 14%.
  terminal: { insetInlineStart: "11.5%", bottom: "calc(14% - 2.7rem)" },
};

// Companion windows map to fixed products; the main window's product
// follows the active scene via DISCOVER_PRODUCTS.
const DISCOVER_WINDOW_PRODUCTS: Record<
  DraggableWindow,
  { href: string; name: string }
> = {
  client: { href: "/product/agent", name: "AI agent" },
  source: { href: "/product/editor", name: "Editor" },
  terminal: { href: "/product/cli-mcp", name: "CLI & MCP" },
};

type DiscoverTagProps = {
  dragOffset?: { x: number; y: number };
  href: string;
  label: string;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  productName: string;
  window: PreviewWindow;
};

// Selection tag: rendered below the selected window in the style of a
// design-tool selection frame. The tag is the only link surface; the frame
// itself is the `cli-selected` outline on the window.
const DiscoverTag = ({
  dragOffset,
  href,
  label,
  onPointerEnter,
  onPointerLeave,
  productName,
  window,
}: DiscoverTagProps) => (
  <a
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
    className="absolute z-[70] inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap no-underline shadow-md"
    dir="auto"
    href={href}
    style={{
      ...DISCOVER_TAG_POSITIONS[window],
      background: "var(--primary)",
      color: "var(--primary-foreground)",
      translate: dragOffset ? `${dragOffset.x}px ${dragOffset.y}px` : undefined,
      transform:
        DISCOVER_TAG_POSITIONS[window].insetInlineEnd === undefined
          ? "translateX(-50%)"
          : "translateX(50%)",
    }}
  >
    {label} {productName}
    <span aria-hidden="true">→</span>
  </a>
);

type WindowZIndexOptions = {
  focusedWindow: PreviewWindow;
  hasManualWindowFocus: boolean;
  window: PreviewWindow;
};

// The main workspace window is the scene's backdrop: the floating companions
// stack above it, and the auto-playing choreography never raises it. Only an
// explicit user click/focus brings it forward; clicking any companion sends
// it back behind them.
const getWindowZIndex = ({
  focusedWindow,
  hasManualWindowFocus,
  window,
}: WindowZIndexOptions) => {
  if (window === "workspace") {
    return hasManualWindowFocus && focusedWindow === "workspace"
      ? ACTIVE_WINDOW_Z_INDEX
      : PINNED_MAIN_Z_INDEX;
  }
  return focusedWindow === window
    ? ACTIVE_WINDOW_Z_INDEX
    : PREVIEW_WINDOW_Z_INDEX[window];
};

const getScenarioAccent = (scenario: CliScenario) =>
  scenario.type === "agent" ? AGENT_ACCENT : "var(--terminal-accent)";

const getSceneChromeLabel = (sceneId: ProductStorySceneId) => {
  if (sceneId === "workspace") {
    return "stella · Project Atlas · Files";
  }
  if (sceneId === "review") {
    return "stella · Project Atlas · Table";
  }
  if (sceneId === "editor") {
    return "stella · Northstar SAFE · Editor";
  }
  if (sceneId === "agent") {
    return "stella · Project Atlas · Agent";
  }
  return "stella · Agent";
};

const toPreviewWindow = (window: ProductStoryWindowId): PreviewWindow => {
  if (window === "teams") {
    return "client";
  }
  if (window === "app") {
    return "workspace";
  }
  if (window === "editor") {
    return "source";
  }
  return "terminal";
};

type FocusedWindowOptions = {
  activeWindow: PreviewWindow;
  focus: ProductStoryWindowId;
  hasManualWindowFocus: boolean;
  isAutoPlaying: boolean;
  showCompanions: boolean;
};

const getFocusedWindow = ({
  activeWindow,
  focus,
  hasManualWindowFocus,
  isAutoPlaying,
  showCompanions,
}: FocusedWindowOptions): PreviewWindow => {
  if (!showCompanions) {
    return "workspace";
  }
  if (hasManualWindowFocus) {
    return activeWindow;
  }
  if (isAutoPlaying) {
    return toPreviewWindow(focus);
  }
  return activeWindow;
};

const activateWindowFromKeyboard = (
  event: KeyboardEvent,
  activateWindow: () => void,
) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  activateWindow();
};

const SessionStatus = ({ scenario }: { scenario: CliScenario }) => {
  if (scenario.type === "cli") {
    return (
      <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
        <span className="text-success font-semibold">▶ stella CLI</span>
        <span>authenticated</span>
        <span>·</span>
        <span>read-only</span>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
      <span className="font-semibold" style={{ color: AGENT_ACCENT }}>
        ▶▶ agent
      </span>
      <span>·</span>
      <span>stella MCP</span>
    </span>
  );
};

const CLI_STYLES = `
  .cli-story {
    --mac-close: #ff5f57;
    --mac-maximize: #28c840;
    --mac-minimize: #febc2e;
    --mac-titlebar-height: clamp(1.7rem, 2.35vw, 2.15rem);
    --teams-accent: #6264a7;
    container-type: inline-size;
    isolation: isolate;
  }
  .mac-window {
    border-radius: clamp(.62rem, 1vw, .9rem);
    /* --card is translucent in the dark theme; windows overlap, so composite
       it over the page background for an opaque surface. */
    background: linear-gradient(var(--card), var(--card)) var(--background);
  }
  /* Design-tool style selection frame; paired with the DiscoverTag rendered
     under the selected window. */
  .cli-selected {
    outline: 2px solid var(--primary);
    outline-offset: 5px;
  }
  .mac-window::after {
    content: "";
    position: absolute;
    z-index: 50;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    background: var(--background);
    opacity: .1;
    transition: opacity 320ms var(--ease-out-quint);
  }
  .cli-window::after { background: var(--terminal-background); }
  .mac-window[aria-pressed="true"]::after { opacity: 0; }
  .story-step {
    opacity: 0;
    transform: translate3d(0, 5px, 0);
    transition:
      opacity 360ms var(--ease-out-quint),
      transform 360ms var(--ease-out-quint);
  }
  .story-step-visible {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
  .mac-titlebar {
    height: var(--mac-titlebar-height);
    padding-inline: clamp(.52rem, .78vw, .7rem);
    border-bottom: 1px solid color-mix(in srgb, var(--foreground) 8%, transparent);
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--card) 98%, white 2%),
        color-mix(in srgb, var(--card) 94%, var(--muted) 6%)
      );
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 50%, transparent);
  }
  .dark .mac-titlebar {
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--card) 96%, white 4%),
        color-mix(in srgb, var(--card) 92%, black 8%)
      );
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 9%, transparent);
  }
  .mac-traffic-light {
    display: flex;
    align-items: center;
    justify-content: center;
    width: clamp(.4rem, .52vw, .58rem);
    height: clamp(.4rem, .52vw, .58rem);
    flex: none;
    border-radius: 9999px;
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, black 9%, transparent),
      0 1px 1px color-mix(in srgb, black 12%, transparent);
  }
  .mac-traffic-glyph {
    color: color-mix(in srgb, black 58%, transparent);
    font-family: system-ui, sans-serif;
    font-size: clamp(.32rem, .4vw, .44rem);
    font-weight: 700;
    line-height: 1;
    opacity: 0;
    transform: translateY(-.02em);
    transition: opacity 120ms ease;
  }
  .mac-traffic-minus { transform: translateY(-.08em); }
  .mac-window:hover .mac-traffic-glyph { opacity: 1; }
  .cli-window .mac-titlebar {
    color: var(--terminal-muted);
    border-bottom-color:
      color-mix(in srgb, var(--terminal-foreground) 11%, transparent);
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--terminal-chrome) 96%, white 4%),
        var(--terminal-chrome)
      );
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
  }
  .cli-story-wash {
    background:
      radial-gradient(ellipse 58% 66% at 18% 76%, color-mix(in srgb, #9ecfff 28%, transparent), transparent 72%),
      radial-gradient(ellipse 52% 58% at 84% 30%, color-mix(in srgb, #c4dcff 24%, transparent), transparent 74%),
      linear-gradient(180deg, color-mix(in srgb, var(--background) 96%, #dceeff 4%), color-mix(in srgb, var(--background) 84%, #b9d9ff 16%));
  }
  .dark .cli-story-wash {
    background:
      radial-gradient(ellipse 58% 66% at 18% 76%, color-mix(in srgb, #24527a 22%, transparent), transparent 72%),
      radial-gradient(ellipse 52% 58% at 84% 30%, color-mix(in srgb, #1f3f61 18%, transparent), transparent 74%),
      linear-gradient(180deg, color-mix(in srgb, var(--background) 96%, #142233 4%), color-mix(in srgb, var(--background) 84%, #172a40 16%));
  }
  /* Transparent backdrop: the shared hero gradient behind the scene is the
     only surface; painting anything here reads as a boxed preview background. */
  .cli-story-transparent .cli-story-wash,
  .dark .cli-story-transparent .cli-story-wash {
    background: none;
  }
  .cli-story-transparent .cli-story-reflection {
    display: none;
  }
  .cli-story-reflection {
    opacity: .44;
    background: linear-gradient(112deg, transparent 12%, color-mix(in srgb, white 44%, transparent) 38%, transparent 57%);
    transform: translate3d(-18%, 0, 0);
    filter: blur(42px);
  }
  .dark .cli-story-reflection { opacity: .1; }
  .cli-summary { display: none; }
  @container (min-width: 70rem) {
    .cli-summary { display: flex; }
  }
  @keyframes cli-window-enter {
    from { opacity: 0; transform: translate3d(0, 18px, 0) scale(.985); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
  }
  @keyframes cli-character-enter {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes cli-result-enter {
    from { opacity: 0; transform: translate3d(0, 5px, 0); }
    to { opacity: 1; transform: translate3d(0, 0, 0); }
  }
  @keyframes cli-cursor {
    0%, 45% { opacity: 1; }
    46%, 100% { opacity: 0; }
  }
  /* Companions arrive from OUTSIDE the scene (never from behind the main
     window) and stay fully invisible through the first half of the motion,
     so a scrubbed mid-state never ghosts over the main window. */
  @keyframes cli-side-start-reveal {
    from { opacity: 0; filter: blur(4px); transform: translate3d(-55%, 16px, 0) scale(.97); }
    55% { opacity: 0; filter: blur(4px); }
    to { opacity: 1; filter: blur(0); transform: translate3d(0, 0, 0) scale(1); }
  }
  @keyframes cli-side-end-reveal {
    from { opacity: 0; filter: blur(4px); transform: translate3d(55%, 20px, 0) scale(.97); }
    55% { opacity: 0; filter: blur(4px); }
    to { opacity: 1; filter: blur(0); transform: translate3d(0, 0, 0) scale(1); }
  }
  @keyframes cli-terminal-scroll-reveal {
    from { opacity: 0; filter: blur(3px); transform: translate3d(0, 24px, 0); }
    50% { opacity: 0; filter: blur(3px); }
    to { opacity: 1; filter: blur(0); transform: translate3d(0, 0, 0); }
  }
  .cli-window { animation: cli-window-enter 800ms var(--ease-out-quint) 120ms backwards; }
  .cli-client { animation: cli-side-start-reveal 760ms var(--ease-out-quint) 280ms backwards; }
  .cli-command-character {
    opacity: 0;
    animation: cli-character-enter 1ms steps(1, start) forwards;
  }
  .cli-result { animation: cli-result-enter 420ms var(--ease-out-quint) both; }
  .cli-response { animation: cli-side-end-reveal 820ms var(--ease-out-quint) 460ms backwards; }
  .cli-cursor { animation: cli-cursor 900ms steps(1, end) infinite; }
  @supports (animation-timeline: scroll()) {
    /* Attio-style staging: at page load the main window stands alone,
       larger and sitting higher; scrolling scrubs it down to its resting
       size and position while the companions arrive one after another.
       Timeline is ABSOLUTE scroll distance (scroll(root)), not viewport
       entry: entry progress varies with viewport height, so on tall
       screens companions would already be past their range at load.
       With scroll distance, zero scroll always means hidden companions. */
    @keyframes cli-main-scroll-settle {
      from { transform: translateY(-7%) scale(1.24); }
      to { transform: translateY(0) scale(1); }
    }
    .cli-story-with-scroll-reveal .cli-main-window {
      transform-origin: 50% 0%;
      animation: cli-main-scroll-settle linear both;
      animation-duration: auto;
      animation-timeline: scroll(root);
      animation-range: 0px 420px;
    }
    .cli-story-with-scroll-reveal .cli-window {
      animation: cli-terminal-scroll-reveal linear both;
      animation-duration: auto;
      animation-timeline: scroll(root);
      animation-range: 40px 260px;
    }
    .cli-story-with-scroll-reveal .cli-client {
      animation: cli-side-start-reveal linear both;
      animation-duration: auto;
      animation-timeline: scroll(root);
      animation-range: 120px 380px;
    }
    .cli-story-with-scroll-reveal .cli-response {
      animation: cli-side-end-reveal linear both;
      animation-duration: auto;
      animation-timeline: scroll(root);
      animation-range: 200px 480px;
    }
  }
  .nav-mega-pane .cli-window,
  .nav-mega-pane .cli-command-character,
  .nav-mega-pane .cli-result,
  .nav-mega-pane .cli-response,
  .nav-mega-pane .cli-cursor { animation: none; }
  .nav-mega-pane .cli-command-character { opacity: 1; }
  .nav-mega-pane .cli-response { display: none; }
  .nav-mega-pane .cli-client { display: none; }
  .nav-mega-pane .cli-main-window {
    inset: 7% 5% auto auto;
    width: 82%;
    height: 86%;
  }
  .nav-mega-pane .cli-window {
    inset: auto auto 4% 4%;
    width: 48%;
    height: 72%;
  }
  .cli-story-scene-only .cli-client,
  .cli-story-scene-only .cli-response,
  .cli-story-scene-only .cli-window {
    display: none;
  }
  .cli-story-scene-only .cli-main-window {
    inset: 3% auto auto 3%;
    width: 94%;
    height: 94%;
  }
  @media (max-width: 639px) {
    .cli-main-window {
      inset: 4% auto auto 3%;
      width: 94%;
      height: 60%;
    }
    .cli-window {
      inset: auto auto 2.5% 5%;
      width: 90%;
      height: 33%;
    }
    .cli-idle-prompt { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cli-window,
    .cli-command-character,
    .cli-result,
    .cli-response,
    .cli-client,
    .cli-main-window,
    .cli-cursor { animation: none; }
    .cli-command-character { opacity: 1; }
    .mac-window::after { display: none; }
    .story-step {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }
`;
