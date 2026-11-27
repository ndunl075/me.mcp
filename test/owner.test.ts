import { beforeAll, describe, expect, it } from "vitest";
import { call, createKey, publish, rpc, signIn, tool } from "./helpers";

const PATH = "/me/dave/mcp";
let cookie: string;
let key: string;

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

beforeAll(async () => {
  cookie = await signIn("dave");
  await publish(cookie, { name: "Dave", now: "Original now" });
  key = await createKey(cookie);
});

describe("owner key", () => {
  it("POST /edit/key returns a memcp_ key", async () => {
    expect(key).toMatch(/^memcp_[A-Za-z0-9_-]{20,}$/);
  });

  it("POST /edit/key requires sign-in", async () => {
    const res = await call("/me/edit/key", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/me/auth/github");
  });

  it("owner key adds update_profile to tools/list", async () => {
    const r = await rpc(PATH, "tools/list", undefined, auth(key));
    const names = r.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("update_profile");
    expect(names).toHaveLength(7);
  });

  it("no key or a wrong key does not", async () => {
    for (const headers of [{}, auth("memcp_wrong"), auth(key + "x")]) {
      const r = await rpc(PATH, "tools/list", undefined, headers);
      expect(r.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("update_profile");
    }
  });

  it("a key only grants ownership of its own profile", async () => {
    const otherCookie = await signIn("erin");
    await publish(otherCookie, { name: "Erin" });
    const r = await rpc("/me/erin/mcp", "tools/list", undefined, auth(key));
    expect(r.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("update_profile");
  });

  it("update_profile rejects javascript: URLs", async () => {
    const t = await tool(PATH, "update_profile", { links: [{ label: "x", url: "javascript:alert(1)" }] }, auth(key));
    expect(t.isError).toBe(true);
    expect(t.json.error).toBe("Invalid input");
    const after = await tool(PATH, "get_now");
    expect(after.json.now).toBe("Original now");
  });

  it("a valid update changes get_now", async () => {
    const t = await tool(PATH, "update_profile", { now: "Shipping the test suite" }, auth(key));
    expect(t.isError).toBe(false);
    expect(t.json).toMatchObject({ ok: true, updated: ["now"], now: "Shipping the test suite" });
    const after = await tool(PATH, "get_now");
    expect(after.json.now).toBe("Shipping the test suite");
  });
});
