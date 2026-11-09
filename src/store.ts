import fs from "node:fs";
import path from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.ts";

/**
 * Everything the gateway remembers lives in one JSON file in DATA_DIR.
 * Mount DATA_DIR as a volume so sign-ins survive restarts.
 */

export interface LinearToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface T3HostAuth {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  signedInAt?: number;
  codeVerifier?: string;
}

/** Which T3 thread a Linear agent session is driving. */
export interface SessionLink {
  host: string;
  threadId: string;
  link?: string;
}

interface State {
  linear: Record<string, LinearToken>;
  t3: Record<string, T3HostAuth>;
  sessions: Record<string, SessionLink>;
}

const file = path.join(config.dataDir, "state.json");

export function readState(): State {
  if (!fs.existsSync(file)) {
    return { linear: {}, t3: {}, sessions: {} };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as State;
}

export function updateState(change: (state: State) => void): void {
  const state = readState();
  change(state);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(`${file}.tmp`, file);
}
