export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  openId?: string;
  expiresAt: number;
}

export interface WorkBuddyEnvelope<T> {
  code: number;
  msg: string;
  request_id?: string;
  data: T;
}

export interface WorkBuddyMessage {
  message_id: string;
  role: "user" | "assistant" | string;
  content: unknown[];
  msg_type: string;
  created_at: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

export interface CloudTask {
  task_id: string;
  status: string;
  name?: string;
  link?: string;
  token?: string;
  expire_at?: number;
  sandboxLink?: string;
  sandboxDataLink?: string;
}
