import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Loader2,
  Play,
  TriangleAlert,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { CopyButton } from "@/components/Markdown/copy-button";
import {
  AnswerShape,
  ParsedAnswer,
  collectCodeBlocks,
  parseAnswer,
} from "@/lib/assessment";
import { RunSummary, buildRunPlan, runPlan } from "@/lib/test-runner";

interface AnswerCardProps {
  response: string;
  isStreaming?: boolean;
}

/**
 * How each shape reads at a glance. The whole card is tinted rather than tagged with
 * a coloured edge: the tint is what the eye catches from across the screen, and the
 * label repeats the shape in words so the panel never depends on hue alone.
 */
const SHAPE_STYLES: Record<
  AnswerShape,
  { label: string; surface: string; accent: string }
> = {
  choice: {
    label: "Answer",
    surface:
      "border-violet-500/25 bg-violet-500/[0.06] dark:border-violet-400/25 dark:bg-violet-400/[0.08]",
    accent: "text-violet-600 dark:text-violet-300",
  },
  code: {
    label: "Solution",
    surface:
      "border-cyan-600/25 bg-cyan-600/[0.06] dark:border-cyan-400/25 dark:bg-cyan-400/[0.08]",
    accent: "text-cyan-700 dark:text-cyan-300",
  },
  files: {
    label: "Files",
    surface:
      "border-amber-500/25 bg-amber-500/[0.06] dark:border-amber-400/25 dark:bg-amber-400/[0.08]",
    accent: "text-amber-700 dark:text-amber-300",
  },
  prose: {
    label: "Response",
    surface:
      "border-emerald-600/25 bg-emerald-600/[0.06] dark:border-emerald-400/25 dark:bg-emerald-400/[0.08]",
    accent: "text-emerald-700 dark:text-emerald-300",
  },
};

// Both themes ship, and the HUD sits over whatever is behind it, so every accent
// carries a light value too. A single -300 washes out to unreadable on white.
const CONFIDENCE_STYLES = {
  high: "text-emerald-700 dark:text-emerald-300/90",
  medium: "text-muted-foreground",
  low: "text-amber-700 dark:text-amber-300",
} as const;

/** How a finished run reads. Passing is quiet; failing is the thing to notice. */
const RUN_STYLES: Record<
  RunSummary["status"],
  { border: string; text: string; icon: typeof CircleCheck }
> = {
  passed: {
    border: "border-emerald-600/40 dark:border-emerald-400/40",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: CircleCheck,
  },
  failed: {
    border: "border-red-600/40 dark:border-red-400/40",
    text: "text-red-700 dark:text-red-300",
    icon: CircleX,
  },
  timeout: {
    border: "border-amber-600/40 dark:border-amber-400/40",
    text: "text-amber-700 dark:text-amber-300",
    icon: TriangleAlert,
  },
};

/** Long enough to fit "toString(radix) rounds toward zero", short enough to stay big. */
const HEADLINE_BIG_LIMIT = 24;

/**
 * Renders an assessment answer verdict-first, and falls back to the plain markdown
 * renderer for any response that did not fill in the contract.
 */
export const AnswerCard = ({ response, isStreaming = false }: AnswerCardProps) => {
  const parsed = useMemo(() => parseAnswer(response), [response]);

  if (!parsed) return <Markdown isStreaming={isStreaming}>{response}</Markdown>;

  // Keyed on the shape because the disclosure below defaults from it, and the shape
  // is not final on the first render: the contract block streams in over several
  // chunks, so an answer that turns out to be `choice` is briefly something else.
  // Without the remount the reasoning stays open on exactly the shape that wanted it
  // folded.
  return <Verdict key={parsed.shape} answer={parsed} isStreaming={isStreaming} />;
};

