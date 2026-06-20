/** An outbound message (ADR-0014). */
export interface Notification {
  readonly text: string;
  readonly title?: string;
  readonly level?: "info" | "warn" | "error";
}

/** A communication transport (email / Slack / Telegram / …). */
export interface Channel {
  readonly name: string;
  send(n: Notification): Promise<void>;
}
