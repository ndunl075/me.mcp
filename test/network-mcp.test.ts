import { beforeAll, describe, expect, it } from "vitest";
import { call, publish, rpc, signIn, tool, unpublish, NOTE_PREFIX } from "./helpers";

const PATH = "/me/mcp";

beforeAll(async () => {
  const cookie = await signIn("Carol");
  await publish(cookie, { name: "Carol Netter", headline: "Distributed systems hacker", now: "Building a gossip protocol" });
  // An explicitly unpublished profile that must never show up.
  const hank = await signIn("hiddenhank");
  await publish(hank, { name: "Hidden Hank", headline: "secretword" });
  await unpublish(hank);
  expect((await call("/me/hiddenhank")).status).toBe(404);
});

describe("network MCP", () => {
  it("tools/list has lookup_person and search_people", async () => {
    const r = await rpc(PATH, "tools/list");
    expect(r.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["lookup_person", "search_people"]);
  });

  it.each(["carol", "@carol", "CAROL", "@Carol"])("lookup_person(%j) finds the profile", async (handle) => {
    const t = await tool(PATH, "lookup_person", { handle });
    expect(t.json.found).toBe(true);
    expect(t.json.handle).toBe("carol");
    expect(t.json.name).toBe("Carol Netter");
    expect(t.json.now).toBe("Building a gossip protocol");
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("lookup_person reports not found", async () => {
    const t = await tool(PATH, "lookup_person", { handle: "@ghost" });
    expect(t.json).toMatchObject({ found: false, handle: "ghost" });
  });

  it("lookup_person does not reveal unpublished profiles", async () => {
    const t = await tool(PATH, "lookup_person", { handle: "hiddenhank" });
    expect(t.json.found).toBe(false);
  });

  it("search_people finds published people only", async () => {
    const t = await tool(PATH, "search_people", { query: "gossip" });
    expect(t.json.people.map((p: { handle: string }) => p.handle)).toEqual(["carol"]);
    expect(t.json.people[0].profile_url).toBe("http://localhost/me/carol");
    const none = await tool(PATH, "search_people", { query: "secretword" });
    expect(none.json.people).toEqual([]);
  });

  it("GET behaviour mirrors the person endpoint", async () => {
    expect((await call(PATH)).status).toBe(405);
    const res = await call(PATH, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(302);
  });
});
