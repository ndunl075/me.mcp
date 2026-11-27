import { beforeAll, describe, expect, it } from "vitest";
import { call, publish, rpc, signIn, tool, NOTE_PREFIX } from "./helpers";

const PATH = "/me/alice/mcp";

beforeAll(async () => {
  const cookie = await signIn("alice");
  const res = await publish(cookie, {
    name: "Alice Example",
    headline: "Compiler engineer",
    location: "Lisbon",
    bio: "I build compilers.",
    now: "Writing a rust-based parser generator",
    about: "Background in type theory.\n\nI love sourdough baking.",
    contact: "Email me at alice@example.com",
    links: "Site | https://alice.example.com",
    projects: "Parsey | https://github.com/alice/parsey | A parser generator",
  });
  expect(res.status).toBe(302);
});

describe("person MCP", () => {
  it("initialize returns serverInfo and instructions", async () => {
    const r = await rpc(PATH, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.serverInfo.name).toBe("me.mcp/alice");
    expect(r.body.result.instructions).toContain("Alice Example (@alice)");
    expect(r.body.result.instructions).toContain(NOTE_PREFIX);
  });

  it("tools/list has exactly the 6 public tools", async () => {
    const r = await rpc(PATH, "tools/list");
    const names = r.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["get_about", "get_contact", "get_now", "get_profile", "get_projects", "search"]);
  });

  it("get_profile", async () => {
    const t = await tool(PATH, "get_profile");
    expect(t.json).toMatchObject({
      handle: "alice",
      name: "Alice Example",
      headline: "Compiler engineer",
      location: "Lisbon",
      bio: "I build compilers.",
      profile_url: "http://localhost/me/alice",
      mcp_url: "http://localhost/me/alice/mcp",
    });
    expect(t.json.links).toEqual([{ label: "Site", url: "https://alice.example.com" }]);
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("get_now", async () => {
    const t = await tool(PATH, "get_now");
    expect(t.json.now).toBe("Writing a rust-based parser generator");
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("get_projects", async () => {
    const t = await tool(PATH, "get_projects");
    expect(t.json.projects).toEqual([
      { name: "Parsey", url: "https://github.com/alice/parsey", description: "A parser generator" },
    ]);
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("get_about", async () => {
    const t = await tool(PATH, "get_about");
    expect(t.json.about).toContain("type theory");
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("get_contact", async () => {
    const t = await tool(PATH, "get_contact");
    expect(t.json.contact).toBe("Email me at alice@example.com");
    expect(t.json.links).toHaveLength(1);
    expect(t.json._note).toContain(NOTE_PREFIX);
  });

  it("search finds text", async () => {
    const t = await tool(PATH, "search", { query: "sourdough" });
    expect(t.json.results).toEqual([{ section: "about", text: "I love sourdough baking." }]);
    expect(t.json._note).toContain(NOTE_PREFIX);

    const rust = await tool(PATH, "search", { query: "rust" });
    expect(rust.json.results[0].section).toBe("now");
  });

  it("search with no match returns a hint", async () => {
    const t = await tool(PATH, "search", { query: "zzzzqqq" });
    expect(t.json.results).toEqual([]);
    expect(t.json.hint).toBeTruthy();
  });

  it("unknown handle gives 404 JSON-RPC error", async () => {
    const r = await rpc("/me/nobody/mcp", "tools/list");
    expect(r.status).toBe(404);
    expect(r.body.jsonrpc).toBe("2.0");
    expect(r.body.error.message).toContain("nobody");
  });

  it("GET with Accept: text/html redirects to the profile", async () => {
    const res = await call(PATH, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/me/alice");
  });

  it("plain GET is 405", async () => {
    const res = await call(PATH);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
