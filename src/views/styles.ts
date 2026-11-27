export const CSS = /* css */ `
:root{
  --ink:#1c1c1c; --ink-2:#3a3a3a; --muted:#6b6b6b; --faint:#9a9a9a;
  --line:#e7e7e7; --line-2:#efefef; --soft:#f6f6f5; --soft-2:#fafaf9; --bg:#ffffff;
  --green:#16a34a; --green-bg:#ecfdf3; --accent:#ff5a1f;
  --r-sm:8px; --r:12px; --r-lg:18px; --r-xl:24px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.05);
  --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px -8px rgba(0,0,0,.10);
  --shadow-lg:0 2px 4px rgba(0,0,0,.04),0 24px 60px -20px rgba(0,0,0,.22);
  --display:"Cal Sans",ui-sans-serif,system-ui,sans-serif;
  --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%}
button{font:inherit;color:inherit}
code,pre,kbd{font-family:var(--mono);font-size:.875em}
::selection{background:#1c1c1c;color:#fff}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px}
.narrow{max-width:760px;margin:0 auto;padding:0 20px}
.display{font-family:var(--display);font-weight:400;letter-spacing:-.02em;line-height:1.02;text-wrap:balance}
.muted{color:var(--muted)}
.mono{font-family:var(--mono)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}

/* ---------- nav ---------- */
.nav{position:sticky;top:0;z-index:20;padding:10px 0;background:linear-gradient(#fff 70%,rgba(255,255,255,0))}
.nav-inner{display:flex;align-items:center;gap:16px;background:var(--soft);border-radius:16px;padding:8px 8px 8px 16px}
.logo{display:flex;align-items:center;gap:8px;font-family:var(--display);font-size:22px;letter-spacing:-.02em}
.logo-mark{width:26px;height:26px;border-radius:8px;background:var(--ink);color:#fff;display:grid;place-items:center;font-family:var(--mono);font-size:12px;letter-spacing:-.04em}
.logo .dot{color:var(--faint)}
.nav-links{display:flex;gap:4px;margin-left:12px}
.nav-links a{padding:8px 12px;border-radius:10px;font-size:15px;color:var(--ink-2)}
.nav-links a:hover{background:#ececeb}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.nav-right .link{padding:8px 12px;font-size:15px;border-radius:10px}
.nav-right .link:hover{background:#ececeb}
@media (max-width:760px){.nav-links{display:none}.nav-right .link.hide-sm{display:none}}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:40px;padding:0 16px;border-radius:10px;font-size:15px;font-weight:500;border:1px solid transparent;cursor:pointer;white-space:nowrap;transition:transform .08s ease,background .15s ease,box-shadow .15s ease}
.btn:active{transform:translateY(1px)}
.btn-dark{background:var(--ink);color:#fff}
.btn-dark:hover{background:#000}
.btn-light{background:#fff;border-color:var(--line);box-shadow:var(--shadow-sm)}
.btn-light:hover{background:var(--soft-2)}
.btn-ghost{background:transparent}
.btn-ghost:hover{background:var(--soft)}
.btn-lg{height:52px;padding:0 26px;font-size:18px;border-radius:13px;font-family:var(--display);font-weight:400;letter-spacing:-.01em}
.btn-sm{height:32px;padding:0 12px;font-size:13px;border-radius:8px}
.btn svg{flex:none}
@media (max-width:560px){.btn-lg{height:52px;font-size:18px;width:100%}}

/* ---------- hero ---------- */
.hero{padding-top:96px;padding-bottom:40px;text-align:center}
@media (max-width:560px){.hero{padding-top:56px}}
.badge{display:inline-flex;align-items:center;gap:10px;padding:4px 12px 4px 4px;border:1px solid var(--line);border-radius:10px;font-size:14px;color:var(--ink-2);background:#fff;box-shadow:var(--shadow-sm)}
.badge b{font-weight:500;font-size:11px;letter-spacing:.06em;color:var(--muted);background:var(--soft);border-radius:6px;padding:3px 7px}
.badge:hover{border-color:#d9d9d9}
.hero h1{margin:0 auto;font-size:clamp(46px,8.2vw,96px);max-width:1100px}
.hero h1 .row{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;column-gap:.22em;row-gap:.08em}
.hero .sub{margin:28px auto 0;font-size:clamp(18px,2.2vw,22px);color:var(--muted);max-width:620px;font-family:var(--display);letter-spacing:-.005em;line-height:1.35}
.hero .ctas{margin-top:36px;display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.hero .fine{margin-top:18px;font-size:14px;color:var(--muted);display:flex;gap:6px;justify-content:center;align-items:center;flex-wrap:wrap}
.hero .fine strong{color:var(--ink);font-weight:500}
.agent-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:7px;background:var(--soft);color:var(--ink);font-size:13px;cursor:pointer;border:0}
.agent-pill:hover{background:#ececeb}
.clients{margin-top:26px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
.clients span{font-size:12.5px;color:var(--muted);border:1px solid var(--line-2);border-radius:999px;padding:4px 10px;background:#fff}

/* inline chips inside the headline */
.chip{display:inline-flex;align-items:center;vertical-align:middle;height:.78em;border-radius:.16em;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);font-family:var(--sans);letter-spacing:0;line-height:1;white-space:nowrap}
.chip-avatars{padding:0 .12em 0 .09em;gap:0}
.chip-avatars i{width:.46em;height:.46em;border-radius:50%;box-shadow:0 0 0 .035em #fff;margin-left:-.14em;display:block}
.chip-avatars i:first-child{margin-left:0}
.chip-avatars .at{font-size:.2em;font-weight:500;color:var(--ink-2);margin-left:.5em;margin-right:.35em}
.chip-tool{flex-direction:column;align-items:flex-start;justify-content:center;gap:.06em;padding:0 .16em;height:.8em}
.chip-tool .t1{font-family:var(--mono);font-size:.17em;color:var(--ink);font-weight:500}
.chip-tool .t2{display:inline-flex;align-items:center;gap:.4em;font-size:.15em;color:var(--green);background:var(--green-bg);border-radius:.4em;padding:.25em .6em;font-weight:600}
.chip-term{background:var(--ink);border-color:var(--ink);color:#fff;padding:0 .18em;gap:.1em}
.chip-term .prompt{font-family:var(--mono);font-size:.2em;color:#9ae6b4}
.chip-term .cur{width:.08em;height:.32em;background:#fff;display:inline-block;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}

/* ---------- product frame ---------- */
.stage{margin:72px auto 0;max-width:1240px;padding:0 20px}
.stage-bg{position:relative;border-radius:var(--r-xl);padding:56px 48px 0;overflow:hidden;
  background:
    radial-gradient(1200px 400px at 50% 120%,rgba(255,255,255,.9),transparent 60%),
    radial-gradient(circle at 1px 1px,rgba(0,0,0,.09) 1px,transparent 0) 0 0/18px 18px,
    linear-gradient(180deg,#efefed,#e6e6e3)}
@media (max-width:700px){.stage-bg{padding:24px 12px 0;border-radius:var(--r-lg)}}
.window{background:#fff;border-radius:14px 14px 0 0;box-shadow:var(--shadow-lg);overflow:hidden;border:1px solid rgba(0,0,0,.06);border-bottom:0;text-align:left}
.window-bar{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line-2);background:#fbfbfb}
.dots{display:flex;gap:7px}.dots i{width:11px;height:11px;border-radius:50%;background:#e2e2e2}
.dots i:nth-child(1){background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
.urlbar{flex:1;max-width:460px;margin:0 auto;background:var(--soft);border-radius:8px;padding:5px 12px;font-size:13px;color:var(--muted);text-align:center;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.window-body{display:grid;grid-template-columns:1.25fr 1fr;min-height:420px}
@media (max-width:860px){.window-body{grid-template-columns:1fr;min-height:0}.window-body .side{display:none}.chat{padding:20px 16px;border-right:0}}
.chat{padding:28px 30px;display:flex;flex-direction:column;gap:16px;border-right:1px solid var(--line-2)}
.msg-user{align-self:flex-end;background:var(--soft);border-radius:16px 16px 4px 16px;padding:10px 14px;max-width:80%;font-size:15px}
.toolcall{border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13px;opacity:0;animation:rise .5s ease forwards .6s}
.toolcall-h{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--soft-2);border-bottom:1px solid var(--line-2)}
.toolcall-h .fn{font-family:var(--mono);font-weight:500}
.toolcall-h .srv{color:var(--muted);font-family:var(--mono)}
.toolcall-h .ok{margin-left:auto;color:var(--green);background:var(--green-bg);padding:2px 8px;border-radius:6px;font-weight:600;font-size:12px}
.toolcall pre{margin:0;padding:12px;color:var(--ink-2);white-space:pre-wrap;font-size:12.5px;line-height:1.6}
.toolcall pre .k{color:#7c3aed}.toolcall pre .s{color:#0f766e}
.msg-ai{font-size:15px;line-height:1.6;color:var(--ink-2);opacity:0;animation:rise .5s ease forwards 1.4s}
.msg-ai b{color:var(--ink);font-weight:600}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.side{padding:28px;background:var(--soft-2)}

/* ---------- profile card (shared by mockup + profile page) ---------- */
.pcard{background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);padding:22px;box-shadow:var(--shadow-sm)}
.pcard .who{display:flex;gap:14px;align-items:center}
.avatar{width:52px;height:52px;border-radius:50%;object-fit:cover;background:var(--soft);flex:none}
.avatar-lg{width:88px;height:88px}
.pcard h3{margin:0;font-family:var(--display);font-weight:400;font-size:22px;letter-spacing:-.01em;line-height:1.1}
.pcard .handle{color:var(--muted);font-size:14px}
.pcard .label{margin:18px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);font-weight:600}
.pcard p{margin:0;font-size:14.5px;color:var(--ink-2)}
.tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tools code{background:var(--soft);border-radius:6px;padding:3px 7px;font-size:12px}
.grad-1{background:linear-gradient(135deg,#ff8a4c,#ff3d77)}
.grad-2{background:linear-gradient(135deg,#6366f1,#22d3ee)}
.grad-3{background:linear-gradient(135deg,#10b981,#a3e635)}
.grad-4{background:linear-gradient(135deg,#1c1c1c,#6b6b6b)}

/* ---------- sections ---------- */
.section{padding-top:110px}
@media (max-width:640px){.section{padding-top:80px}}
.section-head{text-align:center;max-width:720px;margin:0 auto 48px}
.eyebrow{display:inline-block;font-size:13px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:3px 10px;margin-bottom:18px}
.section h2{margin:0;font-size:clamp(36px,5vw,56px)}
.section-head p{margin:16px 0 0;color:var(--muted);font-size:18px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media (max-width:860px){.steps{grid-template-columns:1fr}}
.step{background:var(--soft);border-radius:var(--r-lg);padding:28px;min-height:260px;display:flex;flex-direction:column}
.step .n{font-family:var(--mono);font-size:13px;color:var(--muted)}
.step h3{margin:14px 0 8px;font-family:var(--display);font-weight:400;font-size:26px;letter-spacing:-.01em}
.step p{margin:0;color:var(--muted);font-size:15.5px}
.step .demo{margin-top:auto;padding-top:22px}
.mini{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px;box-shadow:var(--shadow-sm)}
.mini + .mini{margin-top:8px}
.mini.mono{font-size:12px}

.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
@media (max-width:760px){.feature-grid{grid-template-columns:1fr}}
.feature{border:1px solid var(--line);border-radius:var(--r-lg);padding:26px}
.feature h3{margin:0 0 6px;font-size:17px;font-weight:600}
.feature p{margin:0;color:var(--muted);font-size:15px}

.people{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
@media (max-width:760px){.people{grid-template-columns:1fr}}
.person{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;transition:border-color .15s,box-shadow .15s}
.person:hover{border-color:#d6d6d6;box-shadow:var(--shadow)}
.person .rank{font-family:var(--mono);color:var(--faint);font-size:13px;width:22px}
.person .avatar{width:40px;height:40px}
.person .meta{min-width:0;flex:1}
.person .nm{font-weight:600;font-size:15px}
.person .hl{color:var(--muted);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.person .calls{font-size:13px;color:var(--muted);white-space:nowrap}
.empty{border:1px dashed var(--line);border-radius:14px;padding:28px;text-align:center;color:var(--muted)}

.cta-band{margin:120px 0 0;background:var(--ink);color:#fff;border-radius:var(--r-xl);padding:72px 24px;text-align:center}
.cta-band h2{margin:0;font-size:clamp(36px,5vw,60px)}
.cta-band p{color:#b5b5b5;margin:14px 0 30px;font-size:18px}
.cta-band .btn-light{color:var(--ink)}

.footer{padding:56px 0 48px;color:var(--muted);font-size:14px;display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap}
.footer a:hover{color:var(--ink)}

/* ---------- forms / editor ---------- */
.page{padding-top:48px;padding-bottom:96px}
.page h1{font-size:clamp(36px,5vw,52px);margin:0}
.page .lede{color:var(--muted);font-size:18px;margin:10px 0 0}
.card{border:1px solid var(--line);border-radius:var(--r-lg);padding:24px;background:#fff}
.card + .card{margin-top:16px}
.card h2{margin:0 0 4px;font-size:18px;font-weight:600}
.card .hint{margin:0 0 16px;color:var(--muted);font-size:14.5px}
.field{display:block;margin-top:16px}
.field > span{display:flex;justify-content:space-between;font-size:14px;font-weight:500;margin-bottom:6px}
.field > span small{font-weight:400;color:var(--faint)}
input[type=text],input[type=url],textarea{width:100%;font:inherit;font-size:15px;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px;transition:border-color .15s,box-shadow .15s}
textarea{min-height:96px;resize:vertical;line-height:1.5}
textarea.tall{min-height:180px}
textarea.code{font-family:var(--mono);font-size:13px}
input:focus,textarea:focus{outline:none;border-color:#bdbdbd;box-shadow:0 0 0 3px rgba(0,0,0,.06)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:640px){.row2{grid-template-columns:1fr}}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:20px}
.sticky-actions{position:sticky;bottom:0;background:linear-gradient(rgba(255,255,255,0),#fff 30%);padding:28px 0 18px;margin-top:8px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.notice{border-radius:12px;padding:12px 14px;font-size:14.5px;margin:0 0 16px}
.notice.ok{background:var(--green-bg);color:#166534}
.notice.err{background:#fef2f2;color:#991b1b}
.notice.info{background:var(--soft);color:var(--ink-2)}
.ai-box{background:var(--soft);border-radius:var(--r-lg);padding:20px}
.ai-box .actions{margin-top:12px}
details.ai summary{cursor:pointer;list-style:none}
details.ai summary::-webkit-details-marker{display:none}

/* ---------- profile page ---------- */
.profile-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;align-items:start}
.profile-grid>*{min-width:0}
@media (max-width:900px){.profile-grid{grid-template-columns:1fr}}
.profile-head{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.profile-head h1{font-size:clamp(34px,5vw,48px);margin:0;line-height:1.05}
.profile-head .handle{color:var(--muted);font-size:16px;margin-top:4px}
.headline{font-size:20px;color:var(--ink-2);margin:18px 0 0;font-family:var(--display);letter-spacing:-.005em;line-height:1.35}
.block{margin-top:28px}
.block h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 10px}
.prose{white-space:pre-wrap;color:var(--ink-2);font-size:16px;overflow-wrap:anywhere}
.now-card{background:var(--soft);border-radius:var(--r-lg);padding:18px 20px}
.now-card .when{font-size:13px;color:var(--muted);margin-top:8px}
.proj{display:block;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.proj + .proj{margin-top:8px}
a.proj:hover{border-color:#d6d6d6}
.proj .pn{font-weight:600;font-size:15px}
.proj .pd{color:var(--muted);font-size:14px;margin-top:2px}
.links{display:flex;flex-wrap:wrap;gap:8px}
.links a{border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px}
.links a:hover{background:var(--soft)}
.fetching{margin:28px 0 0;font-size:14px;color:var(--muted)}
.fetching::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border:2px solid var(--line);border-top-color:var(--ink);border-radius:50%;vertical-align:-1px;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.act{list-style:none;margin:0;padding:0}
.act li{display:flex;gap:12px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line-2);font-size:15px;color:var(--ink-2);min-width:0}
.act li:first-child{border-top:0;padding-top:0}
.act time{flex:none;width:78px;color:var(--faint);font-size:13px;font-variant-numeric:tabular-nums}
.act .src{flex:none;min-width:72px;text-align:center;font-size:11.5px;font-weight:600;letter-spacing:.03em;color:var(--muted);background:var(--soft);border-radius:6px;padding:2px 8px}
.act a,.act li>span:last-child{min-width:0;overflow-wrap:anywhere}
.act a:hover{text-decoration:underline}
@media (max-width:560px){.act li{flex-wrap:wrap;row-gap:4px;align-items:center}.act time{width:auto;min-width:64px}.act a,.act li>span:last-child{flex-basis:100%}}
.sources{padding:18px 20px;background:var(--soft-2)}
.sources .hint{margin-bottom:10px;font-size:14px}
.src-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line-2);font-size:15px;cursor:pointer}
.src-row.static{cursor:default}
.src-name small{color:var(--muted);font-size:13px;margin-left:6px}
.src-name em{display:block;font-style:normal;font-size:13px;color:#b45309;margin-top:2px}
.src-state{font-size:13px;color:var(--muted)}
.switch{position:relative;flex:none;width:38px;height:22px}
.switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.switch i{display:block;width:100%;height:100%;border-radius:999px;background:#d4d4d4;transition:background .15s;pointer-events:none}
.switch i::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.switch input:checked + i{background:var(--ink)}
.switch input:checked + i::after{transform:translateX(16px)}
.switch input:focus-visible + i{outline:2px solid var(--ink);outline-offset:2px}
.install{position:sticky;top:90px}
.install .endpoint{display:flex;gap:8px;align-items:center;background:var(--soft);border-radius:10px;padding:6px 6px 6px 12px;margin:12px 0 4px}
.install .endpoint code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin-top:18px;border-bottom:1px solid var(--line-2)}
.tabs button{border:0;background:none;padding:8px 10px;font-size:14px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button[aria-selected=true]{color:var(--ink);border-color:var(--ink)}
.tabpanel{padding-top:14px;font-size:14.5px;color:var(--ink-2)}
.tabpanel[hidden]{display:none}
.tabpanel ol{margin:0;padding-left:20px}
.tabpanel li + li{margin-top:4px}
.codeblock{position:relative;background:#141414;color:#eaeaea;border-radius:10px;padding:12px 44px 12px 12px;font-family:var(--mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all;margin:8px 0 0}
.codeblock .btn{position:absolute;top:6px;right:6px;background:#2a2a2a;color:#fff;border:0}
.stats{display:flex;gap:24px;margin-top:18px;padding-top:18px;border-top:1px solid var(--line-2)}
.stat b{display:block;font-family:var(--display);font-weight:400;font-size:28px;letter-spacing:-.01em}
.stat span{font-size:13px;color:var(--muted)}
.bars{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.bar{display:grid;grid-template-columns:80px 1fr 36px;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.bar i{display:block;height:6px;border-radius:3px;background:var(--ink)}
.bar .track{background:var(--line-2);border-radius:3px}
.owner-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--soft);border-radius:12px;padding:10px 12px;margin-bottom:24px;font-size:14px}
.owner-bar .sp{flex:1}
.owner-bar.welcome{flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:12px;padding:16px;background:var(--soft)}
.owner-bar.welcome>*{min-width:0;max-width:100%}
.owner-bar .wl-head{font-size:15px}
.owner-bar .wl-url{display:flex;gap:8px;align-items:center;background:#fff;border-radius:10px;padding:6px 6px 6px 12px}
.owner-bar .wl-url code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.owner-bar .wl-actions{display:flex;gap:8px;flex-wrap:wrap}
.hero .consent{margin:14px 0 0;font-size:13px;color:var(--muted)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:all .2s;pointer-events:none;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%)}
/* hero chip: real avatars + cycling handle */
.chip-avatars img{width:.46em;height:.46em;border-radius:50%;box-shadow:0 0 0 .035em #fff;margin-left:-.14em;display:block;object-fit:cover;background:var(--soft)}
.chip-avatars img:first-child,.chip-avatars i:first-child{margin-left:0}
.chip-avatars .at{display:inline-block;text-align:left;white-space:nowrap}
.chip-avatars .at .caret{display:inline-block;width:.09em;height:1em;background:var(--ink-2);vertical-align:-.15em;margin-left:.04em;animation:blink 1s steps(1) infinite}
.chip-avatars .at.typing .caret{animation:none}

/* visual 1: flow */
.flow{display:grid;grid-template-columns:1fr 72px 1fr 72px 1fr;align-items:start}
.flow-col{display:flex;flex-direction:column;gap:18px;min-width:0}
.flow-card,.flow-server,.flow-clients{height:212px;border-radius:var(--r-lg)}
.flow-card{background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);padding:18px}
.flow-card .who{display:flex;gap:10px;align-items:center;margin-bottom:14px}
.avatar-sm{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:600;font-size:14px}
.flow-card .nm{font-weight:600;font-size:15px;line-height:1.2}
.flow-card .hd{color:var(--muted);font-size:13px}
.kv{display:flex;gap:10px;font-size:13.5px;padding:7px 0;border-top:1px solid var(--line-2);color:var(--ink-2)}
.kv span{width:64px;flex:none;color:var(--faint)}
.flow-server{background:var(--ink);color:#fff;padding:18px;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)}
.srv-url{font-family:var(--mono);font-size:12.5px;background:#2a2a2a;border-radius:8px;padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srv-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
.srv-tools code{background:#2a2a2a;color:#d4d4d4;border-radius:6px;padding:3px 7px;font-size:11.5px}
.srv-live{margin-top:auto;display:flex;align-items:center;gap:7px;font-size:12.5px;color:#a3a3a3}
.srv-live i{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:pulse 1.8s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.flow-clients{display:flex;flex-direction:column;gap:8px;justify-content:center}
.client{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow-sm)}
.client .cn{font-weight:600;font-size:14.5px}
.client .ct{font-family:var(--mono);font-size:12px;color:var(--muted)}
.client .ct em{font-style:normal;color:var(--green);font-weight:700;margin-left:4px}
.flow-wire{height:212px;display:flex;align-items:center}
.flow-wire i{display:block;width:100%;height:2px;background:repeating-linear-gradient(90deg,var(--ink) 0 6px,transparent 6px 12px);background-size:24px 2px;animation:wire 1s linear infinite;opacity:.55}
@keyframes wire{to{background-position:24px 0}}
.flow-cap{display:flex;flex-direction:column;gap:2px;padding:0 4px}
.flow-cap b{font-size:15px;font-weight:600}
.flow-cap span{color:var(--muted);font-size:14.5px}
@media (max-width:900px){
  .flow{grid-template-columns:1fr;max-width:420px;margin:0 auto}
  .flow-card,.flow-server,.flow-clients{height:auto;min-height:0}
  .flow-server{min-height:170px}
  .flow-wire{height:44px;justify-content:center}
  .flow-wire i{width:2px;height:100%;background:repeating-linear-gradient(180deg,var(--ink) 0 6px,transparent 6px 12px);background-size:2px 24px;animation:wirev 1s linear infinite}
  @keyframes wirev{to{background-position:0 24px}}
}

/* visual 2: versus */
.versus{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:800px){.versus{grid-template-columns:1fr}}
.vs-card{border-radius:var(--r-lg);padding:22px;display:flex;flex-direction:column;gap:14px}
.vs-bad{background:var(--soft)}
.vs-good{background:#fff;border:1px solid var(--line);box-shadow:var(--shadow)}
.vs-label{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.vs-x,.vs-check{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700}
.vs-x{background:#e5e5e5;color:#737373}
.vs-check{background:var(--green-bg);color:var(--green)}
.vs-card .msg-user{background:#fff;align-self:flex-end}
.vs-good .msg-user{background:var(--soft)}
.vs-ai{font-size:15px;line-height:1.6;color:var(--ink-2)}
.vs-bad .vs-ai{color:var(--muted)}
.vs-ai b{color:var(--ink);font-weight:600}
.vs-tool{display:flex;align-items:center;gap:10px;font-size:12.5px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--soft-2)}
.vs-tool .ok{margin-left:auto;color:var(--green);background:var(--green-bg);padding:2px 8px;border-radius:6px;font-weight:600;font-size:12px}
.vs-foot{margin-top:auto;font-size:13px;color:var(--faint);padding-top:12px;border-top:1px solid var(--line-2)}
.vs-good .vs-foot{color:var(--green)}

/* visual 3: step mini UIs */
.step .demo{display:flex;flex-direction:column;gap:8px}
.ui-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:9px;background:#fff;border:1px solid var(--line);font-size:13px;font-weight:500;box-shadow:var(--shadow-sm);white-space:nowrap}
.ui-btn.dark{background:var(--ink);color:#fff;border-color:var(--ink);align-self:flex-start}
.ui-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ui-list{display:flex;gap:6px;flex-wrap:wrap}
.ui-list div{background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px 9px;font-size:12.5px}
.ui-list em,.ui-ok{font-style:normal;color:var(--green);font-weight:600}
.ui-paste{background:#fff;border:1px dashed #d4d4d4;border-radius:9px;padding:8px 10px;font-size:11.5px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ui-ok{font-size:13px}
.ui-url{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px 10px;font-size:12px;box-shadow:var(--shadow-sm)}
.ui-url .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ui-stat{font-size:13px;color:var(--muted)}
.ui-stat b{font-family:var(--display);font-weight:400;font-size:18px;color:var(--ink)}
@media (prefers-reduced-motion:reduce){.fetching::before{animation:none}.flow-wire i,.srv-live i,.chip-term .cur{animation:none}.toolcall,.msg-ai{animation:none;opacity:1}}
`;
