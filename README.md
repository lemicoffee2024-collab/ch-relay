# ch-relay

An OpenAI-compatible local relay that lets coding agents (Codex, ZCode, OpenCode, OMP, Pi, and anything that speaks `chat/completions` or the Responses API) run on your own ChatGPT sign-in.

You run it on your own machine. It forwards requests upstream with your own account, keeps a local request/usage log, and exposes a small admin console.

## Requirements

- [Bun](https://bun.sh) 1.2+
- A Codex CLI sign-in (`codex login` → "Sign in with ChatGPT")

## Run

```sh
bun install
bun src/cli.ts start
```

Defaults: relay on `127.0.0.1:11500`, admin console on `127.0.0.1:11504`.

```sh
bun src/cli.ts start --port 11500 --admin-port 11504
bun src/cli.ts stop
```

## Point your harness at it

```sh
bun src/cli.ts sync      # writes ~/.codex/config.toml + the model catalog
bun src/cli.ts unsync    # reverts only the lines ch-relay wrote
```

Or set the base URL manually in any OpenAI-compatible client:

```
http://127.0.0.1:11500/v1
```

`POST /v1/chat/completions` and `POST /v1/responses` are supported; `GET /v1/models` lists the catalog.

## Importing accounts

```sh
bun src/cli.ts import    # import existing Codex/OpenCodex sign-ins
```

Tokens are stored locally in `~/.ch-relay/` (DPAPI-encrypted at rest on Windows).

## Share endpoint

The share lane lets other machines use the relay with their own ChatGPT login — callers authenticate with their own ChatGPT access token, nothing is stored server-side beyond salted request statistics.

```sh
bun src/cli.ts allow add someone@example.com --hours 720
bun src/cli.ts allow list
```

With an empty allowlist the share endpoint accepts any valid ChatGPT token — restrict it before exposing the port.

## Notes

- All traffic to upstream goes through this process: the machine running it can see tokens and request content. Only run or expose relays you control.
- Bind address is loopback by default; use a tunnel (Tailscale, cloudflared) if you need remote access.
