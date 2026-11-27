import { call } from "./helpers";
import { json, zoeFetch } from "./fixtures";

export interface GhUser {
  login: string;
  id: number;
  name?: string;
}

/** A global fetch stub for the GitHub OAuth callback: token exchange, /user, repos, plus zoe's fixtures for the activity sources. */
export function githubStub(user: GhUser, extra: Record<string, (url: string) => Response> = {}, repos: unknown[] = []) {
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
    if (url.startsWith(`https://api.github.com/users/${user.login}/repos`)) return json(repos);
    return zoe.fn(input, init);
  }) as typeof fetch;
  return { fn, calls };
}

/** Runs `fn` with global fetch replaced by `stub` (the Worker under test shares the isolate's global). */
export async function withFetch<T>(stub: { fn: typeof fetch }, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub.fn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * Runs the real /auth/callback for `user` with GitHub stubbed out. Returns the response, the session cookie and every URL
 * fetched (the callback makes exactly three: token, /user, repos; activity is fetched later by POST /edit/refresh).
 */
export async function oauthSignIn(user: GhUser, opts: { extra?: Record<string, (url: string) => Response>; repos?: unknown[] } = {}) {
  const stub = githubStub(user, opts.extra, opts.repos);
  const res = await withFetch(stub, () => call("/me/auth/callback?code=abc&state=st", { headers: { Cookie: "memcp_oauth_state=st" } }));
  const cookie = (res.headers.get("set-cookie") ?? "").match(/memcp_session=[^;]+/)?.[0] ?? "";
  return { res, cookie, calls: stub.calls };
}

/** POST /edit/refresh as the owner (same-origin, like the page's script), with GitHub stubbed. */
export async function refreshActivity(cookie: string, user: GhUser) {
  const stub = githubStub(user);
  const res = await withFetch(stub, () => call("/me/edit/refresh", { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost" } }));
  return { res, calls: stub.calls };
}
