import type { BridgeConfig } from "./config.js";
import { WorkBuddyOAuth } from "./oauth.js";
import { TokenStore } from "./token-store.js";
import type {
  CloudTask,
  TokenSet,
  WorkBuddyEnvelope,
  WorkBuddyMessage,
} from "./types.js";

export class WorkBuddyClient {
  private readonly oauth: WorkBuddyOAuth;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: TokenStore,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.oauth = new WorkBuddyOAuth(config, store, fetchFn);
  }

  async online(): Promise<boolean> {
    const envelope = await this.request<WorkBuddyEnvelope<{ online: boolean }>>(
      "/localassistant",
    );
    return envelope.data.online;
  }

  async sendMessage(
    content: string,
    msgType: "text" | "permission_response" = "text",
  ): Promise<string> {
    const envelope = await this.request<WorkBuddyEnvelope<{ message_id: string }>>(
      "/localassistant/message",
      {
        method: "POST",
        body: JSON.stringify({ content, msg_type: msgType }),
      },
    );
    return envelope.data.message_id;
  }

  async history(options: {
    messageId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<WorkBuddyMessage[]> {
    const url = new URL(`${this.config.apiBaseUrl}/localassistant/message`);
    if (options.messageId) url.searchParams.set("message_id", options.messageId);
    else {
      if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    }
    const envelope = await this.request<WorkBuddyEnvelope<{ messages: WorkBuddyMessage[] }>>(
      url,
    );
    return envelope.data.messages;
  }

  async waitForReply(
    afterMessageId: string,
    timeoutMs = 30_000,
    pollIntervalMs = 1_500,
  ): Promise<WorkBuddyMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = await this.history({ messageId: afterMessageId });
      if (messages.some((message) => message.role === "assistant")) return messages;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return [];
  }

  async createCloudTask(prompt: string, name?: string): Promise<CloudTask> {
    return this.request<CloudTask>("/tasks", {
      method: "POST",
      body: JSON.stringify({ prompt, ...(name ? { name } : {}) }),
    });
  }

  private async validToken(forceRefresh = false): Promise<TokenSet> {
    const token = await this.store.getToken();
    if (!token) throw new Error("WorkBuddy is not authorized. Run: workbuddy-bridge auth");
    const shouldRefresh = forceRefresh || token.expiresAt <= Date.now() + 60_000;
    if (!shouldRefresh) return token;
    if (!token.refreshToken) throw new Error("WorkBuddy access token expired and no refresh token is available.");
    return this.oauth.refresh(token.refreshToken);
  }

  private async request<T>(
    pathOrUrl: string | URL,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const token = await this.validToken();
    const url = pathOrUrl instanceof URL ? pathOrUrl : `${this.config.apiBaseUrl}${pathOrUrl}`;
    const response = await this.fetchFn(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
        authorization: `${token.tokenType} ${token.accessToken}`,
      },
    });

    if (response.status === 401 && retry && token.refreshToken) {
      await this.validToken(true);
      return this.request<T>(pathOrUrl, init, false);
    }

    const body = (await response.json()) as T & { code?: number; msg?: string };
    if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
      throw new Error(
        `WorkBuddy API request failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
}
