// A connection to Codex's app-server: JSON-RPC over a WebSocket on its Unix socket. Node's own WebSocket cannot reach a
// Unix socket, so this uses `ws`.
import WebSocket from "ws";

/** How long a request may take; starting a thread loads its settings and plugins. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The connection ended before the answer came: nothing says whether the request was carried out. */
export class CodexConnectionClosed extends Error {}

/** What the app-server answered a request with, as an error. */
export class CodexRpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code: number | undefined) {
    super(message);
    this.code = code;
  }
}

export interface CodexRpcHandlers {
  notification: (method: string, params: Record<string, unknown>) => void;
  /** A request from the app-server, to answer with `respond` or `respondError`. */
  request: (id: string | number, method: string, params: Record<string, unknown>) => void;
  closed: () => void;
}

interface Waiting {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpc {
  private ws: WebSocket;
  private handlers: CodexRpcHandlers;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private ended = false;

  private constructor(ws: WebSocket, handlers: CodexRpcHandlers) {
    this.ws = ws;
    this.handlers = handlers;
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.onClose());
    ws.on("error", () => ws.terminate());
  }

  /** Connects to the app-server on `socket` and introduces this client. */
  static async connect(socket: string, version: string, handlers: CodexRpcHandlers): Promise<CodexRpc> {
    const ws = new WebSocket(`ws+unix:${socket}:/`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const rpc = new CodexRpc(ws, handlers);
    await rpc.request("initialize", { clientInfo: { name: "gasho_daemon", title: "Gasho", version }, capabilities: null });
    rpc.send({ method: "initialized" });
    return rpc;
  }

  get open(): boolean {
    return !this.ended && this.ws.readyState === WebSocket.OPEN;
  }

  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    if (!this.open) return Promise.reject(new CodexConnectionClosed("Codex との接続が切れています。"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Codex が ${method} に答えませんでした。`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.waiting.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.ws.close();
  }

  private send(message: unknown): void {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  private onMessage(text: string): void {
    let m: { id?: string | number; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    const params = (m.params ?? {}) as Record<string, unknown>;
    if (typeof m.method === "string") {
      if (m.id !== undefined) this.handlers.request(m.id, m.method, params);
      else this.handlers.notification(m.method, params);
      return;
    }
    const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
    if (!w) return;
    this.waiting.delete(m.id as number);
    clearTimeout(w.timer);
    if (m.error) w.reject(new CodexRpcError(m.error.message ?? "Codex がエラーを返しました。", m.error.code));
    else w.resolve(m.result);
  }

  private onClose(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new CodexConnectionClosed("Codex との接続が切れました。"));
    }
    this.waiting.clear();
    this.handlers.closed();
  }
}
