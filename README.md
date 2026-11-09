# t3code-linear-gateway

Delegate a Linear issue to **T3**, and the gateway starts a [T3 Code](https://github.com/pingdotgg/t3code)
thread for it, in a new git worktree, on one of your own machines.

```
Linear issue delegated to "T3"
  → webhook → this gateway
     → picks a T3 host that has the issue's repository as a project
     → starts a thread there (T3 MCP: t3_thread_launch, worktree)
  ← posts the thread link back to the Linear session
```

Replies in the Linear session are sent to the same thread, and **Stop** in Linear interrupts it.

It is a small Node server with two dependencies, adapted from Linear's
[weather-bot](https://github.com/linear/weather-bot) example agent.

## How issues are routed

Every issue the gateway works on maps to exactly one repository:

- Add a **label group** named `Repo` in Linear, with one label per repository.
  Each label's **description starts with `owner/repo`**, for example `row-and-reason/iac`.
- An issue needs **exactly one** `Repo` label. Work that spans repositories is split into
  sub-issues, one per repository, and each sub-issue is delegated on its own.
- Issues with sub-issues are not run themselves.

The gateway asks in Linear when an issue breaks these rules. Add the label and reply to continue.

The thread runs on a T3 host whose projects include that repository (matched by git remote).
When several hosts have it, the one with the fewest running threads is used.

## Setup

### 1. T3 hosts

On each machine that should run threads:

1. Add the repositories as T3 projects.
2. Turn on T3 Connect: **Settings → Sharing & access** in the desktop app, or `t3 connect` on a
   command-line host. The gateway needs an HTTPS address; T3 sign-in does not work over plain HTTP.
3. Copy the MCP URL: **Settings → Environments → ⋯ → Copy MCP URL**.

### 2. Linear app

In Linear, go to **Settings → API → OAuth applications → New**:

- **Redirect URI:** `https://<gateway>/oauth/callback`
- **Webhooks:** on, URL `https://<gateway>/webhook`, events **Agent session events**
- Leave the app **private** to your workspace.

Copy the client ID, client secret and webhook signing secret.

### 3. Configure and run

```sh
cp .env.example .env   # fill in PUBLIC_URL, the Linear values and T3_HOSTS
docker compose up -d --build
```

The container listens on `127.0.0.1:3000`. Expose it at `PUBLIC_URL` with a tunnel or reverse
proxy, for example a Cloudflare Tunnel ingress rule:

```yaml
- hostname: t3code-linear-gateway.example.com
  service: http://localhost:3000
```

Sign-ins and session links are stored in the `data` volume.

### 4. Connect

1. Open `https://<gateway>/oauth/authorize` and approve the app for your Linear workspace.
   It shows up as a member you can delegate issues to.
2. Open `https://<gateway>/t3` and follow the sign-in link for each host. T3's sign-in page asks
   for a code: create one in T3 under **Settings → Sharing & access** (or `t3 auth pairing create`
   on the host). The access level you approve, such as **Supervised**, is the most any thread
   the gateway starts can do.

T3 sign-ins last **30 days**. After that, the gateway reports in Linear which host needs signing in
again, with the link.

## Configuration

| Variable | Required | |
|---|---|---|
| `PUBLIC_URL` | yes | Public HTTPS address of the gateway |
| `LINEAR_CLIENT_ID` | yes | Linear OAuth app |
| `LINEAR_CLIENT_SECRET` | yes | Linear OAuth app |
| `LINEAR_WEBHOOK_SECRET` | yes | Linear OAuth app webhook signing secret |
| `T3_HOSTS` | yes | `name=mcp-url` pairs, comma-separated |
| `REPO_LABEL_GROUP` | no | Label group naming the repository, default `Repo` |
| `T3_BASE_BRANCH` | no | Branch new worktrees start from, default T3's choice |
| `PORT` | no | Default `3000` |
| `DATA_DIR` | no | Default `/data` in the container |

## Routes

| Route | |
|---|---|
| `GET /` | Health check |
| `GET /oauth/authorize`, `/oauth/callback` | Install in Linear |
| `POST /webhook` | Linear agent session webhooks |
| `GET /t3` | T3 hosts and sign-in status |
| `GET /t3/connect/<host>`, `/t3/callback/<host>` | Sign in to a T3 host |

## Security notes

- Text in a Linear issue becomes a prompt for an agent on your machine. Approve T3 sign-ins at the
  lowest access level that works, and keep the Linear app private.
- Webhooks are verified with the Linear signing secret.
- Anyone can open the T3 sign-in links, but finishing a sign-in needs a code from your T3 host,
  and a new sign-in only replaces the old one once it succeeds.

## Development

Needs Node 24 or later, which runs the TypeScript directly.

```sh
npm install
npm run check   # type-check
npm start       # reads configuration from the environment
```

## License

MIT
