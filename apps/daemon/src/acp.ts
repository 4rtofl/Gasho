import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Id = string | number;
type RecordValue = Record<string, unknown>;

export function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

export const AGY_LOGIN = "working server の端末で agy を起動してログインしてください。";
const DISCONNECTED = "Antigravity との接続が切れました。";

export class Acp {
  private child;
  private nextId = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  open = true;
  private end: (error: Error) => void;

  constructor(bin: string, cwd: string, receive: (method: string, params: unknown, id?: Id) => void, closed: () => void) {
    this.child = spawn(bin, ["acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const close = this.end = (error: Error) => {
      if (!this.open) return;
      this.open = false;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      lines.close();
      this.child.kill();
      closed();
    };
    this.child.on("error", close);
    this.child.on("close", () => close(new Error(DISCONNECTED)));
    this.child.stdin.on("error", close);
    lines.on("line", (line) => {
      let message: RecordValue | undefined;
      try {
        message = object(JSON.parse(line));
      } catch {
        close(new Error("Antigravity から JSON-RPC で読み取れない応答が来ました。"));
        return;
      }
      if (message?.jsonrpc !== "2.0") return;
      const { id, method, params, result, error } = message;
      if (typeof method === "string") {
        receive(method, params, typeof id === "number" || typeof id === "string" ? id : undefined);
      } else if (typeof id === "number" && this.pending.has(id)) {
        const request = this.pending.get(id)!;
        this.pending.delete(id);
        const failed = object(error);
        if (failed) request.reject(new Error(failed.code === -32000 ? AGY_LOGIN : typeof failed.message === "string" ? failed.message : "ACP の要求に失敗しました。"));
        else request.resolve(result);
      }
    });
  }

  async request(method: string, params: RecordValue, timeoutMs?: number): Promise<unknown> {
    if (!this.open) throw new Error(DISCONNECTED);
    const id = ++this.nextId;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => this.end(new Error("Antigravity から応答がありません。")), timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method: string, params: RecordValue): void {
    this.write({ method, params });
  }

  respond(id: Id, result: RecordValue): void {
    this.write({ id, result });
  }

  unsupported(id: Id): void {
    this.write({ id, error: { code: -32601, message: "Method not supported" } });
  }

  close(): void {
    this.end(new Error(DISCONNECTED));
  }

  private write(message: RecordValue): void {
    if (this.open) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
}
