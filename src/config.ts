/**
 * All configuration comes from environment variables. See .env.example.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Parse T3_HOSTS, a comma-separated list of name=mcp-url pairs:
 * "t3-01=https://a.example/mcp,t3-02=https://b.example/mcp"
 */
function parseHosts(value: string): Record<string, string> {
  const hosts: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const [name, url] = entry.split("=").map((part) => part.trim());
    if (!name || !url) {
      throw new Error(`Invalid T3_HOSTS entry "${entry}", expected name=url`);
    }
    hosts[name] = url;
  }
  return hosts;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
  dataDir: process.env.DATA_DIR ?? "./data",
  linearClientId: required("LINEAR_CLIENT_ID"),
  linearClientSecret: required("LINEAR_CLIENT_SECRET"),
  linearWebhookSecret: required("LINEAR_WEBHOOK_SECRET"),
  repoLabelGroup: process.env.REPO_LABEL_GROUP ?? "Repo",
  baseBranch: process.env.T3_BASE_BRANCH || undefined,
  t3Hosts: parseHosts(required("T3_HOSTS")),
};
