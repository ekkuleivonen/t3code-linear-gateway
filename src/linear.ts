import { LinearClient } from "@linear/sdk";
import { config } from "./config.ts";
import { readState, updateState, type LinearToken } from "./store.ts";

/**
 * Linear OAuth, adapted from Linear's weather-bot example.
 * The app installs as itself (actor=app) so issues can be delegated to it.
 */

const redirectUri = () => `${config.publicUrl}/oauth/callback`;

export function linearAuthorizeUrl(): string {
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", config.linearClientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
  url.searchParams.set("actor", "app");
  return url.toString();
}

/** Exchange the OAuth code for a token and store it. Returns the workspace name. */
export async function finishLinearInstall(code: string): Promise<string> {
  const token = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  const client = new LinearClient({ accessToken: token.access_token });
  const organization = await client.organization;
  updateState((state) => {
    state.linear[organization.id] = token;
  });
  return organization.name;
}

/** A Linear client for a workspace, refreshing the token when it is about to expire. */
export async function linearClient(organizationId: string): Promise<LinearClient> {
  let token = readState().linear[organizationId];
  if (!token) {
    throw new Error(`Gateway is not installed in Linear workspace ${organizationId}`);
  }
  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    const refreshed = await requestToken({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    updateState((state) => {
      state.linear[organizationId] = refreshed;
    });
    token = refreshed;
  }
  return new LinearClient({ accessToken: token.access_token });
}

async function requestToken(params: Record<string, string>): Promise<LinearToken> {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: config.linearClientId,
      client_secret: config.linearClientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`Linear token request failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export interface IssueInfo {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  repoLabels: { name: string; description: string | null }[];
  hasSubIssues: boolean;
}

/** Fetch what the gateway needs to route an issue: its Repo label and whether it has sub-issues. */
export async function getIssue(client: LinearClient, issueId: string): Promise<IssueInfo> {
  const result = await client.client.rawRequest<
    {
      issue: {
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        labels: {
          nodes: { name: string; description: string | null; parent: { name: string } | null }[];
        };
        children: { nodes: { id: string }[] };
      };
    },
    { id: string }
  >(
    `query GatewayIssue($id: String!) {
      issue(id: $id) {
        identifier
        title
        description
        url
        labels { nodes { name description parent { name } } }
        children(first: 1) { nodes { id } }
      }
    }`,
    { id: issueId }
  );
  const issue = result.data!.issue;
  return {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    repoLabels: issue.labels.nodes
      .filter((label) => label.parent?.name === config.repoLabelGroup)
      .map(({ name, description }) => ({ name, description })),
    hasSubIssues: issue.children.nodes.length > 0,
  };
}

type ActivityContent =
  | { type: "thought" | "response" | "elicitation" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export async function postActivity(
  client: LinearClient,
  agentSessionId: string,
  content: ActivityContent
): Promise<void> {
  await client.createAgentActivity({ agentSessionId, content });
}
