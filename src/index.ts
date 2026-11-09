import http from "node:http";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { handleAgentSessionEvent } from "./agent.ts";
import { config } from "./config.ts";
import { finishLinearInstall, linearAuthorizeUrl } from "./linear.ts";
import { readState } from "./store.ts";
import { connectUrl, finishSignIn, startSignIn } from "./t3.ts";
import { resumeWatches } from "./watch.ts";

/**
 * Routes:
 *   GET  /                    health check
 *   GET  /oauth/authorize     install the app in a Linear workspace
 *   GET  /oauth/callback      Linear OAuth callback
 *   POST /webhook             Linear agent session webhooks
 *   GET  /t3                  T3 hosts and their sign-in status
 *   GET  /t3/connect/<host>   sign in to a T3 host
 *   GET  /t3/callback/<host>  T3 OAuth callback
 */

const webhookHandler = new LinearWebhookClient(config.linearWebhookSecret).createHandler();
const seenEvents = new Set<string>();

webhookHandler.on("AgentSessionEvent", (payload) => {
  // Linear may resend a delivery; handle each event once. `webhookId` names the app's
  // webhook, the same for every delivery, so the key is the session and its activity:
  // a new session has none, and each reply or Stop is its own activity.
  const key = [payload.action, payload.agentSession.id, payload.agentActivity?.id ?? ""].join(":");
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  if (seenEvents.size > 1000) seenEvents.clear();

  // Answer the webhook right away and do the work in the background.
  handleAgentSessionEvent(payload).catch((error) => {
    console.error("Failed to handle agent session event:", error);
  });
});

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" }
): void {
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function hostStatus(): string {
  const state = readState();
  return Object.keys(config.t3Hosts)
    .map((host) => {
      const signedInAt = state.t3[host]?.signedInAt;
      const status = signedInAt
        ? `signed in ${new Date(signedInAt).toISOString()} (lasts 30 days)`
        : "not signed in";
      return `${host}: ${status}\n  sign in: ${connectUrl(host)}`;
    })
    .join("\n");
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", config.publicUrl);
  const [, first, second, host] = url.pathname.split("/").map(decodeURIComponent);

  if (req.method === "POST" && url.pathname === "/webhook") {
    return webhookHandler(req, res);
  }
  if (req.method !== "GET") {
    return send(res, 405, "Method not allowed");
  }

  if (url.pathname === "/") {
    return send(res, 200, "t3code-linear-gateway is running");
  }

  if (url.pathname === "/oauth/authorize") {
    return redirect(res, linearAuthorizeUrl());
  }

  if (url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      return send(res, 400, `Linear OAuth error: ${url.searchParams.get("error") ?? "no code"}`);
    }
    const workspace = await finishLinearInstall(code);
    return send(res, 200, `Installed in Linear workspace ${workspace}.`);
  }

  if (url.pathname === "/t3") {
    return send(res, 200, hostStatus());
  }

  if (first === "t3" && host && host in config.t3Hosts) {
    if (second === "connect") {
      return redirect(res, await startSignIn(host));
    }
    if (second === "callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return send(res, 400, `T3 sign-in error: ${url.searchParams.get("error") ?? "no code"}`);
      }
      await finishSignIn(host, code);
      return send(res, 200, `Signed in to ${host}.\n\n${hostStatus()}`);
    }
  }

  return send(res, 404, "Not found");
}

http
  .createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(`${req.method} ${req.url} failed:`, error);
      if (!res.headersSent) send(res, 500, `Error: ${(error as Error).message}`);
    });
  })
  .listen(config.port, () => {
    console.log(`t3code-linear-gateway listening on port ${config.port}`);
    console.log(hostStatus());
    // Sessions whose T3 run was still working when the gateway stopped.
    resumeWatches();
  });
