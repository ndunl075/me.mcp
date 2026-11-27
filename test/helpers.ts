import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";

const ORIGIN = "http://localhost";

let ipCounter = 0;

/**
 * Calls the Worker's fetch directly and waits for ctx.waitUntil work (e.g. stats counting) to finish.
 * Each call gets its own client IP unless the test sets cf-connecting-ip, so the per-IP rate limits
 * (src/security.ts) only ever fire in the tests that mean to trigger them.
 */
export async function call(path: string, init: RequestInit = {}, workerEnv: typeof env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `192.0.2.${(ipCounter++ % 250) + 1}-${ipCounter}`);
  const req = new Request(ORIGIN + path, { redirect: "manual", ...init, headers });
  const res = await worker.fetch(req, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

export interface Rpc {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function rpc(
  path: string,
  method: string,
  params?: unknown,
  extra: Record<string, string> = {},
): Promise<Rpc> {
  const res = await call(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

/** Calls an MCP tool and returns the parsed JSON text payload plus the raw result. */
export async function tool(path: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const r = await rpc(path, "tools/call", { name, arguments: args }, extra);
  const result = r.body.result;
  const text: string = result?.content?.[0]?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, result, isError: !!result?.isError, json, text };
}

/** Signs in via the dev login and returns a Cookie header value. */
export async function signIn(login: string): Promise<string> {
  const res = await call(`/me/auth/dev?login=${login}`);
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(/memcp_session=[^;]+/);
  if (!m) throw new Error(`no session cookie: ${res.status} ${set}`);
  return m[0];
}

export function form(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

export async function publish(cookie: string, fields: Record<string, string> = {}): Promise<Response> {
  const f = form({ action: "publish", ...fields });
  return call("/me/edit", { method: "POST", headers: { ...f.headers, Cookie: cookie }, body: f.body });
}

export async function unpublish(cookie: string): Promise<Response> {
  const f = form({ action: "unpublish" });
  return call("/me/edit", { method: "POST", headers: { ...f.headers, Cookie: cookie }, body: f.body });
}

export async function createKey(cookie: string): Promise<string> {
  const res = await call("/me/edit/key", { method: "POST", headers: { Cookie: cookie } });
  const html = await res.text();
  const m = html.match(/memcp_[A-Za-z0-9_-]+/);
  if (!m) throw new Error("no key in page");
  return m[0];
}

export const NOTE_PREFIX = "Self-published by this person via me.mcp";
