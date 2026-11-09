import { linearClient, postActivity } from "./linear.ts";
import { readState, updateState } from "./store.ts";
import { runAnswer, waitForRun } from "./t3.ts";

/**
 * Follows the T3 run behind a Linear agent session and ends the session when the run
 * ends. While the run works, the session stays active, so Linear shows Stop.
 *
 * Every reply or Stop starts a new generation for its session. A watcher posts only
 * while its generation is current, so an older run never answers after a newer one.
 */

// Short waits stay well inside proxy timeouts; T3 itself allows up to an hour.
const WAIT_MS = 4 * 60 * 1000;
// Linear's reply limit is generous; keep the answer readable and link the rest.
const MAX_ANSWER_CHARS = 6000;

const generations = new Map<string, number>();

/** Start a new generation for a session, so its current watcher stops posting. */
export function nextGeneration(sessionId: string): number {
  const generation = (generations.get(sessionId) ?? 0) + 1;
  generations.set(sessionId, generation);
  return generation;
}

function isCurrent(sessionId: string, generation: number): boolean {
  return generations.get(sessionId) === generation;
}

/** Remember the run to watch, then follow it in the background. */
export function watchRun(sessionId: string, runId: string): void {
  updateState((state) => {
    const link = state.sessions[sessionId];
    if (link) link.runId = runId;
  });
  const generation = nextGeneration(sessionId);
  follow(sessionId, runId, generation).catch((error) => {
    console.error(`Watching session ${sessionId} failed:`, error);
  });
}

/** After a restart, follow every run that was still being watched. */
export function resumeWatches(): void {
  for (const [sessionId, link] of Object.entries(readState().sessions)) {
    if (link.runId && link.organizationId) watchRun(sessionId, link.runId);
  }
}

/** Stop watching a session's run, for example after Stop. */
export function forgetRun(sessionId: string): void {
  nextGeneration(sessionId);
  updateState((state) => {
    const link = state.sessions[sessionId];
    if (link) delete link.runId;
  });
}

async function follow(sessionId: string, runId: string, generation: number): Promise<void> {
  const link = readState().sessions[sessionId];
  if (!link?.organizationId) return;

  let status = "";
  for (;;) {
    try {
      const wait = await waitForRun(link.host, link.threadId, runId, WAIT_MS);
      if (!wait.timedOut) {
        status = wait.status;
        break;
      }
    } catch (error) {
      // The host may be restarting or offline; keep the session open and try again.
      console.error(`Waiting for ${link.host} run ${runId} failed:`, error);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    if (!isCurrent(sessionId, generation)) return;
  }
  if (!isCurrent(sessionId, generation)) return;

  const client = await linearClient(link.organizationId);
  const thread = link.link ? `[T3 thread](${link.link})` : "T3 thread";

  if (status === "completed" || status === "waiting") {
    const answer = await runAnswer(link.host, link.threadId, runId);
    let body = answer?.text.trim() || `The ${thread} on ${link.host} finished without a reply.`;
    if (answer && (answer.truncated || body.length > MAX_ANSWER_CHARS)) {
      body = `${body.slice(0, MAX_ANSWER_CHARS).trimEnd()}…\n\nThe full reply is in the ${thread}.`;
    }
    if (!isCurrent(sessionId, generation)) return;
    // waiting: the thread asked something; an elicitation lets the reply go back to it.
    await postActivity(client, sessionId, {
      type: status === "waiting" ? "elicitation" : "response",
      body,
    });
  } else if (status === "interrupted" || status === "cancelled") {
    await postActivity(client, sessionId, {
      type: "response",
      body: `The ${thread} on ${link.host} was stopped.`,
    });
  } else {
    await postActivity(client, sessionId, {
      type: "error",
      body: `The ${thread} on ${link.host} ended with status "${status}".`,
    });
  }

  if (isCurrent(sessionId, generation)) {
    updateState((state) => {
      const current = state.sessions[sessionId];
      if (current?.runId === runId) delete current.runId;
    });
  }
}
