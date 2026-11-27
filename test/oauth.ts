import { env } from "cloudflare:test";
import { call } from "./helpers";
import { json, zoeFetch } from "./fixtures";

export interface GhUser {
  login: string;
  id: number;
  name?: string;
}

/** A global fetch stub for the GitHub OAuth callback: token exchange, /user, repos, plus zoe's fixtures for the activity sources. */
export function githubStub(user: GhUser, extra: Record<string, (url: string) => Response> = {}) {
  const zoe = zoeFetch();
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    for (const [prefix, make] of Object.entries(extra)) if (url.startsWith(prefix)) return make(url);
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "tok" });
    if (url === "https://api.github.com/user") {
      return json({
        login: user.login,
        id: user.id,
        name: user.name ?? user.login,
        avatar_url: `https://avatars.example/u/${user.id}`,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        html_url: `https://github.com/${user.login}`,
      });
    }
    if (url.startsWith(`https://api.github.com/users/${user.login}/repos`)) return json([]);
    return zoe.fn(input, init);
  }) as typeof fetch;
  return { fn, calls };
}

/**
 * Runs the real /auth/callback for `user` with GitHub stubbed out. `refresh` turns on the background activity fetch
 * (the tests' default env switches it off). Returns the response, the session cookie and every URL fetched.
 */
export async function oauthSignIn(user: GhUser, opts: { refresh?: boolean; extra?: Record<string, (url: string) => Response> } = {}) {
  const stub = githubStub(user, opts.extra);
  const real = globalThis.fetch;
  globalThis.fetch = stub.fn;
  try {
    const res = await call(
      "/me/auth/callback?code=abc&state=st",
      { headers: { Cookie: "memcp_oauth_state=st" } },
      { ...env, SIGNIN_REFRESH: opts.refresh ? "1" : "0" } as typeof env,
    );
    const cookie = (res.headers.get("set-cookie") ?? "").match(/memcp_session=[^;]+/)?.[0] ?? "";
    return { res, cookie, calls: stub.calls };
  } finally {
    globalThis.fetch = real;
  }
}
