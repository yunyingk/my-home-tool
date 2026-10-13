import type { FetchFunction, RawObject, XiaoduClientOptions } from "./types.ts";

const ORIGIN = "https://xiaodu.baidu.com";
const ENDPOINTS = {
  appliances: "/saiya/smarthome/appliance",
  rooms: "/saiya/smarthome/groupsystem",
  houses: "/saiya/smarthome/multihouse",
  bindings: "/saiya/smarthome/config",
  control: "/saiya/smarthome/directivesend",
} as const;

export type ErrorCode = "INVALID_CONFIGURATION" | "INVALID_ARGUMENT" | "AUTHENTICATION_REQUIRED" |
  "HTTP_ERROR" | "API_ERROR" | "INVALID_RESPONSE" | "TIMEOUT" | "REQUEST_FAILED" |
  "DEVICE_NOT_FOUND" | "AMBIGUOUS_DEVICE" | "DEVICE_OFFLINE" | "UNSUPPORTED_ACTION" |
  "OUT_OF_RANGE" | "UNAVAILABLE_STATE" | "COMMAND_REJECTED";

export interface ErrorDetails {
  httpStatus?: number;
  apiStatus?: number;
  /** A failed write can have reached the server; never infer it is safe to retry. */
  outcome?: "not-sent" | "rejected" | "unknown";
}

export class XiaoduError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "XiaoduError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isRecord(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, message: string): RawObject {
  if (!isRecord(value)) throw new XiaoduError("INVALID_RESPONSE", message);
  return value;
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: RawObject;
  mutating?: boolean;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Request aborted."));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export class XiaoduTransport {
  #bduss: string;
  #fetch: FetchFunction;
  #timeoutMs: number;

  constructor(options: XiaoduClientOptions) {
    if (typeof options.bduss !== "string" || !options.bduss || /[\s;]/.test(options.bduss) || options.bduss.startsWith("BDUSS=")) {
      throw new XiaoduError("INVALID_CONFIGURATION", "Provide the BDUSS cookie value only, without a Cookie header or BDUSS= prefix.");
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      throw new XiaoduError("INVALID_CONFIGURATION", "timeoutMs must be an integer from 1 to 300000.");
    }
    this.#bduss = options.bduss;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async request(endpoint: keyof typeof ENDPOINTS, options: RequestOptions = {}): Promise<RawObject> {
    if (!Object.hasOwn(ENDPOINTS, endpoint)) throw new XiaoduError("INVALID_ARGUMENT", "Unsupported endpoint.", { outcome: "not-sent" });
    const url = new URL(ENDPOINTS[endpoint], ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timedOut = false;
    const failureOutcome = options.mutating ? "unknown" : undefined;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      const response = await abortable(this.#fetch(url.toString(), {
        method: options.method ?? "POST",
        headers: { "Content-Type": "application/json", Cookie: `BDUSS=${this.#bduss}` },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: "manual",
        signal: controller.signal,
      }), controller.signal);
      if (response.status === 401 || response.status === 403) {
        throw new XiaoduError("AUTHENTICATION_REQUIRED", "Baidu rejected this session. Log in again and update BDUSS.", { httpStatus: response.status, outcome: "rejected" });
      }
      if (!response.ok) {
        throw new XiaoduError("HTTP_ERROR", "Xiaodu returned an unsuccessful HTTP response; redirects are not followed.", { httpStatus: response.status, outcome: failureOutcome });
      }
      let body: unknown;
      try { body = await abortable(response.json(), controller.signal); }
      catch {
        if (timedOut) throw new XiaoduError("TIMEOUT", "Xiaodu request timed out. Write outcomes may be unknown; do not blindly retry.", { outcome: failureOutcome });
        throw new XiaoduError("INVALID_RESPONSE", "Xiaodu returned a non-JSON response.", { httpStatus: response.status, outcome: failureOutcome });
      }
      if (!isRecord(body) || typeof body.status !== "number" || !Number.isFinite(body.status)) {
        throw new XiaoduError("INVALID_RESPONSE", "Xiaodu response is missing a numeric business status.", { httpStatus: response.status, outcome: failureOutcome });
      }
      if (body.status === 2) {
        throw new XiaoduError("AUTHENTICATION_REQUIRED", "Baidu session has expired or is not logged in. Log in again and update BDUSS.", { httpStatus: response.status, apiStatus: body.status, outcome: "rejected" });
      }
      if (body.status !== 0) {
        const message = typeof body.msg === "string" ? body.msg.replaceAll(this.#bduss, "<redacted>") : "Xiaodu rejected the request.";
        throw new XiaoduError("API_ERROR", message, { httpStatus: response.status, apiStatus: body.status, outcome: "rejected" });
      }
      return body;
    } catch (error) {
      if (error instanceof XiaoduError) throw error;
      throw new XiaoduError(timedOut ? "TIMEOUT" : "REQUEST_FAILED", timedOut
        ? "Xiaodu request timed out. Write outcomes may be unknown; do not blindly retry."
        : "Xiaodu request failed. Write outcomes may be unknown; do not blindly retry.", { outcome: failureOutcome });
    } finally { clearTimeout(timer); }
  }
}
