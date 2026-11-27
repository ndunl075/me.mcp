/**
 * Share-card renderer: runs in the profile owner's browser, never on the Worker (free plan: 10 ms CPU, no image APIs).
 *
 * Draws the 1200x630 card for the X / Open Graph unfurl on a <canvas> and POSTs the PNG to `<base>/edit/card`.
 * The profile page only includes this when the viewer is the owner and the stored card is missing or older than the
 * profile (see ProfilePage), so it runs on the post-sign-up landing (?welcome=1) and after edits, not on every visit.
 *
 * Inputs come from <script type="application/json" id="share-card-data"> (written with `<` escaped, see cardDataJson):
 *   { handle, name, headline, location, now, avatar, display, post }
 * Everything drawn is plain text; nothing from the profile is ever interpreted as markup.
 *
 * Avatars: avatars.githubusercontent.com answers GET with `Access-Control-Allow-Origin: *`, so a crossOrigin="anonymous"
 * <img> keeps the canvas clean. github.com/<login>.png redirects there but its 302 has no CORS header, so it is rewritten to
 * avatars.githubusercontent.com/<login>. If the avatar fails or the canvas is tainted, initials are drawn instead.
 *
 * `data-share-card` on <html> reports the outcome (uploaded / skipped:* / failed:*), mostly for debugging and tests.
 */
