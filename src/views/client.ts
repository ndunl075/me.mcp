/** Tiny vanilla JS shared by all pages: copy buttons, tabs, toast, and the editor's "paste from AI" filler. */
export const CLIENT_JS = /* js */ `
(function(){
  var toastEl;
  function toast(msg){
    if(!toastEl){toastEl=document.createElement('div');toastEl.className='toast';toastEl.setAttribute('role','status');document.body.appendChild(toastEl);}
    toastEl.textContent=msg;toastEl.classList.add('show');
    clearTimeout(toastEl._t);toastEl._t=setTimeout(function(){toastEl.classList.remove('show')},1600);
  }
  window.memcpToast=toast;

  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-copy],[data-copy-from]');
    if(b){
      var text=b.getAttribute('data-copy');
      if(text==null){var src=document.getElementById(b.getAttribute('data-copy-from'));text=src?(src.value!=null?src.value:src.textContent):'';}
      navigator.clipboard.writeText(text).then(function(){toast(b.getAttribute('data-toast')||'Copied')},function(){toast('Copy failed — select and copy manually')});
      return;
    }
    var t=e.target.closest('[role=tab]');
    if(t){
      var list=t.closest('[role=tablist]');
      list.querySelectorAll('[role=tab]').forEach(function(x){x.setAttribute('aria-selected',x===t?'true':'false')});
      var scope=list.parentElement;
      scope.querySelectorAll('[role=tabpanel]').forEach(function(p){p.hidden=p.id!==t.getAttribute('aria-controls')});
    }
  });

  // Editor: fill the form from JSON an AI produced.
  var fill=document.getElementById('ai-fill');
  if(fill){
    fill.addEventListener('click',function(){
      var raw=(document.getElementById('ai-paste')||{}).value||'';
      var s=raw.indexOf('{'),e=raw.lastIndexOf('}');
      if(s<0||e<=s){toast('Paste the JSON your AI gave you');return;}
      var data;try{data=JSON.parse(raw.slice(s,e+1))}catch(err){toast('That JSON didn\\'t parse — ask your AI to output only JSON');return;}
      var set=function(name,val){var el=document.querySelector('[name="'+name+'"]');if(el&&typeof val==='string'&&val.trim()){el.value=val.trim();}};
      ['name','headline','location','bio','now','about','contact'].forEach(function(k){set(k,data[k])});
      if(Array.isArray(data.links)){set('links',data.links.filter(function(l){return l&&l.url}).map(function(l){return (l.label||'Link')+' | '+l.url}).join('\\n'))}
      if(Array.isArray(data.projects)){set('projects',data.projects.filter(function(p){return p&&p.name}).map(function(p){return [p.name,p.url||'',p.description||''].join(' | ').replace(/ \\| $/,'').replace(/ \\|  \\| /,' | ')}).join('\\n'))}
      document.getElementById('profile-form').scrollIntoView({behavior:'smooth'});
      toast('Filled in — review and publish');
    });
  }

  // Hero chip: type out "@you" and recent handles, hold, backspace, repeat. Width is fixed to the longest handle
  // (caret included) so the headline never reflows.
  var cyc=document.querySelector('[data-cycle]');
  if(cyc){
    var names=[];try{names=JSON.parse(cyc.getAttribute('data-cycle'))}catch(e){}
    var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(names.length>1&&!reduce)(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){
      var txt=document.createElement('span'),car=document.createElement('span');car.className='caret';
      cyc.textContent='';cyc.appendChild(txt);cyc.appendChild(car);
      var w=0;names.forEach(function(n){txt.textContent=n;w=Math.max(w,cyc.getBoundingClientRect().width)});
      cyc.style.width=Math.ceil(w)+'px';
      var idx=0,len=names[0].length;txt.textContent=names[0];
      var step=function(){
        var cur=names[idx];
        if(len>=cur.length){ // fully typed: hold, then start deleting
          cyc.classList.remove('typing');
          setTimeout(function(){cyc.classList.add('typing');del()},1400);
        }else{len++;txt.textContent=cur.slice(0,len);cyc.classList.add('typing');setTimeout(step,45+Math.random()*15)}
      };
      var del=function(){
        if(len>0){len--;txt.textContent=names[idx].slice(0,len);setTimeout(del,20+Math.random()*10)}
        else{idx=(idx+1)%names.length;setTimeout(step,180)}
      };
      cyc.classList.remove('typing');setTimeout(function(){cyc.classList.add('typing');del()},1400);
    });
  }

  // Character counters
  document.querySelectorAll('[data-max]').forEach(function(el){
    var out=document.querySelector('[data-count-for="'+el.name+'"]');if(!out)return;
    var max=+el.getAttribute('data-max');
    var upd=function(){out.textContent=el.value.length+' / '+max;out.style.color=el.value.length>max?'#b91c1c':''};
    el.addEventListener('input',upd);upd();
  });
})();
`;
