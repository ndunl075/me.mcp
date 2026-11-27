import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { publish, signIn, tool, call } from "./helpers";

const calls = (handle: string) =>
  env.DB.prepare("SELECT calls_total FROM profiles WHERE handle = ?").bind(handle).first<{ calls_total: number }>().then((r) => r?.calls_total);

beforeAll(async () => {
  await publish(await signIn("frank"), { name: "Frank" });
});

describe("stats", () => {
  it("starts at zero", async () => {
    expect(await calls("frank")).toBe(0);
  });

  it("person tool calls increment counts (total, daily, client)", async () => {
    await tool("/me/frank/mcp", "get_now", {}, { "User-Agent": "Claude-User/1.0" });
    await tool("/me/frank/mcp", "get_profile", {}, { "User-Agent": "Claude-User/1.0" });
    await tool("/me/frank/mcp", "get_about", {}, { "User-Agent": "Cursor/0.5" });
    expect(await calls("frank")).toBe(3);

    const day = new Date().toISOString().slice(0, 10);
    const daily = await env.DB.prepare("SELECT count FROM call_daily WHERE handle = ? AND day = ?").bind("frank", day).first<{ count: number }>();
    expect(daily?.count).toBe(3);

    const { results } = await env.DB.prepare("SELECT client, count FROM call_clients WHERE handle = ? ORDER BY client").bind("frank").all();
    expect(results).toEqual([
      { client: "Claude", count: 2 },
      { client: "Cursor", count: 1 },
    ]);
  });

  it("initialize and tools/list are not counted", async () => {
    const before = await calls("frank");
    const { rpc } = await import("./helpers");
    await rpc("/me/frank/mcp", "tools/list");
    expect(await calls("frank")).toBe(before);
  });

  it("network lookup_person counts for the looked-up profile", async () => {
    const before = (await calls("frank"))!;
    await tool("/me/mcp", "lookup_person", { handle: "frank" });
    expect(await calls("frank")).toBe(before + 1);
  });

  it("calls show on the profile page", async () => {
    const html = await (await call("/me/frank")).text();
    expect(html).toContain("Frank");
  });
});
