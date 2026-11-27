import type { Child } from "hono/jsx";
import type { Session } from "../env";
import { CSS } from "./styles";
import { CLIENT_JS } from "./client";

export interface Ctx {
  base: string; // e.g. "/me"
  publicUrl: string; // e.g. "https://www.usefrontierdigital.com/me"
  repoUrl: string;
  session: Session | null;
}

export const GithubIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

export const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

export function Logo({ base }: { base: string }) {
  return (
    <a class="logo" href={base + "/"} aria-label="me.mcp home">
      <span class="logo-mark">me</span>
      <span>
        me<span class="dot">.</span>mcp
      </span>
    </a>
  );
}

export function Layout(props: {
  ctx: Ctx;
  title: string;
  description: string;
  image?: string;
  /** "summary_large_image" for a 1200x630 card (also adds og:image width/height); defaults to the small "summary" card. */
  twitterCard?: "summary" | "summary_large_image";
  imageAlt?: string;
  canonical?: string;
  head?: Child;
  children: Child;
}) {
  const { ctx } = props;
  const large = props.twitterCard === "summary_large_image";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={props.description} />
        {props.canonical && <link rel="canonical" href={props.canonical} />}
        <meta property="og:title" content={props.title} />
        <meta property="og:description" content={props.description} />
        <meta property="og:type" content="website" />
        {props.canonical && <meta property="og:url" content={props.canonical} />}
        {props.image && <meta property="og:image" content={props.image} />}
        {props.image && large && <meta property="og:image:width" content="1200" />}
        {props.image && large && <meta property="og:image:height" content="630" />}
        {props.image && props.imageAlt && <meta property="og:image:alt" content={props.imageAlt} />}
        <meta name="twitter:card" content={props.twitterCard ?? "summary"} />
        <meta name="twitter:title" content={props.title} />
        <meta name="twitter:description" content={props.description} />
        {props.image && <meta name="twitter:image" content={props.image} />}
        {props.image && props.imageAlt && <meta name="twitter:image:alt" content={props.imageAlt} />}
        <link rel="icon" type="image/svg+xml" href={`${ctx.base}/favicon.svg?v=1`} />
        <link rel="icon" type="image/png" sizes="32x32" href={`${ctx.base}/favicon-32.png?v=1`} />
        <link rel="apple-touch-icon" href={`${ctx.base}/apple-touch-icon.png?v=1`} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Cal+Sans&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        {props.head}
      </head>
      <body>
        <Nav ctx={ctx} />
        <main>{props.children}</main>
        <Footer ctx={ctx} />
        <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
      </body>
    </html>
  );
}

function Nav({ ctx }: { ctx: Ctx }) {
  const b = ctx.base;
  return (
    <header class="nav">
      <div class="wrap">
        <div class="nav-inner">
          <Logo base={b} />
          <nav class="nav-links" aria-label="Main">
            <a href={b + "/#how"}>How it works</a>
            <a href={b + "/#people"}>People</a>
            <a href={b + "/#agents"}>For agents</a>
            <a href={ctx.repoUrl}>Open source</a>
          </nav>
          <div class="nav-right">
            {ctx.session ? (
              <>
                <a class="link hide-sm" href={`${b}/${ctx.session.login}`}>
                  @{ctx.session.login}
                </a>
                <a class="btn btn-dark" href={b + "/edit"}>
                  Edit my server
                </a>
              </>
            ) : (
              <>
                <a class="link hide-sm" href={b + "/auth/github"}>
                  Sign in
                </a>
                <a class="btn btn-dark" href={b + "/auth/github"}>
                  Get started
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer({ ctx }: { ctx: Ctx }) {
  return (
    <footer class="wrap">
      <div class="footer">
        <div>
          <Logo base={ctx.base} /> <div style="margin-top:8px">Open source. Free forever. Built by Frontier Digital.</div>
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <a href={ctx.repoUrl}>GitHub</a>
          <a href={ctx.base + "/llms.txt"}>llms.txt</a>
          <a href={ctx.base + "/#agents"}>Network MCP</a>
          {ctx.session && <a href={ctx.base + "/auth/logout"}>Sign out</a>}
        </div>
      </div>
    </footer>
  );
}
