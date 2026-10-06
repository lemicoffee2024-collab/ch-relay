import type { Provider, ProviderId } from "../types.ts";
import { chatgptProvider } from "./chatgpt/index.ts";
import { antigravityProvider } from "./antigravity/index.ts";
import { opencodeGoProvider, opencodeZenProvider } from "./opencode/index.ts";

export const providers: Record<ProviderId, Provider> = {
  chatgpt: chatgptProvider,
  antigravity: antigravityProvider,
  "opencode-zen": opencodeZenProvider,
  "opencode-go": opencodeGoProvider,
};
