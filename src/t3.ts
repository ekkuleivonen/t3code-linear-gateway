import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.ts";
import { readState, updateState } from "./store.ts";

/**
 * Talks to T3 Code hosts through their MCP servers.
 *
 * Each host is signed in once through T3's OAuth flow (/t3/connect/<host>).
 * T3 sign-ins last 30 days and cannot be refreshed, so a host then needs to
 * be connected again.
 */

const SCOPE = "orchestration:read orchestration:operate";

/** Thrown when a host has no valid sign-in. */
export class NeedsSignIn extends Error {
  host: string;
  constructor(host: string) {
    super(`T3 host ${host} needs to be signed in again`);
    this.host = host;
  }
}

export function connectUrl(host: string): string {
  return `${config.publicUrl}/t3/connect/${encodeURIComponent(host)}`;
}

/**
 * Stores one host's OAuth state in the state file.
 * While connecting, existing tokens are hidden so the SDK starts a new sign-in,
 * but they are only replaced once the new sign-in completes.
 */
class HostAuth implements OAuthClientProvider {
  host: string;
  connecting: boolean;
  authorizationUrl?: URL;

  constructor(host: string, connecting = false) {
    this.host = host;
    this.connecting = connecting;
  }

  get redirectUrl(): string {
    return `${config.publicUrl}/t3/callback/${encodeURIComponent(this.host)}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "T3 Code Linear Gateway",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readState().t3[this.host]?.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    updateState((state) => {
      state.t3[this.host] = { ...state.t3[this.host], client };
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.connecting ? undefined : readState().t3[this.host]?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateState((state) => {
      state.t3[this.host] = { ...state.t3[this.host], tokens, signedInAt: Date.now() };
    });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    updateState((state) => {
      state.t3[this.host] = { ...state.t3[this.host], codeVerifier };
    });
  }

  codeVerifier(): string {
    const verifier = readState().t3[this.host]?.codeVerifier;
    if (!verifier) {
      throw new Error(`No sign-in in progress for ${this.host}`);
    }
    return verifier;
  }
}

function hostUrl(host: string): string {
  const url = config.t3Hosts[host];
  if (!url) {
    throw new Error(`Unknown T3 host ${host}`);
  }
  return url;
}

/** Start signing in to a host. Returns the T3 sign-in page to send the browser to. */
export async function startSignIn(host: string): Promise<string> {
  const provider = new HostAuth(host, true);
  await auth(provider, { serverUrl: hostUrl(host), scope: SCOPE });
  if (!provider.authorizationUrl) {
    throw new Error(`T3 host ${host} did not return a sign-in page`);
  }
  return provider.authorizationUrl.toString();
}

/** Finish signing in to a host with the code T3 redirected back with. */
export async function finishSignIn(host: string, code: string): Promise<void> {
  const provider = new HostAuth(host, true);
  await auth(provider, { serverUrl: hostUrl(host), authorizationCode: code, scope: SCOPE });
}

/** Call one T3 MCP tool and return its result as JSON. */
export async function callTool(
  host: string,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const client = new Client({ name: "t3code-linear-gateway", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(hostUrl(host)), {
    authProvider: new HostAuth(host),
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .map((part) => part.text ?? "")
      .join("\n");
    if (result.isError) {
      throw new Error(`T3 ${name} failed on ${host}: ${text}`);
    }
    if (result.structuredContent) {
      return result.structuredContent;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw new NeedsSignIn(host);
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Return the first array found in a tool result, e.g. { projects: [...] }. */
function firstArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  for (const item of Object.values(value ?? {})) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

export interface Placement {
  host: string;
  projectId: string;
}

/**
 * Find the host to run a repository on, among hosts that have the repository as a
 * T3 project. With LOAD_BALANCE_MODE=off, the first such host in T3_HOSTS order;
 * with "threads", the one with the fewest active threads.
 * Returns the placement, or the reasons no host could be used.
 */
export async function pickHost(
  ownerRepo: string
): Promise<{ placement?: Placement; problems: string[] }> {
  const problems: string[] = [];
  let best: (Placement & { running: number }) | undefined;

  for (const host of Object.keys(config.t3Hosts)) {
    try {
      const projects = firstArray(await callTool(host, "t3_project_list", { limit: 100 }));
      const project = projects.find((p) => {
        const key = String(p.repositoryIdentity?.canonicalKey ?? "").toLowerCase();
        return key.endsWith(`/${ownerRepo.toLowerCase()}`) && !p.archivedAt;
      });
      if (!project) continue;

      if (config.loadBalanceMode === "off") {
        return { placement: { host, projectId: project.id }, problems };
      }

      const active = await callTool(host, "t3_thread_list", {
        allProjects: true,
        statuses: ["queued", "starting", "running"],
        limit: 100,
      });
      const running = Number(active?.total ?? firstArray(active).length);
      if (!best || running < best.running) {
        best = { host, projectId: project.id, running };
      }
    } catch (error) {
      if (error instanceof NeedsSignIn) {
        problems.push(`${host} needs to be signed in: ${connectUrl(host)}`);
      } else {
        problems.push(`${host} is unreachable (${(error as Error).message})`);
      }
    }
  }

  return { placement: best && { host: best.host, projectId: best.projectId }, problems };
}

/** Start a thread in a new worktree. Returns its id and link. */
export async function launchThread(options: {
  placement: Placement;
  title: string;
  message: string;
  requestId: string;
}): Promise<{ threadId: string; link?: string }> {
  const result = await callTool(options.placement.host, "t3_thread_launch", {
    projectId: options.placement.projectId,
    title: options.title,
    message: options.message,
    runtimeMode: config.runtimeMode,
    // startFromOrigin: fetch the base branch first, so a stale local copy on the host
    // never becomes the starting point.
    workspaceStrategy: { type: "worktree", baseRef: config.baseBranch, startFromOrigin: true },
    clientRequestId: options.requestId,
  });
  const thread = result?.thread ?? result;
  const threadId = thread?.threadId ?? thread?.id;
  if (!threadId) {
    throw new Error(`T3 did not return a thread id: ${JSON.stringify(result)}`);
  }
  return { threadId, link: webLink(thread?.link ?? result?.link) };
}

/** Turn T3's "<t3-thread://v2/<environment>/<thread>>" link into a link to the T3 web app. */
function webLink(link: unknown): string | undefined {
  const match = String(link ?? "").match(/t3-thread:\/\/v2\/([^/>]+)\/([^/>]+)/);
  if (match) return `https://app.t3.codes/threads/${match[1]}/${match[2]}`;
  return typeof link === "string" && link.startsWith("https://") ? link : undefined;
}

export async function sendToThread(host: string, threadId: string, message: string): Promise<void> {
  await callTool(host, "t3_thread_send", { threadId, message, mode: "auto" });
}

export async function interruptThread(host: string, threadId: string): Promise<void> {
  await callTool(host, "t3_thread_interrupt", { threadId });
}
