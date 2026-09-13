import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import type { BridgeConfig } from "./config.js";
import { requireOAuthConfig } from "./config.js";
import { TokenStore } from "./token-store.js";
import type { TokenSet } from "./types.js";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  open_id?: string;
}

function toTokenSet(response: TokenResponse): TokenSet {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type ?? "Bearer",
    scope: response.scope,
    openId: response.open_id,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
}

export class WorkBuddyOAuth {
  constructor(
    private readonly config: BridgeConfig,
    private readonly store: TokenStore,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async authorizationUrl(): Promise<{ url: string; state: string }> {
    requireOAuthConfig(this.config);
    const state = crypto.randomBytes(24).toString("base64url");
    await this.store.savePendingState(state);
    const url = new URL(`${this.config.apiBaseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set(
      "scope",
      "user.localassistant.readable user.localassistant.invokable user.task.readable user.task.invokable",
    );
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  async exchangeCode(code: string, state: string): Promise<TokenSet> {
    requireOAuthConfig(this.config);
    await this.store.verifyPendingState(state);
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    requireOAuthConfig(this.config);
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
    const response = await this.fetchFn(`${this.config.apiBaseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    const body = (await response.json()) as TokenResponse | { msg?: string };
    if (!response.ok || !("access_token" in body)) {
      throw new Error(
        `WorkBuddy token request failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    const token = toTokenSet(body);
    await this.store.saveToken(token);
    return token;
  }

  async authenticateInteractively(openBrowser = true): Promise<TokenSet> {
    const redirect = new URL(this.config.redirectUri);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname)) {
      throw new Error("Interactive auth currently requires an http://127.0.0.1 or localhost redirect URI.");
    }
    const port = Number(redirect.port || 80);
    const { url, state } = await this.authorizationUrl();

    const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "/", this.config.redirectUri);
        if (requestUrl.pathname !== redirect.pathname) {
          response.writeHead(404).end("Not found");
          return;
        }
        const code = requestUrl.searchParams.get("code");
        const returnedState = requestUrl.searchParams.get("state");
        if (!code || !returnedState) {
          response.writeHead(400).end("Missing code or state");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("WorkBuddy authorization completed. You may close this window.");
        server.close();
        resolve({ code, state: returnedState });
      });
      server.once("error", reject);
      server.listen(port, redirect.hostname);
      setTimeout(() => {
        server.close();
        reject(new Error("OAuth authorization timed out after five minutes."));
      }, 5 * 60 * 1000).unref();
    });

    process.stderr.write(`Open this URL to authorize WorkBuddy:\n${url}\n`);
    if (openBrowser) openUrl(url);
    const callback = await result;
    if (callback.state !== state) {
      throw new Error("OAuth state mismatch.");
    }
    return this.exchangeCode(callback.code, callback.state);
  }
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0] as string, command[1] as string[], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
