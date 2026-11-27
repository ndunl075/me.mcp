import type { Env, Session } from "./env";
import type { Link, Project } from "./db";

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const SESSION_COOKIE = "memcp_session";
export const STATE_COOKIE = "memcp_oauth_state";
const SESSION_DAYS = 30;

export async function signSession(env: Env, login: string, id: number): Promise<string> {
  const payload: Session = { login, id, exp: Date.now() + SESSION_DAYS * 86400_000 };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}

export async function verifySession(env: Env, token: string | undefined): Promise<Session | null> {
  if (!token || !env.SESSION_SECRET) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const s = JSON.parse(fromB64url(body)) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

// ---- GitHub OAuth ---------------------------------------------------------

export function githubAuthorizeUrl(env: Env, state: string, redirectUri: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  // No scope: we only need the public profile. We never touch the user's repos.
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "me.mcp" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) throw new Error(data.error_description || "GitHub sign-in failed");
  return data.access_token;
}

export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
  bio: string | null;
  location: string | null;
  blog: string | null;
  twitter_username: string | null;
  html_url: string;
}

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "me.mcp" },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/** Fetches the signed-in user plus a starter profile (links + top repos) to prefill the editor. */
export async function fetchGithubStarter(token: string): Promise<{ user: GithubUser; links: Link[]; projects: Project[] }> {
  const user = await gh<GithubUser>("/user", token);
  const repos = await gh<{ name: string; html_url: string; homepage: string | null; description: string | null; fork: boolean; stargazers_count: number }[]>(
    `/users/${user.login}/repos?per_page=100&sort=pushed`,
    token,
  ).catch(() => []);

  const links: Link[] = [{ label: "GitHub", url: user.html_url }];
  if (user.twitter_username) links.push({ label: "X", url: `https://x.com/${user.twitter_username}` });
  if (user.blog) links.push({ label: "Website", url: /^https?:\/\//.test(user.blog) ? user.blog : `https://${user.blog}` });

  const projects: Project[] = repos
    .filter((r) => !r.fork && r.name.toLowerCase() !== user.login.toLowerCase())
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 5)
    .map((r) => ({ name: r.name, url: r.homepage || r.html_url, description: (r.description ?? "").slice(0, 300) }));

  return { user, links, projects };
}
