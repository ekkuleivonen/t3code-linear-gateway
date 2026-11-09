import type { LinearClient } from "@linear/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import { config } from "./config.ts";
import { getIssue, linearClient, postActivity, type IssueInfo } from "./linear.ts";
import { readState, updateState } from "./store.ts";
import {
  interruptThread,
  launchThread,
  NeedsSignIn,
  connectUrl,
  pickHost,
  sendToThread,
} from "./t3.ts";

/**
 * Handles agent sessions: an issue delegated to (or mentioning) the gateway in Linear.
 *
 * - First message: check the issue's Repo label, pick a T3 host, start a thread.
 * - Later messages: forward them to the same thread.
 * - Stop: interrupt the thread.
 */
export async function handleAgentSessionEvent(
  webhook: AgentSessionEventWebhookPayload
): Promise<void> {
  const sessionId = webhook.agentSession.id;
  const client = await linearClient(webhook.organizationId);

  try {
    const link = readState().sessions[sessionId];
    const activity = webhook.agentActivity;

    if (webhook.action === "prompted" && link && activity?.signal === "stop") {
      await interruptThread(link.host, link.threadId);
      await postActivity(client, sessionId, {
        type: "response",
        body: `Stopped the T3 thread on ${link.host}.`,
      });
      return;
    }

    if (webhook.action === "prompted" && link) {
      const body = (activity?.content as { body?: string } | undefined)?.body ?? "";
      await sendToThread(link.host, link.threadId, body);
      await postActivity(client, sessionId, {
        type: "response",
        body: `Sent to the ${threadRef(link.link)} on ${link.host}.`,
      });
      return;
    }

    // A new session, or a reply to a session that has no thread yet (for example
    // after the gateway asked for a Repo label).
    await startThread(client, webhook);
  } catch (error) {
    const body =
      error instanceof NeedsSignIn
        ? `${error.message}. Sign it in at ${connectUrl(error.host)} and try again.`
        : `Gateway error: ${(error as Error).message}`;
    await postActivity(client, sessionId, { type: "error", body });
  }
}

async function startThread(
  client: LinearClient,
  webhook: AgentSessionEventWebhookPayload
): Promise<void> {
  const sessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  // Linear expects an activity within 10 seconds.
  await postActivity(client, sessionId, {
    type: "thought",
    body: `Checking the issue's ${config.repoLabelGroup} label.`,
  });

  if (!issueId) {
    await postActivity(client, sessionId, {
      type: "elicitation",
      body: "I can only work on issues. Delegate an issue to me instead.",
    });
    return;
  }

  const issue = await getIssue(client, issueId);
  const ownerRepo = checkIssue(issue);
  if (typeof ownerRepo !== "string") {
    await postActivity(client, sessionId, { type: "elicitation", body: ownerRepo.problem });
    return;
  }

  const { placement, problems } = await pickHost(ownerRepo);
  if (!placement) {
    const reasons = problems.length ? `\n\n- ${problems.join("\n- ")}` : "";
    await postActivity(client, sessionId, {
      type: "error",
      body: `No T3 host has \`${ownerRepo}\` as a project.${reasons}`,
    });
    return;
  }

  await postActivity(client, sessionId, {
    type: "action",
    action: "Starting T3 thread",
    parameter: `${ownerRepo} on ${placement.host}`,
  });

  const thread = await launchThread({
    placement,
    title: `${issue.identifier}: ${issue.title}`,
    message: buildPrompt(issue, webhook),
    requestId: sessionId,
  });

  updateState((state) => {
    state.sessions[sessionId] = { host: placement.host, ...thread };
  });

  if (thread.link) {
    await client.updateAgentSession(sessionId, {
      externalUrls: [{ label: `T3 thread on ${placement.host}`, url: thread.link }],
    });
  }

  await postActivity(client, sessionId, {
    type: "response",
    body:
      `Started a ${threadRef(thread.link)} for \`${ownerRepo}\` on ${placement.host}, ` +
      `in a new worktree. Reply here to send it messages.`,
  });
}

/**
 * The routing rule: an issue runs in exactly one repository, named by its Repo label.
 * Issues that span repositories are split into sub-issues, and each sub-issue is delegated.
 * Returns the label's "owner/repo", or the problem to report back.
 */
function checkIssue(issue: IssueInfo): string | { problem: string } {
  const group = config.repoLabelGroup;
  if (issue.hasSubIssues) {
    return {
      problem: `${issue.identifier} has sub-issues. Delegate each sub-issue to me instead.`,
    };
  }
  if (issue.repoLabels.length !== 1) {
    return {
      problem:
        `${issue.identifier} needs exactly one ${group} label. Add one and reply here. ` +
        `If the work spans several repositories, split it into one sub-issue per repository.`,
    };
  }
  const label = issue.repoLabels[0]!;
  const ownerRepo = label.description?.match(/[\w.-]+\/[\w.-]+/)?.[0];
  if (!ownerRepo) {
    return {
      problem:
        `The ${group} label "${label.name}" doesn't name a repository, so there is nothing ` +
        `for T3 to work on. Its description should start with owner/repo.`,
    };
  }
  return ownerRepo;
}

function threadRef(link: string | undefined): string {
  return link ? `[T3 thread](${link})` : "T3 thread";
}

function buildPrompt(issue: IssueInfo, webhook: AgentSessionEventWebhookPayload): string {
  const context =
    webhook.promptContext ??
    `<issue identifier="${issue.identifier}">\n<title>${issue.title}</title>\n` +
      `<description>${issue.description ?? ""}</description>\n</issue>`;
  return [
    `You are working on Linear issue ${issue.identifier} (${issue.url}).`,
    `Include ${issue.identifier} in your branch name and pull request title so Linear links them to the issue.`,
    "",
    context,
  ].join("\n");
}
