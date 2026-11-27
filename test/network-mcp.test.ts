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
    expect(t.text.startsWith("Carol Netter (@carol) · Distributed systems hacker\n")).toBe(true);
    expect(t.text).toContain("): Building a gossip protocol");
    expect(t.text).toContain(NOTE_PREFIX);
  });

  it("lookup_person returns the same compact text as the person server's get_profile", async () => {
    const network = await tool(PATH, "lookup_person", { handle: "carol" });
    const person = await tool("/me/carol/mcp", "get_profile");
    expect(network.text).toBe(person.text);
  });

  it("lookup_person reports not found", async () => {
    const t = await tool(PATH, "lookup_person", { handle: "@ghost" });
    expect(t.text).toContain("No me.mcp profile for @ghost");
    expect(t.text).toContain(NOTE_PREFIX);
  });

  it("lookup_person does not reveal unpublished profiles", async () => {
    const t = await tool(PATH, "lookup_person", { handle: "hiddenhank" });
    expect(t.text).toContain("No me.mcp profile for @hiddenhank");
    expect(t.text).not.toContain("Hidden Hank");
  });

  it("search_people finds published people only", async () => {
    const t = await tool(PATH, "search_people", { query: "gossip" });
    expect(t.text).toContain("@carol · Carol Netter · Distributed systems hacker");
    expect(t.text).toContain("http://localhost/me/carol");
    const none = await tool(PATH, "search_people", { query: "secretword" });
    expect(none.text).toContain("No matches.");
    expect(none.text).not.toContain("@hiddenhank");
  });

  it("GET behaviour mirrors the person endpoint", async () => {
    expect((await call(PATH)).status).toBe(405);
    const res = await call(PATH, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(302);
  });
});
