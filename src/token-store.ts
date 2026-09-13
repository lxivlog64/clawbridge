import fs from "node:fs/promises";
import path from "node:path";
import type { TokenSet } from "./types.js";

interface StoredData {
  token?: TokenSet;
  pendingOAuthState?: string;
}

export class TokenStore {
  constructor(private readonly filename: string) {}

  private async readData(): Promise<StoredData> {
    try {
      const raw = await fs.readFile(this.filename, "utf8");
      return JSON.parse(raw) as StoredData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeData(data: StoredData): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.filename);
    await fs.chmod(this.filename, 0o600);
  }

  async getToken(): Promise<TokenSet | undefined> {
    return (await this.readData()).token;
  }

  async saveToken(token: TokenSet): Promise<void> {
    const data = await this.readData();
    data.token = token;
    delete data.pendingOAuthState;
    await this.writeData(data);
  }

  async savePendingState(state: string): Promise<void> {
    const data = await this.readData();
    data.pendingOAuthState = state;
    await this.writeData(data);
  }

  async verifyPendingState(state: string): Promise<void> {
    const data = await this.readData();
    if (!data.pendingOAuthState || data.pendingOAuthState !== state) {
      throw new Error("OAuth state mismatch; refusing to exchange the authorization code.");
    }
  }
}
