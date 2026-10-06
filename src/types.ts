// Shared contracts between the server core and provider modules.

export type ProviderId = "chatgpt" | "antigravity" | "opencode-zen" | "opencode-go";

/** Slug prefix used in the Codex catalog for each provider. ChatGPT models are bare (or `openai/`). */
export const PROVIDER_PREFIX: Record<ProviderId, string> = {
  chatgpt: "openai",
  antigravity: "google-antigravity",
  "opencode-zen": "opencode-zen",
  "opencode-go": "opencode-go",
};

/** Loose shape of an OpenAI Responses API request body as sent by Codex. */
export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input?: ResponsesInputItem[] | string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string } | null;
  text?: Record<string, unknown>;
  store?: boolean;
  stream?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  service_tier?: string;
  [key: string]: unknown;
}

export type ResponsesInputItem = Record<string, unknown> & { type?: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface Account {
  id: string;
  provider: ProviderId;
  label: string;
  email: string | null;
  /** Provider-specific secret material (tokens / api key). Never sent to the GUI. */
  credential: Record<string, unknown>;
  /** Provider-specific non-secret metadata (plan, projectId, ...). */
  meta: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  status: "ok" | "needs_reauth" | "error";
  statusDetail: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Result a provider reports for one logical request (for the usage log). */
export interface RequestOutcome {
  accountId: string | null;
  servedModel: string;
  status: number;
  usage?: Usage;
  error?: string;
  firstTokenMs?: number;
  /** Autocut path tag: how the stream ended (toolpad/eof/…) or why it was
   *  bypassed — recorded for coverage metering only. */
  cut?: string;
}

export interface ProviderContext {
  body: ResponsesRequest;
  /** Model id local to the provider (prefix stripped). */
  model: string;
  /** Requested slug exactly as Codex sent it. */
  requestedModel: string;
  effort: string | undefined;
  headers: Headers;
  /** Stable per-conversation key (session-id / thread-id), if Codex sent one. */
  sessionKey: string | undefined;
  signal: AbortSignal;
  startedAt: number;
  /** Must be called exactly once when the request finishes (after the stream ends). */
  finish(outcome: RequestOutcome): void;
}

export interface CatalogModel {
  /** Slug written to the Codex catalog (e.g. `gpt-6-sol`, `google-antigravity/gemini-3.1-pro`). */
  slug: string;
  displayName: string;
  provider: ProviderId;
  contextWindow: number;
  reasoningLevels: string[];
  defaultReasoning: string;
  inputModalities: Array<"text" | "image">;
  hidden?: boolean;
  /** Full raw Codex catalog entry to use verbatim (ChatGPT baseline). */
  raw?: Record<string, unknown>;
}

export interface Provider {
  id: ProviderId;
  /** Handle POST /v1/responses. Must return a streaming SSE Response (or JSON error). */
  handle(ctx: ProviderContext): Promise<Response>;
  /** Handle POST /v1/responses/compact (optional). */
  compact?(ctx: ProviderContext): Promise<Response>;
  /** Models this provider offers (used for Codex catalog sync and GUI). */
  models(): Promise<CatalogModel[]>;
  /** OAuth login flow (ChatGPT, Antigravity). */
  login?: LoginFlow;
  /** Add an API-key account (OpenCode). Should validate the key before storing. */
  addApiKey?(apiKey: string, label?: string): Promise<Account>;
  /** Refresh quota snapshot for one account (stored via setQuota). */
  refreshQuota?(account: Account): Promise<void>;
}

export interface LoginStart {
  loginId: string;
  /** Browser URL to open (authorization-code flow). */
  authUrl?: string;
  /** Device-code flow. */
  userCode?: string;
  verificationUrl?: string;
}

export type LoginStatus =
  | { state: "pending" }
  | { state: "done"; accountId: string; email: string | null }
  | { state: "error"; message: string };

export interface LoginFlow {
  start(opts?: { device?: boolean }): Promise<LoginStart>;
  status(loginId: string): LoginStatus;
  cancel(loginId: string): void;
}