const Verdict = ({
  answer,
  isStreaming,
}: {
  answer: ParsedAnswer;
  isStreaming: boolean;
}) => {
  const style = SHAPE_STYLES[answer.shape];
  const bodyRef = useRef<HTMLDivElement>(null);

  // A choice answer is the one shape whose payload fits in the rail entirely, so the
  // reasoning starts folded: the reader wants the letter, and opens the argument only
  // when the letter surprises them.
  const [showBody, setShowBody] = useState(answer.shape !== "choice");

  const blocks = useMemo(
    () => collectCodeBlocks(answer.body).filter((block) => block.path),
    [answer.body]
  );

  const jumpTo = useCallback((index: number) => {
    const pre = bodyRef.current?.querySelectorAll("pre");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pre?.[index]?.scrollIntoView({
      block: "start",
      behavior: reduced ? "auto" : "smooth",
    });
  }, []);

  // Copying the letter is the whole job on a choice question; on a code question it is
  // the first block, which is the part being transcribed into the editor.
  const copyPayload =
    answer.shape === "choice" || answer.shape === "prose"
      ? answer.headline
      : collectCodeBlocks(answer.body)[0]?.code || answer.headline;

  const headlineIsShort = answer.headline.length <= HEADLINE_BIG_LIMIT;

  // Only offered when there is something a local interpreter can actually run. An answer
  // in SQL or Java gets no button rather than a button that fails on click.
  const plan = useMemo(() => buildRunPlan(answer.body), [answer.body]);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showRunDetail, setShowRunDetail] = useState(false);

  const startRun = useCallback(async () => {
    if (!plan || running) return;
    setRunning(true);
    setRunError(null);
    setRun(null);
    try {
      const summary = await runPlan(plan);
      setRun(summary);
      // A failure is the reason the button exists, so its output opens by itself. A pass
      // needs no reading.
      setShowRunDetail(summary.status !== "passed");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [plan, running]);

  return (
    <div data-slot="answer-card" className="flex flex-col gap-3">
      <div
        data-slot="answer-verdict"
        data-shape={answer.shape}
        aria-live="polite"
        className={`rounded-xl border px-3 py-2.5 ${style.surface}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider ${style.accent}`}
            >
              {style.label}
            </span>
            {answer.confidence && (
              <span
                data-slot="answer-confidence"
                className={`text-[10px] ${CONFIDENCE_STYLES[answer.confidence]}`}
              >
                {answer.confidence === "low" ? (
                  <span className="inline-flex items-center gap-1">
                    <TriangleAlert className="size-2.5" aria-hidden="true" />
                    Low confidence: check it
                  </span>
                ) : (
                  `${answer.confidence} confidence`
                )}
              </span>
            )}
          </div>
          {copyPayload && !answer.pending && (
            <CopyButton
              content={copyPayload}
              copyMessage={
                answer.shape === "choice" ? "Answer copied" : "Code copied"
              }
            />
          )}
        </div>

        {answer.headline ? (
          <p
            data-slot="answer-headline"
            className={
              answer.shape === "choice" && headlineIsShort
                ? "mt-1 break-words font-mono text-2xl font-semibold leading-tight text-foreground"
                : "mt-1 break-words text-sm leading-snug text-foreground/90"
            }
          >
            {answer.headline}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground animate-pulse motion-reduce:animate-none">
            Working out the answer…
          </p>
        )}

        {answer.options.length > 0 && (
          <ul
            data-slot="answer-options"
            className="mt-2 flex flex-wrap gap-1"
            aria-label="Options"
          >
            {answer.options.map((option) => (
              <li
                key={option.label}
                data-selected={option.selected}
                // Weight and colour say "chosen" to a reader looking at the panel.
                // The label says it to everyone else.
                aria-label={
                  option.selected
                    ? `Option ${option.label}, chosen`
                    : `Option ${option.label}`
                }
                className={`inline-flex min-w-6 items-center justify-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${
                  option.selected
                    ? "border-violet-500/60 bg-violet-500/15 font-semibold text-violet-700 dark:border-violet-400/60 dark:bg-violet-400/20 dark:text-violet-100"
                    : "border-input/40 text-muted-foreground/60"
                }`}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {plan && !answer.pending && (
        <div data-slot="answer-run" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-slot="answer-run-button"
            onClick={startRun}
            disabled={running}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input/40 bg-muted/40 px-2 py-1 text-[11px] font-medium transition hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          >
            {running ? (
              <Loader2
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Play className="size-3" aria-hidden="true" />
            )}
            {running ? "Running…" : run ? "Run again" : "Run tests"}
          </button>

          <span className="font-mono text-[10px] text-muted-foreground/70">
            {plan.language} · {plan.entry}
          </span>

          {run && (
            <button
              type="button"
              data-slot="answer-run-result"
              data-status={run.status}
              onClick={() => setShowRunDetail((open) => !open)}
              aria-expanded={showRunDetail}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                RUN_STYLES[run.status].border
              } ${RUN_STYLES[run.status].text}`}
            >
              {(() => {
                const Icon = RUN_STYLES[run.status].icon;
                return <Icon className="size-3" aria-hidden="true" />;
              })()}
              {run.headline}
              <span className="font-mono text-[10px] opacity-70">
                {run.durationMs}ms
              </span>
            </button>
          )}
        </div>
      )}

      {runError && (
        <p
          data-slot="answer-run-error"
          className="rounded-md border border-amber-600/40 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-400/40 dark:text-amber-300"
        >
          {runError}
        </p>
      )}

      {run && showRunDetail && run.detail && (
        <pre
          data-slot="answer-run-detail"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-input/40 bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground"
        >
          {run.detail}
        </pre>
      )}

      {blocks.length > 1 && (
        <ul
          data-slot="answer-file-rail"
          className="flex flex-wrap gap-1"
          aria-label="Jump to file"
        >
          {blocks.map((block) => (
            <li key={`${block.path}-${block.index}`} className="min-w-0">
              <button
                type="button"
                onClick={() => jumpTo(block.index)}
                title={`Jump to ${block.path}`}
                className="block max-w-[220px] cursor-pointer truncate rounded-md border border-input/40 bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {block.path}
              </button>
            </li>
          ))}
        </ul>
      )}

      {answer.body && answer.shape === "choice" && (
        <button
          type="button"
          data-slot="answer-body-toggle"
          onClick={() => setShowBody((open) => !open)}
          aria-expanded={showBody}
          className="flex w-fit cursor-pointer items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showBody ? (
            <ChevronDown className="size-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3" aria-hidden="true" />
          )}
          {showBody ? "Hide reasoning" : "Show reasoning"}
        </button>
      )}

      {answer.body && showBody && (
        <div ref={bodyRef} data-slot="answer-body">
          <Markdown isStreaming={isStreaming}>{answer.body}</Markdown>
        </div>
      )}
    </div>
  );
};
