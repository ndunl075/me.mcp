import { beforeAll, describe, expect, it } from "vitest";
import { call, form, publish, signIn, unpublish } from "./helpers";
import { heroChip } from "../src/views/landing";

let cookie: string;

const GINA = { name: "Gina Page", headline: "Page builder", now: "Testing pages", links: "Home | https://gina.example.com" };

// Published explicitly, so every test below starts from a known public profile.
beforeAll(async () => {
  cookie = await signIn("gina");
  await publish(cookie, GINA);
  expect((await call("/me/gina")).status).toBe(200);
});

const post = (fields: Record<string, string>, c = cookie) => {
  const f = form(fields);
  return call("/me/edit", { method: "POST", headers: { ...f.headers, Cookie: c }, body: f.body });
};

describe("sign-in", () => {
  it("dev login sets a session cookie and redirects", async () => {
    const res = await call("/me/auth/dev?login=gina");
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("memcp_session=");
  });

  it("editor requires sign-in", async () => {
    const res = await call("/me/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/me/auth/github");
  });

  it("editor renders when signed in", async () => {
    const res = await call("/me/edit", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });
});

describe("editor", () => {
  it("action=publish saves and redirects to the profile", async () => {
    const res = await publish(cookie, { ...GINA, now: "Testing publish" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/me/gina");

    const page = await call("/me/gina");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Gina Page");
    expect(html).toContain("Testing publish");
  });

  it("a bad link URL is rejected with 400 and nothing is saved", async () => {
    expect((await call("/me/gina")).status).toBe(200);
    const res = await post({ action: "save", ...GINA, name: "Changed Name", links: "Bad | javascript:alert(1)" });
    expect(res.status).toBe(400);
    const page = await call("/me/gina");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("Changed Name");
  });

  it("a plain save persists the data", async () => {
    const res = await post({ action: "save", ...GINA, now: "Saved via plain save" });
    expect(res.status).toBe(302);
    const page = await call("/me/gina", { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Saved via plain save");
  });

  it("POST /edit requires sign-in", async () => {
    const f = form({ action: "publish", name: "X" });
    const res = await call("/me/edit", { method: "POST", headers: f.headers, body: f.body });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/me/auth/github");
  });
});

describe("visibility", () => {
  it("an unpublished profile is 404 for others but visible to its owner", async () => {
    const hCookie = await signIn("quietquinn");
    await publish(hCookie, { name: "Quinn" });
    expect((await call("/me/quietquinn")).status).toBe(200);
    await unpublish(hCookie);

    expect((await call("/me/quietquinn")).status).toBe(404);
    expect((await call("/me/quietquinn/llms.txt")).status).toBe(404);
    expect((await call("/me/quietquinn/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(404);
    expect((await call("/me/quietquinn", { headers: { Cookie: hCookie } })).status).toBe(200);
  });

  it("an unknown handle is 404", async () => {
    expect((await call("/me/does-not-exist")).status).toBe(404);
  });

  it("publishing makes a profile public, unpublishing hides it again", async () => {
    const c = await signIn("toggler");
    await publish(c, { name: "Toggler" });
    expect((await call("/me/toggler")).status).toBe(200);
    await unpublish(c);
    expect((await call("/me/toggler")).status).toBe(404);
  });
});

describe("llms.txt", () => {
  it("/me/llms.txt describes the service", async () => {
    const res = await call("/me/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("me.mcp");
    expect(body).toContain("http://localhost/me/mcp");
  });

  it("/me/<handle>/llms.txt renders the profile as markdown", async () => {
    const res = await call("/me/gina/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Gina Page (@gina)");
    expect(body).toContain("http://localhost/me/gina/mcp");
    expect(body).toContain("Self-published by this person");
  });
});

describe("misc", () => {
  it("the landing page renders", async () => {
    expect((await call("/me")).status).toBe(200);
  });

  it("an empty hero still types through example handles and shows their photos", () => {
    const empty = heroChip([]);
    expect(empty.handles).toEqual(["@you", "@torvalds", "@gaearon", "@ada"]);
    expect(empty.faces).toEqual([
      "https://github.com/torvalds.png",
      "https://github.com/gaearon.png",
      "https://github.com/ada.png",
    ]);
    const live = heroChip([{ handle: "gina", avatar_url: "https://github.com/gina.png" }]);
    expect(live.handles).toEqual(["@you", "@gina"]);
    expect(live.faces[0]).toBe("https://github.com/gina.png");
    expect(live.faces[1]).toBeNull();
    expect(heroChip([], "nico").handles).toEqual(["@nico"]);
  });

  it("a tampered session cookie is ignored", async () => {
    const res = await call("/me/edit", { headers: { Cookie: cookie + "x" } });
    expect(res.status).toBe(302);
  });
});