export const SHARE_CARD_JS = /* js */ `
(function(){
  var W=1200,H=630,MAX=400*1024;
  var INK='#1c1c1c',INK2='#3a3a3a',MUTED='#6b6b6b',LINE='#e7e7e7';
  var DISPLAY='"Cal Sans",ui-sans-serif,system-ui,sans-serif',SANS='"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',MONO='"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
  var el=document.getElementById('share-card-data');
  if(!el||!window.fetch)return;
  var cfg;try{cfg=JSON.parse(el.textContent||'')}catch(e){return}
  function status(s){try{document.documentElement.setAttribute('data-share-card',s)}catch(e){}}

  function withTimeout(p,ms){return Promise.race([p,new Promise(function(r){setTimeout(function(){r(null)},ms)})])}

  function loadFonts(){
    var t=[cfg.name,cfg.handle,cfg.headline,cfg.location,cfg.now,cfg.display].join(' ');
    var jobs=[
      document.fonts.load('400 76px "Cal Sans"',t),
      document.fonts.load('500 32px "Inter"',t),
      document.fonts.load('400 32px "Inter"',t),
      document.fonts.load('500 24px "JetBrains Mono"',t)
    ].map(function(p){return p.catch(function(){return []})});
    return withTimeout(Promise.all([document.fonts.ready].concat(jobs)),6000).then(function(r){
      // Cal Sans is the card's look: without it, skip and let the next visit retry rather than store a fallback-font card.
      return !!(r&&r[1]&&r[1].length);
    });
  }

  function avatarUrl(u){
    try{
      var a=new URL(u);
      var m=a.hostname==='github.com'&&a.pathname.match(/^\\/([A-Za-z0-9-]+)\\.png$/);
      if(m)a=new URL('https://avatars.githubusercontent.com/'+m[1]);
      if(a.hostname!=='avatars.githubusercontent.com')return null;
      a.searchParams.set('s','320');
      return a.href;
    }catch(e){return null}
  }
  function loadAvatar(){
    var u=avatarUrl(cfg.avatar||'');
    if(!u)return Promise.resolve(null);
    return withTimeout(new Promise(function(res){
      var i=new Image();i.crossOrigin='anonymous';
      i.onload=function(){res(i)};i.onerror=function(){res(null)};i.src=u;
    }),7000);
  }

  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  function spacing(c,px){try{c.letterSpacing=px+'px'}catch(e){}}

  // text if it fits, else cut with an ellipsis. force: always end with one (the text continues on a line we dropped).
  function fit(c,text,max,force){
    if(!force&&c.measureText(text).width<=max)return text;
    var s=Array.from(text);
    while(s.length&&c.measureText(s.join('').replace(/\\s+$/,'')+'\\u2026').width>max)s.pop();
    return s.join('').replace(/\\s+$/,'')+'\\u2026';
  }

  // Greedy word wrap, at most maxLines; the last line ends with an ellipsis when text was cut.
  function wrap(c,text,max,maxLines){
    var words=String(text||'').replace(/\\s+/g,' ').trim().split(' ').filter(Boolean);
    var out=[],cur='';
    for(var i=0;i<words.length;i++){
      var w=words[i];
      if(c.measureText(w).width>max){ // a single word wider than the line: break it by characters
        if(cur){out.push(cur);cur=''}
        var chars=Array.from(w),part='';
        for(var k=0;k<chars.length;k++){
          if(part&&c.measureText(part+chars[k]).width>max){out.push(part);part=''}
          part+=chars[k];
        }
        cur=part;continue;
      }
      var next=cur?cur+' '+w:w;
      if(c.measureText(next).width>max){out.push(cur);cur=w}else cur=next;
    }
    if(cur)out.push(cur);
    if(out.length>maxLines){out=out.slice(0,maxLines);out[maxLines-1]=fit(c,out[maxLines-1],max,true)}
    return out;
  }

  function initials(){
    var parts=(cfg.name||cfg.handle||'?').trim().split(/\\s+/).filter(Boolean);
    var s=Array.from(parts[0]||'?')[0]+(parts.length>1?Array.from(parts[parts.length-1])[0]:'');
    return s.toUpperCase();
  }

  function draw(avatar){
    var cv=document.createElement('canvas');cv.width=W;cv.height=H;
    var c=cv.getContext('2d',{alpha:false});
    c.textBaseline='alphabetic';

    // Background: the landing page's .stage-bg look (soft gray, lighter toward the bottom, dot grid). Row-constant gradient on purpose:
    // a 2-D radial glow costs ~100 KB of PNG here (the browser's encoder is not great) and every byte is read back from D1.
    var g=c.createLinearGradient(0,0,0,H);g.addColorStop(0,'#f1f1ef');g.addColorStop(0.7,'#e9e9e6');g.addColorStop(1,'#f3f3f1');
    c.fillStyle=g;c.fillRect(0,0,W,H);
    c.fillStyle='rgba(0,0,0,.10)';c.beginPath();
    for(var y=0;y<H;y+=24)for(var x=0;x<W;x+=24){c.moveTo(x+1.5,y);c.arc(x,y,1.5,0,6.2832)}
    c.fill();

    var PAD=72,FULL=W-2*PAD,AV=152;

    // Measure the text blocks first so short profiles sit centred between the top edge and the footer instead of leaving a hole.
    c.font='500 36px '+SANS;
    var hl=cfg.headline?wrap(c,cfg.headline,FULL,2):[];
    c.font='400 30px '+SANS;
    var nl=cfg.now?wrap(c,cfg.now,FULL-64,2):[];
    var headH=hl.length?34+hl.length*46+18:0;
    var nowH=nl.length?(headH?0:34)+22+20+12+nl.length*40+16:0;
    var used=AV+headH+nowH;
    var ay=Math.max(48,Math.round(48+(470-used)/2)); // content zone: 48 .. 518, footer below

    // Avatar
    var ax=PAD;
    c.save();c.shadowColor='rgba(0,0,0,.16)';c.shadowBlur=14;c.shadowOffsetY=5;
    c.fillStyle='#fff';c.beginPath();c.arc(ax+AV/2,ay+AV/2,AV/2+6,0,6.2832);c.fill();c.restore();
    c.save();c.beginPath();c.arc(ax+AV/2,ay+AV/2,AV/2,0,6.2832);c.clip();
    if(avatar){c.drawImage(avatar,ax,ay,AV,AV)}
    else{
      c.fillStyle=INK;c.fillRect(ax,ay,AV,AV);
      c.fillStyle='#fff';c.font='400 '+Math.round(AV*0.42)+'px '+DISPLAY;c.textAlign='center';spacing(c,-1);
      c.fillText(initials(),ax+AV/2,ay+AV/2+AV*0.15);
    }
    c.restore();c.textAlign='left';spacing(c,0);

    // Name (shrinks to fit, then ellipsis) and @handle
    var tx=ax+AV+44,tw=W-PAD-tx;
    var name=cfg.name||cfg.handle,size=80;
    for(;size>52;size-=2){c.font='400 '+size+'px '+DISPLAY;spacing(c,-size*0.02);if(c.measureText(name).width<=tw)break}
    c.font='400 '+size+'px '+DISPLAY;spacing(c,-size*0.02);
    var shown=fit(c,name,tw,false);
    var sub='@'+cfg.handle+(cfg.location?'  \\u00b7  '+cfg.location:'');
    var capH=Math.round(size*0.72),blockH=capH+20+28,top=ay+AV/2-blockH/2;
    c.fillStyle=INK;c.fillText(shown,tx,top+capH);
    spacing(c,0);c.font='500 34px '+SANS;c.fillStyle=MUTED;
    c.fillText(fit(c,sub,tw,false),tx,top+capH+20+28);

    // Headline
    var cy=ay+AV+34;
    if(hl.length){
      c.font='500 36px '+SANS;c.fillStyle=INK2;
      for(var i=0;i<hl.length;i++){c.fillText(hl[i],PAD,cy+30+i*46)}
      cy+=hl.length*46+18;
    }

    // "Now" card
    if(nl.length){
      var ch=22+20+12+nl.length*40+16;
      c.save();c.shadowColor='rgba(0,0,0,.08)';c.shadowBlur=12;c.shadowOffsetY=4;c.fillStyle='#fff';rr(c,PAD,cy,FULL,ch,22);c.fill();c.restore();
      c.strokeStyle=LINE;c.lineWidth=2;rr(c,PAD+1,cy+1,FULL-2,ch-2,21);c.stroke();
      c.fillStyle='#16a34a';c.beginPath();c.arc(PAD+32+6,cy+22+10,6,0,6.2832);c.fill();
      c.font='500 20px '+MONO;spacing(c,2);c.fillStyle=MUTED;c.fillText('NOW',PAD+32+22,cy+22+17);spacing(c,0);
      c.font='400 30px '+SANS;c.fillStyle=INK;
      for(var j=0;j<nl.length;j++){c.fillText(nl[j],PAD+32,cy+22+20+12+28+j*40)}
    }

    // Footer: profile URL on the left, me.mcp mark on the right
    var fy=H-50;
    c.font='500 26px '+MONO;c.fillStyle=INK2;
    c.fillText(fit(c,cfg.display||'',FULL-300,false),PAD,fy+9);
    c.font='400 34px '+DISPLAY;spacing(c,-0.7);
    var meW=c.measureText('me').width,dotW=c.measureText('.').width,wmW=c.measureText('mcp').width;
    var mx=W-PAD-(52+14+meW+dotW+wmW);
    c.fillStyle=INK;rr(c,mx,fy-26,52,52,15);c.fill();
    var wx=mx+52+14;c.fillStyle=INK;c.fillText('me',wx,fy+10);c.fillStyle='#9a9a9a';c.fillText('.',wx+meW,fy+10);c.fillStyle=INK;c.fillText('mcp',wx+meW+dotW,fy+10);
    c.fillStyle='#fff';c.font='500 25px '+MONO;spacing(c,-1);c.textAlign='center';c.fillText('me',mx+26,fy+8);c.textAlign='left';spacing(c,0);
    return cv;
  }

  function toPng(cv){
    return new Promise(function(res){try{cv.toBlob(function(b){res(b)},'image/png')}catch(e){res(null)}});
  }

  Promise.all([loadFonts(),loadAvatar()]).then(function(r){
    if(!r[0]){status('skipped:fonts');return}
    // A tainted canvas (avatar served without CORS) makes toBlob throw or return null: draw initials instead.
    return toPng(draw(r[1])).then(function(b){return b||toPng(draw(null))}).then(function(b){
      if(!b){status('skipped:canvas');return}
      if(b.size>MAX){status('skipped:size');return}
      return fetch(cfg.post,{method:'POST',headers:{'Content-Type':'image/png'},body:b,credentials:'same-origin'}).then(function(res){
        status(res.ok?'uploaded':'failed:'+res.status);
      });
    });
  }).catch(function(){status('failed')});
})();
`;

/** JSON for the data block, safe inside <script>: `<` (and the JS line separators) escaped so nothing can close the tag. */
export function cardDataJson(data: Record<string, string>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16));
}
