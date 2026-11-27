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
    if(names.length>1&&!reduce){
      var txt=document.createElement('span'),car=document.createElement('span');car.className='caret';
      // Width is set in em so it scales with the fluid headline; measured with an off-screen probe, re-measured when fonts load.
      var measure=function(){
        var probe=document.createElement('span');probe.className=cyc.className;
        probe.style.cssText='position:absolute;visibility:hidden;width:auto;left:0;top:0';
        cyc.parentNode.appendChild(probe);
        var w=0;names.forEach(function(n){probe.textContent=n;probe.appendChild(car.cloneNode());w=Math.max(w,probe.getBoundingClientRect().width)});
        var fs=parseFloat(getComputedStyle(cyc).fontSize)||16;
        cyc.parentNode.removeChild(probe);
        cyc.style.width=(Math.ceil(w)/fs).toFixed(3)+'em';
      };
      cyc.textContent='';cyc.appendChild(txt);cyc.appendChild(car);txt.textContent=names[0];
      var idx=0,len=names[0].length,timer=0;
      var later=function(fn,ms){timer=setTimeout(fn,ms)};
      var step=function(){
        if(document.hidden){later(step,500);return}
        var cur=names[idx];
        if(len>=cur.length){
          cyc.classList.remove('typing');
          later(function(){cyc.classList.add('typing');del()},1400);
        }else{len++;txt.textContent=cur.slice(0,len);cyc.classList.add('typing');later(step,45+Math.random()*15)}
      };
      var del=function(){
        if(document.hidden){later(del,500);return}
        if(len>0){len--;txt.textContent=names[idx].slice(0,len);later(del,20+Math.random()*10)}
        else{idx=(idx+1)%names.length;later(step,180)}
      };
      var started=false;
      var go=function(){measure();if(!started){started=true;cyc.classList.remove('typing');later(function(){cyc.classList.add('typing');del()},1400)}};
      var fl=document.fonts;
      if(fl){
        fl.ready.then(go);
        fl.addEventListener&&fl.addEventListener('loadingdone',measure);
        try{Promise.all([fl.load('500 1em Inter'),fl.load('1em "Cal Sans"')]).then(measure,function(){})}catch(e){}
      }else go();
      window.addEventListener('resize',measure);
    }
  }

  // Forms marked data-autosubmit save as soon as a switch is flipped (the Save button still works without JS).
  // Delegated, so it also covers forms swapped in after the activity fetch.
  document.addEventListener('change',function(e){
    var f=e.target&&e.target.form;
    if(f&&f.hasAttribute('data-autosubmit')){if(f.requestSubmit)f.requestSubmit();else f.submit()}
  });

  // Character counters
  document.querySelectorAll('[data-max]').forEach(function(el){
    var out=document.querySelector('[data-count-for="'+el.name+'"]');if(!out)return;
    var max=+el.getAttribute('data-max');
    var upd=function(){out.textContent=el.value.length+' / '+max;out.style.color=el.value.length>max?'#b91c1c':''};
    el.addEventListener('input',upd);upd();
  });
})();
`;
