
const DAEMON='http://127.0.0.1:4567';
const CATALOG=[
  {label:'Ollama Cloud · glm-5.3-flash',model:'glm-5.3-flash',provider:'openai',endpoint:'https://ollama.com/v1'},
  {label:'Ollama Cloud · kimi-k2.7-code',model:'kimi-k2.7-code',provider:'openai',endpoint:'https://ollama.com/v1'},
  {label:'OpenAI · gpt-4.1-mini',model:'gpt-4.1-mini',provider:'openai',endpoint:'https://api.openai.com/v1'},
  {label:'Groq · llama-3.3-70b-versatile',model:'llama-3.3-70b-versatile',provider:'openai',endpoint:'https://api.groq.com/openai/v1'},
  {label:'Mistral · mistral-large-latest',model:'mistral-large-latest',provider:'openai',endpoint:'https://api.mistral.ai/v1'},
  {label:'DeepSeek · deepseek-chat',model:'deepseek-chat',provider:'openai',endpoint:'https://api.deepseek.com/v1'},
  {label:'Anthropic · claude-sonnet-4-5',model:'claude-sonnet-4-5',provider:'anthropic',endpoint:'https://api.anthropic.com'},
  {label:'Google · gemini-2.5-pro',model:'gemini-2.5-pro',provider:'gemini',endpoint:'https://generativelanguage.googleapis.com'},
  {label:'Ollama local · llama3.2',model:'llama3.2',provider:'ollama',endpoint:'http://localhost:11434'}
];
const PRESETS=[
  {id:'request_review',mode:'prompt',label:'Request Review',desc:'Every command waits for your approval (HITL).'},
  {id:'default',mode:'allowlist',label:'Default',desc:'Only allowlisted command prefixes run; everything else is blocked.'},
  {id:'read_only',mode:'read_only',label:'Read Only',desc:'State-changing commands are blocked outright.'},
  {id:'turbo',mode:'open',label:'Turbo',desc:'No command restrictions. Grounding audit still runs.'}
];
const SLASH=[
  {cmd:'/plan',desc:'Plan before acting — the agent writes a plan first.'},
  {cmd:'/goal',desc:'Keep working until the goal is verifiably finished.'},
  {cmd:'/compact',desc:'Summarize history to free the context window.'},
  {cmd:'/revert',desc:'Drop the last exchange from memory.'},
  {cmd:'/review',desc:'Show the changed-files review card.'},
  {cmd:'/files',desc:'List changed files in the overview rail.'},
  {cmd:'/terminal',desc:'Show recent tool activity.'},
  {cmd:'/skills',desc:'List installed skills.'},
  {cmd:'/help',desc:'Show available actions.'}
];
const ACCENTS=['#39c5f0','#2fd07a','#f2b544','#a78bfa','#f0616d'];

let token='',busy=false,currentModel='',currentEndpoint='',reasoning='auto',permissions='default',cwd='',branch='';
/* the in-flight turn: aborted by the stop button or by closing the window */
let turnCtl=null,stoppedByUser=false;
let ctxChips=[];
let lastUserText='';
let turnStart=0,stepCount=0;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ── token bootstrap ─────────────────────────── */
async function loadToken(){
  let tokenPath=null;
  try{
    const c=new AbortController();const t=setTimeout(()=>c.abort(),2500);
    const r=await fetch(DAEMON+'/whoami',{signal:c.signal});clearTimeout(t);
    if(r.ok){const j=await r.json();tokenPath=j.token_path||null;cwd=j.cwd||'';}
  }catch{}
  if(window.Neutralino){
    try{
      Neutralino.init();
      await Promise.race([
        new Promise(res=>{ if(Neutralino.events&&Neutralino.events.on) Neutralino.events.on('ready',res); else res(); }),
        new Promise(res=>setTimeout(res,4000))
      ]);
      try{const e=String(await Neutralino.os.getEnv('LIBER_TOKEN')||'').trim(); if(e){token=e;return;}}catch{}
      if(tokenPath){const raw=await Neutralino.filesystem.readFile(tokenPath);token=String(raw).trim();}
    }catch{}
  }
}
const authHeaders=x=>token?{...x,Authorization:'Bearer '+token}:x;
async function api(route,method='GET',body=null){
  const r=await fetch(DAEMON+route,{method,headers:authHeaders({'Content-Type':'application/json'}),body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  return {status:r.status,data};
}

/* ── tiny markdown ───────────────────────────── */
function md(text){
  let o=esc(text);
  const blocks=[];
  o=o.replace(/```([A-Za-z0-9+#._-]*)\n?([\s\S]*?)```/g,(_,lang,c)=>{
    blocks.push('<pre><code>'+c.replace(/\n$/,'')+'</code></pre>');
    return '\u0001'+(blocks.length-1)+'\u0001';
  });
  o=o.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  o=o.replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>');
  o=o.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  o=o.replace(/\[E(\d+)\]/g,'<span class="cite">[E$1]</span>');
  const lines=o.split('\n').map(line=>{
    let m;
    if(m=line.match(/^(#{1,4})\s+(.+)$/)) return {block:true,html:`<div class="md-h${m[1].length}">${m[2]}</div>`};
    if(/^\s*[-*]\s+/.test(line)) return {block:true,html:`<div class="md-li">• ${line.replace(/^\s*[-*]\s+/,'')}</div>`};
    if(/^\s*\d+\.\s+/.test(line)) return {block:true,html:`<div class="md-li">${line.trim()}</div>`};
    if(/^&gt;\s?/.test(line)) return {block:true,html:`<div class="md-quote">${line.replace(/^&gt;\s?/,'')}</div>`};
    if(/^\s*(---|\*\*\*)\s*$/.test(line)) return {block:true,html:'<div class="md-hr"></div>'};
    return {block:false,html:line};
  });
  let out='';
  lines.forEach((l,i)=>{
    if(i>0) out += (l.block||lines[i-1].block)?'':'<br>';
    out += l.html;
  });
  return out.replace(/\u0001(\d+)\u0001/g,(_,i)=>blocks[+i]);
}
function add(parent,tag,cls,html){
  const el=document.createElement(tag);
  if(cls)el.className=cls;
  if(html!==undefined)el.innerHTML=html;
  parent.appendChild(el);
  return el;
}

/* ── state pills ─────────────────────────────── */
function setState(kind,text){
  const p=$('pill-state');p.className='pill '+(kind==='online'?'online':kind==='busy'?'busy':'');
  $('state-text').textContent=text;
}
function renderModel(){
  $('model-label').textContent=currentModel?currentModel+' · '+reasoning:'—';
  $('model-text').textContent=currentModel||'—';
  $('pill-model').className='pill '+(currentModel?'online':'');
}
function renderPerms(){
  const p=PRESETS.find(x=>x.id===permissions)||PRESETS[1];
  $('perms-label').textContent=p.label;
  $('perms-text').textContent=p.label;
  $('pill-perms').className='pill online';
}

/* ── workspace + config boot ─────────────────── */

/* ── daily budget meter: visible before a turn is refused ────────────── */
async function refreshBudget(){
  const el=$('foot-status');
  if(!el) return;
  const r=await api('/budget').catch(()=>null);
  const b=r?.data?.budget;
  if(!b){ el.textContent=''; return; }
  const pct=b.percent_used;
  if(!b.allowed){
    el.innerHTML='<span style="color:var(--red);cursor:pointer" title="Open Settings → Advanced to reset today or raise the limit">⚠ budget exhausted · fix</span>';
    el.onclick=()=>openSettingsAt('advanced');
    return;
  }
  if(pct!=null&&pct>=80){
    el.innerHTML='<span style="color:#f2b544;cursor:pointer" title="'+Number(b.spent_tokens||0).toLocaleString('en-US')+' / '+Number(b.limit_tokens||0).toLocaleString('en-US')+' tokens today">⚠ '+pct+'% budget</span>';
    el.onclick=()=>openSettingsAt('advanced');
    return;
  }
  el.textContent='';
  el.onclick=null;
}

async function loadConfig(){
  const {data}=await api('/config');
  const c=data?.config||{};
  currentModel=c.engine?.model||'';
  currentEndpoint=c.engine?.endpoint||'';
  reasoning=c.engine?.reasoning_effort||'auto';
  const mode=c.policy?.terminal?.mode||'allowlist';
  permissions=(PRESETS.find(p=>p.mode===mode)||{id:'default'}).id;
  renderModel();renderPerms();
  return c;
}
async function loadWorkspace(){
  const {data}=await api('/workspace');
  const w=data?.workspace||{};
  branch=w.branch||'—';
  $('branch-label').textContent=branch;
  $('branch-mini').textContent=branch==='—'?'':'⑂ '+branch;
  $('ov-cwd').textContent=w.cwd||'';
  const sideCwd=$('side-cwd'); if(sideCwd) sideCwd.textContent=w.cwd||'local checkout';
  renderReview(w);renderActivity(data?.activity||[]);
  paintSandbox().catch(()=>{});
  return w;
}

/** Say where commands actually run. A silent downgrade from container to language
 *  mode is the difference between 'sandboxed' and 'not sandboxed at all'. */
async function paintSandbox(){
  const el=$('sandbox-label'); if(!el) return;
  const r=await api('/sandbox').catch(()=>null);
  const d=r&&r.data; if(!d||!d.success) return;
  const caps=d.capabilities||{};
  if(caps.docker){
    el.textContent='container';
    el.style.color='var(--green)';
    el.parentElement.title='Commands run in Docker: no network, read-only root, only the workspace mounted.';
  }else{
    el.textContent='no container';
    el.style.color='var(--amber)';
    el.parentElement.title=(d.note||'Commands run in Constrained Language Mode, not a container.')
      +'\nDocker Desktop must be running for the container backend.';
  }
}
function renderReview(w){
  const files=w.changed_files||[];
  const tot=w.totals||{files:0,additions:0,deletions:0};
  $('badge-review').textContent=String(tot.files||0);
  $('badge-files').textContent=String(tot.files||0);
  const rows=files.map(f=>`<div class="frow"><span class="st">${esc(f.status)}</span><span class="p">${esc(f.path)}</span><span class="a">+${f.additions||0}</span><span class="d">−${f.deletions||0}</span></div>`).join('');
  $('ov-review').innerHTML=files.length?rows:'<div class="act">Working tree clean.</div>';
  $('ov-files').innerHTML=files.length
    ? files.map(f=>`<div class="act ok"><div class="t">${esc(f.path)}</div><div class="d">${esc(f.status)} · +${f.additions||0} −${f.deletions||0}</div></div>`).join('')
    : '<div class="act">No changed files.</div>';
}
function renderActivity(list){
  $('badge-terminal').textContent=String(list.length);
  $('ov-terminal').innerHTML=list.length
    ? list.map(a=>`<div class="act ${a.ok?'ok':'bad'}"><div class="t">${esc(a.tool)}${a.evidence?' ['+esc(a.evidence)+']':''}</div><div class="d">${esc((a.detail||'').slice(0,120))}</div></div>`).join('')
    : '<div class="act">No tool steps yet this session.</div>';
}
async function loadSkills(){
  const {data}=await api('/skills');
  const list=data?.skills||[];
  $('badge-skills').textContent=String(list.length);
  $('skill-count').textContent=String(list.length);
  $('ov-skills').innerHTML=list.length
    ? list.slice(0,40).map(s=>`<div class="skill"><b>${esc(s.name)}</b>${s.always?' <span class="tag">always</span>':''}<div class="ds">${esc(s.description||'')}</div></div>`).join('')
    : '<div class="act">No skills installed. Add SKILL.md files under skills/ or .liber/skills/.</div>';
}

/* ── conversation helpers ────────────────────── */
let turns=[];
function ensureStream(){
  const e=$('empty-state'); if(e) e.remove();
}
function newTurn(){
  ensureStream();
  const t=add($('stream'),'div','turn');
  turns.push(t);
  return t;
}
function userMessage(parent,text){
  const row=add(parent,'div','userrow');
  add(row,'div','ububble',esc(text));
  const acts=add(row,'div','uactions');
  const rev=add(acts,'button','tinybtn','revert');
  rev.onclick=()=>doRevert(1);
  const cp=add(acts,'button','tinybtn','copy');
  cp.onclick=()=>navigator.clipboard.writeText(text);
  return row;
}
function step(parent,kind,label,body){
  const d=add(parent,'details','step');
  add(d,'summary','',label);
  add(d,'pre','',body||'');
  stepCount++;
  return d;
}
function answerBlock(parent,text){
  const wrap=add(parent,'div','answrap');
  const a=add(wrap,'div','answer','');
  a.innerHTML=md(text);
  decorateCode(wrap);
  const acts=add(wrap,'div','aactions');
  const cp=add(acts,'button','tinybtn','copy');
  cp.onclick=()=>{navigator.clipboard.writeText(text).then(()=>toast('answer copied')).catch(()=>toast('copy blocked'));};
  const rt=add(acts,'button','tinybtn','retry');
  rt.onclick=()=>{ if(lastUserText){ toast('re-running the last request'); runTurn(lastUserText); } else toast('nothing to retry yet'); };
  const up=add(acts,'button','tinybtn','👍'); up.title='good answer';
  const dn=add(acts,'button','tinybtn','👎'); dn.title='bad answer';
  for(const [btn,kind] of [[up,'up'],[dn,'down']]){
    btn.onclick=()=>{
      const fb=JSON.parse(localStorage.getItem('liber-feedback')||'[]');
      fb.push({ts:new Date().toISOString(),kind,text:text.slice(0,200)});
      try{localStorage.setItem('liber-feedback',JSON.stringify(fb.slice(-200)));}catch{}
      btn.textContent=kind==='up'?'✓':'✓';
      toast('feedback saved locally');
    };
  }
  return wrap;
}

/** Give every fenced code block a copy button (smooth hover, no layout shift). */
function decorateCode(scope){
  scope.querySelectorAll('pre').forEach(pre=>{
    if(pre.querySelector('.codecopy'))return;
    pre.style.position='relative';
    const b=document.createElement('button');
    b.className='tinybtn codecopy';
    b.textContent='copy';
    b.onclick=()=>{
      const code=pre.querySelector('code');
      navigator.clipboard.writeText(code?code.textContent:pre.textContent).then(()=>{b.textContent='copied';setTimeout(()=>b.textContent='copy',1200);}).catch(()=>{b.textContent='blocked';});
    };
    pre.appendChild(b);
  });
}
function audit(parent,g){
  const ok=g.status==='PASS';
  const v=(g.violations||[]);
  const rec=(g.ledger?.receipts||[]).length;
  const checked=Number(g.claims_checked||0);
  const plural=(n,one,many)=>n===1?one:many;
  let cls='audit', text;
  if(!ok){
    cls='audit warn';
    text=`⚠ GROUNDING — ${v.length} unverified ${plural(v.length,'claim','claims')}\n`
      + v.slice(0,4).map(x=>`• [${x.code}] ${x.text}`).join('\n');
  }else if(!checked){
    // Nothing was asserted about the machine, so nothing was verified. A green
    // "PASS" here would be a false reassurance, not a result.
    cls='audit quiet';
    text=`GROUNDING · nothing to verify — no factual claims · ${rec} ${plural(rec,'receipt','receipts')}`;
  }else{
    text=`✔ GROUNDING PASS · ${rec} ${plural(rec,'receipt','receipts')} · ${checked} ${plural(checked,'claim','claims')} checked`;
  }
  return add(parent,'div',cls,text);
}
let turnArtifacts=[];
function recordArtifacts(g){
  const rec=(g&&g.ledger&&g.ledger.receipts)||[];
  turnArtifacts=rec.slice(-40);
  const badge=$('badge-artifacts');
  if(badge)badge.textContent=String(turnArtifacts.length);
  const box=$('ov-artifacts');
  if(!box)return;
  box.innerHTML='';
  if(!turnArtifacts.length){
    add(box,'div','ovempty','No receipts yet — the ledger fills as tools run.');
    return;
  }
  for(const r of turnArtifacts.slice(-12).reverse()){
    const row=add(box,'div','act');
    const id=String(r.id||r.receipt||'E?');
    const kind=String(r.tool||r.kind||'evidence');
    const detail=String(r.path||r.detail||r.value||'').slice(0,120);
    row.innerHTML='<div class="r"><span class="tag">'+esc(id)+'</span> <span class="nm">'+esc(kind)+'</span></div>'
      +(detail?'<div class="ds mono">'+esc(detail)+'</div>':'');
    row.setAttribute('role','button');
    row.tabIndex=0;
  }
}

function filesCard(parent,w){
  const f=(w.changed_files||[]);
  if(!f.length)return;
  const tot=w.totals||{files:0,additions:0,deletions:0};
  const card=add(parent,'div','card');
  const h=add(card,'div','card-h',
    `<b>${tot.files} file${tot.files===1?'':'s'} changed</b> <span class="stat">+${tot.additions} <span class="del">−${tot.deletions}</span></span><span class="grow"></span><button class="tinybtn" id="card-review">Review</button>`);
  const b=add(card,'div','card-b');
  b.innerHTML=f.slice(0,25).map(x=>`<div class="frow"><span class="st">${esc(x.status)}</span><span class="p">${esc(x.path)}</span><span class="a">+${x.additions||0}</span><span class="d">−${x.deletions||0}</span></div>`).join('');
  const btn=h.querySelector('#card-review');
  if(btn) btn.onclick=()=>{openOverview('review');};
}

/* ── streaming turn ──────────────────────────── */
async function runTurn(message, opts = {}){
  const resume = opts.resume === true;
  /* first message names the session, so the sidebar stops saying "New session" */
  const sess=activeSessionObj();
  if(!resume&&sess&&(sess.title==='New session'||sess.title==='Current session')){
    sess.title=(message||'').replace(/\s+/g,' ').trim().slice(0,42)||'New session';
    saveSessionState();renderSessions();
    $('crumb').innerHTML='<span>dev-bot</span><span class="sep">›</span><b>'+esc(sess.title)+'</b>';
  }
  const turn=newTurn();
  turnStart=Date.now();stepCount=0;
  const meta=add(turn,'div','worked','working…');
  const stepsWrap=add(turn,'div');
  setState('busy','EXECUTING');
  document.body.classList.add('busy');
  /* the send button becomes stop while a turn is in flight */
  const sendBtn=$('send-btn');
  sendBtn.disabled=false;
  sendBtn.textContent='■';
  sendBtn.title='Stop (Esc)';
  sendBtn.classList.add('stopping');
  stoppedByUser=false;
  turnCtl=new AbortController();

  let answerEl=null,gotFinal=false,think=null,thinkBody=null,thinkRaw='',todoEl=null,todoBody=null,draftBuf='';
  const paintThink=()=>{if(thinkBody)thinkBody.textContent=tidyThink(thinkRaw);};
  const ensureThink=(live)=>{
    if(think)return;
    think=add(turn,'details','think'+(live?' live':''));
    think.open=true;
    add(think,'summary','','Think');
    thinkBody=add(think,'div','thinkbody','');
  };
  const closeThink=()=>{
    if(!think)return;
    think.open=false;
    think.classList.remove('live');
    const sum=think.querySelector('summary');
    if(sum)sum.textContent='Think';
  };
  const onEvent=(name,payload)=>{
    if(name==='reasoning_start'||name==='reasoning'){
      ensureThink(true);
      if(name==='reasoning'&&thinkBody){
        thinkRaw+=payload.delta||'';
        paintThink();
        thinkBody.scrollTop=thinkBody.scrollHeight;
        $('stream').scrollTop=$('stream').scrollHeight;
      }
    }else if(name==='reasoning_end'){
      closeThink();
    }else if(name==='draft_start'){
      closeThink();
    }else if(name==='todo'){
      const tasks=Array.isArray(payload.tasks)?payload.tasks:[];
      if(!tasks.length)return;
      if(!todoEl){
        todoEl=add(turn,'div','todo');
        add(todoEl,'div','todo-h','PLAN');
        todoBody=add(todoEl,'div','todo-b','');
      }
      todoBody.innerHTML=tasks.map(t=>{
        const st=String(t.status||'pending');
        const glyph=st==='completed'?'✓':(st==='in_progress'?'◐':'○');
        return `<div class="todo-i ${st}"><span class="todo-g">${glyph}</span><span>${esc(t.task||'')}</span></div>`;
      }).join('');
      $('stream').scrollTop=$('stream').scrollHeight;
    }else if(name==='thought'){
      /* non-streamed models think in [THOUGHT: …] blocks — same block, appended per step */
      ensureThink(false);
      if(thinkBody&&payload.content){
        thinkRaw+=(thinkRaw?'\n\n':'')+payload.content;
        paintThink();
      }
    }else if(name==='tool_dispatch'){
      // observed below; keep the dispatch silent-brief
    }else if(name==='observation'){
      const ok=payload.ok;
      const tgt=payload.target?`<span class="obs-t">${esc(String(payload.target)).slice(0,110)}</span>`:'';
      step(stepsWrap,'obs',
        `<span class="tag">[${payload.evidence}]</span> <span class="${ok?'ok':'bad'}">${esc(payload.tool)} ${ok?'OK':'FAILED'}${payload.exit_code?` (exit ${payload.exit_code})`:''}</span>${tgt}`,
        payload.output||'');
    }else if(name==='hitl_intercept'){
      notifyDesktop('LiBER needs approval', payload.target || payload.tool || 'a tool is waiting for you');
      showHitl(turn,payload);
    }else if(name==='hitl_approved'){
      step(stepsWrap,'obs','✔ APPROVED',payload.retried?'Re-dispatched after your approval.':'Approved by you.');
    }else if(name==='loop_guard'){
      step(stepsWrap,'obs','⟳ LOOP GUARD · '+esc(payload.tool||''),'Duplicate/empty action suppressed.');
    }else if(name==='grounding_audit'){
      step(stepsWrap,'obs',`🛠 GROUNDING REPAIR ${payload.attempt||1}/${payload.max_repairs||2}`,'Blocked unverified claims are being corrected.');
    }else if(name==='converging'){
      step(stepsWrap,'obs',`⏱ CONVERGING ${payload.iteration}/${payload.maxLoops}`,`Asked to answer from the ${payload.receipts||0} receipt(s) already gathered.`);
    }else if(name==='finalizing'){
      step(stepsWrap,'obs',`🧾 FINALIZING`,'Out of iterations — writing the answer from the receipts, no more tools.');
    }else if(name==='stopped'){
      step(stepsWrap,'obs','⏹ STOPPED',`You stopped the turn after ${payload.iteration||0} iteration(s).`);
    }else if(name==='draft'){
      /* The model streams raw protocol text. The answer area may only ever show
         what follows [FINAL: — never [THOUGHT:], [TOOL:], [EXEC:] or [READ:]. */
      draftBuf+=payload.delta||'';
      const vis=stripInternal(draftBuf);
      if(!answerEl){answerEl=add(turn,'div','answer','');answerEl.classList.add('streaming');}
      answerEl.textContent=vis;
      answerEl.style.display=vis?'':'none';
      $('stream').scrollTop=$('stream').scrollHeight;
    }else if(name==='final'){
      gotFinal=true;
      closeThink();
      recordArtifacts(payload.grounding);
      refreshBudget().catch(()=>{});
      notifyDesktop('LiBER · done', String(payload.response||'turn finished').slice(0,180));
      {
        const cur=activeSessionObj();
        if(cur && (cur.title==='New session' || cur.title==='Current session') && lastUserText){
          cur.title=String(lastUserText).replace(/\s+/g,' ').slice(0,48);
          saveSessionState();renderSessions();
        }
      }
      if(answerEl&&answerEl.isConnected)answerEl.remove();
      if(payload.response) answerBlock(turn,payload.response);
      if(payload.grounding) audit(turn,payload.grounding);
      speakFinal(payload.response);
    }else if(name==='error'){
      step(stepsWrap,'obs','✖ ERROR',payload.error||'');
    }
  };

  try{
    const res=await fetch(DAEMON+(resume?'/resume/stream':'/chat/stream'),{
      method:'POST',
      headers:authHeaders({'Content-Type':'application/json'}),
      signal:turnCtl?turnCtl.signal:undefined,
      body:JSON.stringify(resume
        ? {agentId:'dev-bot'}
        : {
            agentId:'dev-bot',
            sessionId:activeSession==='default'?undefined:activeSession,
            message
          })
    });
    if(!res.ok)throw new Error('HTTP '+res.status);
    const reader=res.body.getReader(),dec=new TextDecoder();
    let buf='',ev='';
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      const parts=buf.split('\n\n');buf=parts.pop();
      for(const part of parts){
        for(const line of part.split('\n')){
          if(line.startsWith('event:'))ev=line.slice(6).trim();
          else if(line.startsWith('data:')){
            let p={};try{p=JSON.parse(line.slice(5).trim());}catch{p={content:line.slice(5).trim()};}
            onEvent(ev,p);
          }
        }
      }
    }
  }catch(err){
    if(stoppedByUser||err.name==='AbortError'){
      step(stepsWrap,'obs','■ STOPPED','Stopped by you · the daemon finishes the current step, then idles.');
    }else{
      step(stepsWrap,'obs','✖ TRANSPORT',String(err.message||err));
    }
  }

  const secs=((Date.now()-turnStart)/1000).toFixed(1);
  meta.textContent=(stoppedByUser?'Stopped after ':'Worked for ')+`${secs}s · ${stepCount} step${stepCount===1?'':'s'}`;
  meta.onclick=()=>{stepsWrap.style.display=stepsWrap.style.display==='none'?'':'none';};
  stepsWrap.style.display='none';
  setState('online','IDLE');
  document.body.classList.remove('busy');
  turnCtl=null;
  $('send-btn').disabled=false;
  $('send-btn').textContent='↑';
  $('send-btn').title='Send (Enter)';
  $('send-btn').classList.remove('stopping');
  loadWorkspace().catch(()=>{});
  $('stream').scrollTop=$('stream').scrollHeight;
}

/** Stop the in-flight turn. Two things have to happen: we stop reading, and the
 *  daemon is told, so it stops before the next model call and kills any command
 *  it is running. Without the second half a script-started turn keeps burning. */
function stopTurn(){
  if(!turnCtl)return;
  stoppedByUser=true;
  api('/stop','POST',{agentId:'dev-bot'}).catch(()=>{});
  try{turnCtl.abort();}catch{}
  clearInterruptedBar();
}

/* ── HITL: the daemon is blocked waiting for a verdict ─────────────── */
function showHitl(turn,payload){
  let el=turn.querySelector('.hitl');
  if(!el){
    el=add(turn,'div','hitl');
    el.innerHTML=
      '<div class="hitl-h">Approval needed</div>'+
      '<div class="hitl-b"></div>'+
      '<div class="hitl-a"><button data-v="approve">Approve</button><button data-v="deny">Deny</button></div>';
  }
  const target=payload.target||payload.reason||'';
  el.querySelector('.hitl-b').textContent=`${payload.tool||'tool'} · ${String(target).slice(0,140)}`;
  el.querySelectorAll('button').forEach(b=>{
    b.disabled=false;
    b.onclick=async()=>{
      el.querySelectorAll('button').forEach(x=>x.disabled=true);
      try{ await api('/hitl/verdict','POST',{verdict:b.dataset.v==='approve'}); }catch{}
      el.remove();
    };
  });
  $('stream').scrollTop=$('stream').scrollHeight;
}

/* ── interrupted turns: offer the journal back instead of dropping it ── */
async function checkInterrupted(){
  const bar=$('interrupted-bar');
  if(!bar)return;
  try{
    const {status,data}=await api('/turns');
    if(status!==200)return;
    const t=((data&&data.turns)||[]).find(x=>x.agentId==='dev-bot');
    if(!t){clearInterruptedBar();return;}
    const age=Math.max(1,Math.round((Date.now()-new Date(t.saved_at||Date.now()).getTime())/60000));
    bar.innerHTML=
      `<span>Interrupted turn · <b>${esc(String(t.user||'').slice(0,70))||'(no text)'}</b> · ${t.receipts||0} receipts · ${age}m ago</span>`+
      `<span class="grow"></span>`+
      `<button data-act="resume">Resume</button><button data-act="discard">Discard</button>`;
    bar.hidden=false;
    bar.querySelector('[data-act="resume"]').onclick=()=>resumeTurn();
    bar.querySelector('[data-act="discard"]').onclick=async()=>{
      clearInterruptedBar();
      try{await api('/turns?agentId=dev-bot','DELETE');}catch{}
    };
  }catch{/* daemon offline: nothing to offer */}
}
function clearInterruptedBar(){
  const bar=$('interrupted-bar');
  if(bar){bar.hidden=true;bar.innerHTML='';}
}
async function resumeTurn(){
  if(busy)return;
  clearInterruptedBar();
  busy=true;
  try{await runTurn('',{resume:true});}
  finally{busy=false;}
}

/* ── slash + actions ─────────────────────────── */
async function handleSlash(raw){
  const [cmd,...rest]=raw.trim().split(/\s+/);
  const arg=rest.join(' ');
  switch(cmd){
    case '/compact':{
      const {data}=await api('/compact','POST',{agentId:'dev-bot',keep:6});
      if(data.success) toast(`compacted ${data.before} → ${data.after} messages (${data.method})`);
      else toast(data.error||'nothing to compact');
      return true;
    }
    case '/revert': await doRevert(1); return true;
    case '/review': openOverview('review'); return true;
    case '/files': openOverview('files'); return true;
    case '/terminal': openOverview('terminal'); return true;
    case '/skills': openOverview('skills'); return true;
    case '/help':
      toast(SLASH.map(s=>s.cmd+' — '+s.desc).join('   |   '));
      return true;
    case '/plan':
      await runTurn('Before acting, write a short numbered plan with the exact files you will touch, then execute it step by step. '+arg);
      return true;
    case '/goal':
      await runTurn('Treat this as a goal that must be verifiably complete. Do not stop until every part is verified with a tool receipt. Goal: '+arg);
      return true;
    default:
      return false;
  }
}
async function doRevert(turns){
  const {data}=await api('/revert','POST',{agentId:'dev-bot',turns});
  toast(data.success?`dropped ${data.dropped} messages · ${data.remaining} left`:(data.error||'revert failed'));
}
/** Desktop toast, only when the window is not in front and the user asked for it. */
function notifyDesktop(title, body){
  try{
    const prefs=uiPrefs();
    if(prefs.notifyDone===false) return;
    if(document.hasFocus()) return;                 // the answer is right there
    if(typeof window.Neutralino==='undefined'||!Neutralino.os?.showNotification) return;
    Neutralino.os.showNotification(String(title).slice(0,60), String(body||'').replace(/\s+/g,' ').slice(0,180));
  }catch{}
}
function toast(msg){
  let t=$('toast');
  if(!t){
    t=document.createElement('div');
    t.id='toast';
    /* top-centre, under the caption: never floats over the composer or the
       transcript the user is reading. Purely informational (no hit-testing). */
    t.style.cssText='position:fixed;left:50%;top:52px;transform:translateX(-50%);background:#303136e6;border:0;color:var(--text);padding:6px 12px;border-radius:999px;font-size:12px;line-height:18px;z-index:500;max-width:min(60%,520px);box-shadow:0 8px 24px #00000040;pointer-events:none;opacity:0;transition:opacity .18s';
    document.body.appendChild(t);
  }
  const hidden=t.style.display==='none'||t.style.display==='';
  const same=t.textContent===msg;
  t.textContent=msg;
  t.style.display='block';
  if(hidden){
    t.style.opacity='0';
    requestAnimationFrame(()=>{t.style.opacity='1';});
  }else{
    t.style.opacity='1';
  }
  clearTimeout(t._h);clearTimeout(t._h2);
  t._h=setTimeout(()=>{
    t.style.opacity='0';
    t._h2=setTimeout(()=>{t.style.display='none';},220);
  },same?1600:2400);
}

/* ── send ────────────────────────────────────── */
/* A reasoning model sometimes echoes the [THOUGHT: …] wrapper inside its native
   stream (and non-reasoning models always do). Strip the wrapper paragraph by
   paragraph so the Think block reads as prose, never as protocol. */
function tidyThink(raw){
  return String(raw||'').split(/\n{2,}/).map(p=>{
    let t=p.trim();
    if(/^\[THOUGHT:/i.test(t))t=t.replace(/^\[THOUGHT:\s*/i,'').replace(/\]$/,'');
    return t;
  }).filter(Boolean).join('\n\n');
}

/* The wire format must never reach the screen: keep only the answer body of a
   (possibly still-streaming) draft — drop [THOUGHT:], [TOOL:], [EXEC:], [READ:],
   [WRITE:…] and the [FINAL:] wrapper itself. */
function stripInternal(raw){
  const s=String(raw||'');
  const strip=(t)=>t
    .replace(/\[THOUGHT:[\s\S]*?\]/gi,' ')
    .replace(/\[(?:TOOL|EXEC|READ|WRITE):[\s\S]*?\]/gi,' ')
    .replace(/\[WRITE:[\s\S]*?\[\/WRITE\]/gi,' ')
    .replace(/\[\/WRITE\]/gi,' ');

  const fin=s.match(/\[FINAL:\s*([\s\S]*)$/i);
  if(fin){
    let body=strip(fin[1]).trimEnd();
    if(body.endsWith(']')){
      const opens=(body.match(/\[/g)||[]).length;
      const closes=(body.match(/\]/g)||[]).length;
      if(closes===opens+1) body=body.slice(0,-1).trimEnd(); // wrapper's own bracket only
    }
    return body.trim();
  }
  let body=strip(s);
  const open=body.search(/\[(?:THOUGHT|TOOL|EXEC|READ|WRITE|FINAL):/i);
  if(open>=0) body=body.slice(0,open);                       // block still streaming
  return body.trim();
}
async function send(){
  if(busy)return;
  const box=$('prompt');
  let text=box.value.trim();
  if(!text&&!ctxChips.length)return;

  if(ctxChips.length){
    text=(text?text+'\n\n':'')+'Context files to inspect first:\n'+ctxChips.map(c=>'- '+c).join('\n');
    ctxChips=[];renderChips();
  }
  box.value='';autoGrow();

  if(text.startsWith('/')){
    const handled=await handleSlash(text);
    if(handled)return;
  }

  lastUserText=text;
  userMessage(newTurn(),text);
  busy=true;
  await runTurn(text);
  busy=false;
}

/* ── composer plumbing ───────────────────────── */
function autoGrow(){
  const t=$('prompt');
  t.style.height='auto';
  t.style.height=Math.min(t.scrollHeight,180)+'px';
}
function renderChips(){
  $('chips').innerHTML=ctxChips.map((c,i)=>`<span class="chip"><b>@</b>${esc(c)}<span class="x" data-i="${i}">✕</span></span>`).join('');
  $('chips').querySelectorAll('.x').forEach(x=>x.onclick=()=>{ctxChips.splice(+x.dataset.i,1);renderChips();});
}
/* clicking anywhere in the capsule focuses the prompt (no accent colour involved) */
(function(){
  const box=document.querySelector('.cbox'); if(!box) return;
  box.addEventListener('mousedown',e=>{
    if(e.target.closest('button,a,textarea,label,.chip')) return;
    e.preventDefault();
    const p=$('prompt'); if(p) p.focus();
  });
})();

/* ── popovers ────────────────────────────────── */
function closePops(){document.querySelectorAll('.pop.open').forEach(p=>p.classList.remove('open'));}
/**
 * Place a popover next to its anchor without ever going off-screen:
 * pick the side (above/below) with more room, cap the height to that room,
 * then clamp on both axes. Content taller than the cap scrolls inside.
 */
function placePop(pop,anchor,align='left'){
  pop.classList.add('open');
  pop.style.maxHeight='';
  pop.style.left='0px';pop.style.top='0px';

  const r=anchor.getBoundingClientRect();
  const vh=window.innerHeight,vw=window.innerWidth;
  const gutter=10;
  const above=Math.max(0,r.top-gutter), below=Math.max(0,vh-r.bottom-gutter);

  // natural height, measured unconstrained
  const naturalH=pop.offsetHeight;
  const room=naturalH<=above?above:(naturalH<=below?below:Math.max(above,below));
  pop.style.maxHeight=Math.max(120,room-6)+'px';

  const w=pop.offsetWidth;
  const h=pop.offsetHeight;

  let left=align==='right'?r.right-w:r.left;
  left=Math.max(gutter,Math.min(left,vw-w-gutter));

  let top;
  if(naturalH<=above){top=r.top-h-6;}
  else if(naturalH<=below){top=r.bottom+6;}
  else if(above>=below){top=gutter;}
  else {top=Math.max(gutter,vh-h-gutter);}

  top=Math.max(gutter,Math.min(top,vh-h-gutter));
  pop.style.setProperty('--pop-origin', (top<r.top?'50% 100%':'50% 0%'));
  pop.style.left=left+'px';
  pop.style.top=top+'px';
}

/** Keep a popover glued to its anchor when the window resizes. */
let popAnchor=null, popEl=null;
function trackPop(pop,anchor){popEl=pop;popAnchor=anchor;}
window.addEventListener('resize',()=>{
  if(popEl&&popEl.classList.contains('open')&&popAnchor)placePop(popEl,popAnchor,'right');
});


/* ── keyboard shortcut sheet (View → Keyboard shortcuts, or Ctrl+?) ── */
const SHORTCUTS = [
  ['Ctrl + N', 'New conversation'],
  ['Ctrl + K', 'Open settings (search)'],
  ['Ctrl + ,', 'Open settings'],
  ['Ctrl + B', 'Toggle sidebar'],
  ['Ctrl + Alt + O', 'Toggle overview rail'],
  ['Ctrl + /', 'Model · reasoning picker'],
  ['Ctrl + ?', 'This sheet'],
  ['Enter', 'Send'],
  ['Shift + Enter', 'New line'],
  ['Tab', 'Accept slash suggestion'],
  ['@', 'Mention a file, skill or URL'],
  ['/', 'Slash actions'],
  ['Esc', 'Close popup / drawer'],
  ['↑ / ↓', 'Navigate a popup list'],
];
/* shortcut sheet lives in Settings → Keyboard Shortcuts (openSettingsAt) */
const MENUS={
  file:[
    {label:'New Conversation',act:()=>newConversation()},
    {label:'Compact History',act:()=>handleSlash('/compact')},
    {label:'Revert Last Turn',act:()=>doRevert(1)},
    {label:'Export Session JSON',act:()=>exportSessions()}
  ],
  workspace:[
    {label:'New Conversation  Ctrl+N',act:()=>newConversation()},
    {label:'Keyboard shortcuts  Ctrl+?',act:()=>openSettingsAt('keybinds')},
    {label:'Refresh Workspace',act:()=>loadWorkspace()},
    {label:'Skills Panel',act:()=>openOverview('skills')}
  ],
  view:[
    {label:'Toggle Sidebar  Ctrl+B',act:()=>toggleSidebar()},
    {label:'Keyboard shortcuts  Ctrl+?',act:()=>openSettingsAt('keybinds')},
    {label:'Toggle Overview  Ctrl+Alt+O',act:()=>toggleOverview()},
    {label:'Settings  Ctrl+,',act:()=>openDrawer()}
  ],
  window:[
    {label:'Minimize',act:()=>nl('window.minimize')},
    {label:'Maximize',act:()=>nl('window.maximize')},
    {label:'Close',act:()=>nl('window.close')}
  ]
};
async function nl(fn){
  try{ if(window.Neutralino&&Neutralino[fn.split('.')[0]]) await Neutralino[fn.split('.')[0]][fn.split('.')[1]](); }catch{}
}
function bindMenus(){
  document.querySelectorAll('[data-menu]').forEach(btn=>{
    btn.onclick=e=>{
      e.stopPropagation();
      const pop=$('pop-menu');
      if(pop.dataset.for===btn.dataset.menu&&pop.classList.contains('open')){closePops();return;}
      pop.dataset.for=btn.dataset.menu;
      pop.innerHTML='';
      for(const item of MENUS[btn.dataset.menu]||[]){
        const d=add(pop,'div','pi',`<span class="nm">${esc(item.label)}</span>`);
        d.setAttribute('role','button');d.tabIndex=0;
        d.onclick=()=>{closePops();item.act();};
        d.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();closePops();item.act();}};
      }
      placePop(pop,btn);
    };
  });
}
let LIVE_MODELS = [];
let LIVE_KEY = '';
let liveBusy = false;

/** Ask the daemon which models the active endpoint really serves. */
async function loadLiveModels(force) {
  const key = currentModel + '|' + currentEndpoint;
  if (!force && LIVE_KEY === key && LIVE_MODELS.length) return LIVE_MODELS;
  if (liveBusy) return LIVE_MODELS;
  liveBusy = true;
  try {
    const { data } = await api('/models');
    LIVE_MODELS = Array.isArray(data?.models) ? data.models : [];
    LIVE_KEY = key;
  } catch {
    LIVE_MODELS = [];
  } finally {
    liveBusy = false;
  }
  return LIVE_MODELS;
}

async function openModelPop(anchor) {
  const pop = $('pop-model');
  trackPop(pop, anchor);
  pop.innerHTML = '<div class="ph">Model · asking the provider…</div><div class="pi"><div class="ds skeleton" style="height:14px;width:70%">loading</div></div><div class="pi"><div class="ds skeleton" style="height:14px;width:55%">loading</div></div>';
  placePop(pop, anchor, 'right');
  const models = await loadLiveModels(false);
  renderModelPop(anchor, models, '');
}

function renderModelPop(anchor, models, filter) {
  const pop = $('pop-model');
  pop.innerHTML = `
    <div class="ph" style="display:flex;align-items:center;gap:6px">
      <span id="mp-count">Model · ${models.length} available</span>
      <span style="flex:1"></span>
      <button class="tinybtn" id="mp-refresh" title="Ask the provider again">refresh</button>
    </div>
    <div style="padding:4px 6px 6px"><input id="mp-search" placeholder="filter models" value="${esc(filter || '')}"
      style="width:100%;background:var(--panel2);border:1px solid var(--border-strong);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;font-family:var(--mono);outline:none"></div>
    <div id="mp-live" style="max-height:min(232px,30vh);overflow:auto"></div>
    <div id="mp-empty" class="pi" style="display:none"><div class="ds">No model matched.</div></div>`;

  const list = pop.querySelector('#mp-live');
  for (const id of models) {
    const d = add(list, 'div', 'pi' + (id === currentModel ? ' sel' : ''));
    d.dataset.model = String(id).toLowerCase();
    d.innerHTML = `<div class="r"><span class="nm">${esc(id)}</span>${id === currentModel ? '<span class="tag">current</span>' : ''}</div>`;
    d.onclick = () => { closePops(); switchToModel(id); };
    d.setAttribute("role","button"); d.tabIndex=0;
  }
  if (!models.length) {
    pop.querySelector('#mp-empty').style.display = '';
    pop.querySelector('#mp-empty').innerHTML = '<div class="ds">The endpoint returned no models — check the key in Settings → Providers, then press refresh.</div>';
  }

  const presets = CATALOG.filter(c => !models.includes(c.model));
  if (presets.length) {
    add(pop, 'div', 'sep');
    add(pop, 'div', 'ph', 'Other providers (presets)');
    const pl = add(pop, 'div', '');
    pl.id = 'mp-presets';
    pl.style.cssText = 'max-height:min(112px,15vh);overflow:auto';
    for (const m of presets) {
      const d = add(pl, 'div', 'pi');
      d.dataset.preset = (m.label + ' ' + m.model + ' ' + m.provider).toLowerCase();
      d.innerHTML = `<div class="r"><span class="nm">${esc(m.label)}</span><span class="tag">${esc(m.provider)}</span></div>`;
      d.onclick = () => { closePops(); applyModel(m); };
      d.setAttribute("role","button"); d.tabIndex=0;
    }
  }

  add(pop, 'div', 'sep');
  add(pop, 'div', 'ph', 'Reasoning effort');
  for (const lvl of ['auto', 'low', 'medium', 'high']) {
    const d = add(pop, 'div', 'pi' + (lvl === reasoning ? ' sel' : ''), `<span class="nm">${lvl[0].toUpperCase() + lvl.slice(1)}</span>`);
    d.onclick = () => { closePops(); applyReasoning(lvl); };
    d.setAttribute("role","button"); d.tabIndex=0;
  }

  // Filter in place: keeps focus, caret and scroll position intact.
  const search = pop.querySelector('#mp-search');
  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    pop.querySelectorAll('#mp-live .pi[data-model]').forEach(el => {
      const hit = !q || el.dataset.model.includes(q);
      el.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    pop.querySelectorAll('#mp-presets .pi[data-preset]').forEach(el => {
      const hit = !q || el.dataset.preset.includes(q);
      el.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    const empty = pop.querySelector('#mp-empty');
    if (models.length) empty.style.display = shown ? 'none' : '';
    pop.querySelector('#mp-count').textContent = q
      ? `Model · ${shown} match${shown === 1 ? '' : 'es'} of ${models.length}`
      : `Model · ${models.length} available`;
    placePop(pop, anchor, 'right');
  };
  search.addEventListener('input', applyFilter);
  if (filter) applyFilter();

  pop.querySelector('#mp-refresh').onclick = async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.textContent = '…';
    btn.disabled = true;
    const fresh = await loadLiveModels(true);
    renderModelPop(anchor, fresh, search.value);
    toast(fresh.length ? fresh.length + ' models from the endpoint' : 'the endpoint returned no models');
  };

  placePop(pop, anchor, 'right');
  setTimeout(() => { try { search.focus(); search.select(); } catch { /* noop */ } }, 0);
}

/** Switch to a model the provider actually listed (same provider/endpoint). */
async function switchToModel(id) {
  const { status, data } = await api('/model/switch', 'POST', { model: id });
  if (status === 200 && data.success) {
    currentModel = id;
    renderModel();
    liveKeyInvalidate();
    loadProjects().catch(()=>{});
    // no toast: the model chip already shows the new model
  } else {
    toast('switch failed: ' + (data.error || status));
  }
}
function liveKeyInvalidate() { LIVE_KEY = ''; }
async function applyModel(m){
  const {status,data}=await api('/config','POST',{
    'engine.model':m.model,'engine.provider':m.provider,'engine.endpoint':m.endpoint
  });
  if(status===200&&data.success){
    currentModel=m.model;currentEndpoint=m.endpoint||currentEndpoint;renderModel();liveKeyInvalidate();loadProjects().catch(()=>{});
  }else toast('failed: '+(data.error||status));
}
async function applyReasoning(lvl){
  reasoning=lvl;renderModel();
  const {status,data}=await api('/config','POST',{'engine.reasoning_effort':lvl});
  if(!(status===200&&data.success))toast('failed: '+(data.error||status));
}
function openPermsPop(anchor){
  const pop=$('pop-perms');
  trackPop(pop,anchor);
  pop.innerHTML='<div class="ph">Agent permissions</div>';
  for(const p of PRESETS){
    const d=add(pop,'div','pi'+(p.id===permissions?' sel':''));
    d.innerHTML=`<div class="r"><span class="nm">${esc(p.label)}</span></div><div class="ds">${esc(p.desc)}</div>`;
    d.onclick=()=>{closePops();applyPreset(p);};
  }
  placePop(pop,anchor,'right');
}
async function applyPreset(p){
  permissions=p.id;renderPerms();
  const {status,data}=await api('/config','POST',{'policy.terminal.mode':p.mode});
  if(!(status===200&&data.success))toast('failed: '+(data.error||status));
}
function openSlashPop(anchor,filter){
  const pop=$('pop-slash');
  trackPop(pop,anchor);
  const q=(filter||'').toLowerCase();
  const items=SLASH.filter(s=>s.cmd.startsWith(q)||!q);
  if(!items.length){closePops();return;}
  pop.innerHTML='<div class="ph">Actions</div>';
  items.forEach((s,i)=>{
    const d=add(pop,'div','pi'+(i===0?' sel':''));
    d.innerHTML=`<div class="r"><span class="nm">${esc(s.cmd)}</span></div><div class="ds">${esc(s.desc)}</div>`;
    d.onclick=()=>{$('prompt').value='';autoGrow();closePops();handleSlash(s.cmd);};
  });
  placePop(pop,anchor,'left');
}
function openAtPop(anchor){
  const pop=$('pop-at');
  trackPop(pop,anchor);
  pop.innerHTML='<div class="ph">Add context</div>';
  api('/workspace').then(({data})=>{
    const files=(data?.workspace?.changed_files||[]).map(f=>f.path);
    if(!files.length){
      add(pop,'div','pi','<div class="ds">No changed files to attach. Type a path manually.</div>');
    }else{
      files.slice(0,12).forEach(f=>{
        const d=add(pop,'div','pi',`<span class="nm">${esc(f)}</span>`);
        d.onclick=()=>{closePops();ctxChips.push(f);renderChips();$('prompt').focus();};
      });
    }
    placePop(pop,anchor,'left');
  });
}

/* ── overview rail ───────────────────────────── */
function openOverview(key){
  document.querySelectorAll('.ovbody').forEach(b=>b.classList.remove('open'));
  /* ── footer pickers: local checkout folder and git branch ────────────── */

/** Neutralino helpers, with a plain-browser fallback so the page stays honest
 *  when it is opened outside the shell (no folder dialog available). */
function nlReady(){ return typeof window.Neutralino !== 'undefined'; }
async function openPathExternally(target){
  try{
    if(nlReady()){ await Neutralino.os.open(target); return true; }
    return false;
  }catch{ return false; }
}
async function pickFolder(){
  try{
    if(!nlReady()) return null;
    const picked=await Neutralino.os.showFolderDialog('Choose the folder this session works in');
    return picked?String(picked):null;
  }catch{ return null; }
}

function rememberWorkspace(path){
  try{
    const list=JSON.parse(localStorage.getItem('liber-recent-workspaces')||'[]');
    localStorage.setItem('liber-recent-workspaces',JSON.stringify([path,...list.filter(p=>p!==path)].slice(0,6)));
  }catch{}
}
function recentWorkspaces(){
  try{ return JSON.parse(localStorage.getItem('liber-recent-workspaces')||'[]'); }catch{ return []; }
}

/** Ask the daemon to root itself in another folder. It restarts there, so the
 *  window has to re-read the token file the new instance writes. */
async function switchWorkspace(target){
  const pop=$('pop-checkout');
  pop.innerHTML='<div class="ph">Switching workspace…</div><div class="pmeta">Restarting the daemon in <code>'+esc(target)+'</code></div>';
  try{
    const r=await api('/workspace/switch','POST',{path:target});
    if(r.status>=400||!r.data?.success){ toast(r.data?.error||'switch refused'); closePops(); return; }
    rememberWorkspace(r.data.cwd||target);
    closePops();
    toast('workspace → '+(r.data.cwd||target)+' · daemon restarting');
    let up=false;
    for(let i=0;i<40&&!up;i++){
      await new Promise(res=>setTimeout(res,300));
      try{ const h=await fetch(DAEMON+'/healthz',{cache:'no-store'}); up=h.ok; }catch{}
    }
    if(!up){ toast('daemon did not come back — reopen the window'); return; }
    token='';
    await loadToken();
    if(!token){ toast('restarted, but the new token was not readable'); return; }
    await loadConfig().catch(()=>{});
    await loadWorkspace().catch(()=>{});
    await loadProjects().catch(()=>{});
    setState('online','IDLE');
    toast(r.data.keys_copied?'workspace ready · provider keys copied here':'workspace ready');
  }catch(err){ toast('switch failed: '+err.message); }
}

async function openCheckoutPop(anchor){
  const pop=$('pop-checkout');
  if(pop.classList.contains('open')&&pop.dataset.for==='checkout'){ closePops(); return; }
  closePops();
  pop.dataset.for='checkout';
  pop.innerHTML='<div class="ph">Local checkout</div>';

  const meta=add(pop,'div','pmeta');
  meta.innerHTML='Working folder<br><code>'+esc(cwd||'(unknown)')+'</code>';

  const actions=add(pop,'div','pactions');
  const open=add(actions,'button','tinybtn','Open folder');
  open.onclick=async e=>{ e.stopPropagation(); const ok=await openPathExternally(cwd); if(!ok) toast('cannot open the folder from here'); };
  const copy=add(actions,'button','tinybtn','Copy path');
  copy.onclick=async e=>{ e.stopPropagation(); try{ await navigator.clipboard.writeText(cwd); toast('path copied'); }catch{ toast('copy blocked'); } };

  const recents=recentWorkspaces().filter(p=>p.toLowerCase()!==String(cwd||'').toLowerCase());
  if(recents.length){
    add(pop,'div','sep');
    add(pop,'div','ph','Recent workspaces');
    for(const path of recents){
      const label=String(path).split(/[\\/]/).filter(Boolean).pop()||path;
      const row=add(pop,'button','prow','<span>'+esc(label)+'</span><span class="meta">'+esc(path)+'</span>');
      row.type='button';
      row.onclick=()=>switchWorkspace(path);
    }
  }

  add(pop,'div','sep');
  const choose=add(pop,'button','prow','<span>Choose folder…</span><span class="meta">local drive</span>');
  choose.type='button';
  choose.onclick=async()=>{
    const picked=await pickFolder();
    if(!picked){ toast('no folder chosen'); return; }
    if(String(picked).toLowerCase()===String(cwd||'').toLowerCase()){ toast('already working in that folder'); return; }
    switchWorkspace(picked);
  };

  placePop(pop,anchor,'left');
}

async function openBranchPop(anchor){
  const pop=$('pop-branch');
  if(pop.classList.contains('open')&&pop.dataset.for==='branch'){ closePops(); return; }
  closePops();
  pop.dataset.for='branch';
  pop.innerHTML='<div class="ph">Branch</div><div class="pmeta">reading git…</div>';

  const r=await api('/git');
  pop.innerHTML='';
  add(pop,'div','ph','Branch');

  if(r.status>=400||!r.data?.success){ add(pop,'div','pmeta','The daemon did not answer.'); placePop(pop,anchor,'left'); return; }
  const d=r.data;
  if(!d.is_git){
    add(pop,'div','pmeta','This folder is not a git repository. Choose another folder in Local Checkout, or run <code>git init</code>.');
    placePop(pop,anchor,'left');
    return;
  }

  const head=add(pop,'div','pmeta');
  head.innerHTML='On <b style="color:var(--text)">'+esc(d.branch||'detached')+'</b>'
    +(d.dirty?' · uncommitted changes':' · clean')
    +((d.ahead||d.behind)?' · ↑'+(d.ahead||0)+' ↓'+(d.behind||0):'');

  const listWrap=add(pop,'div','');
  listWrap.style.cssText='max-height:min(260px,40vh);overflow:auto';
  for(const b of d.branches||[]){
    const row=add(listWrap,'button','prow'+(b.current?' sel':''),
      '<span>'+esc(b.name)+'</span>'+(b.current?'<span class="meta">current</span>':''));
    row.type='button';
    row.onclick=async()=>{
      if(b.current){ closePops(); return; }
      row.disabled=true;
      const res=await api('/git/checkout','POST',{branch:b.name});
      if(res.status<400&&res.data?.success){
        toast('branch → '+(res.data.branch||b.name));
        closePops();
        await loadWorkspace();
      }else{
        row.disabled=false;
        toast(res.data?.error||'checkout refused');
      }
    };
  }

  if(d.remote){
    add(pop,'div','sep');
    const remote=add(pop,'div','pmeta');
    remote.innerHTML='Remote <b style="color:var(--text)">'+esc(d.remote.name)+'</b><br><code>'+esc(d.remote.url)+'</code>';
    const actions=add(pop,'div','pactions');
    const fetchBtn=add(actions,'button','tinybtn','Fetch origin');
    fetchBtn.type='button';
    fetchBtn.onclick=async e=>{
      e.stopPropagation();
      fetchBtn.textContent='fetching…'; fetchBtn.disabled=true;
      const fres=await api('/git/fetch','POST');
      if(fres.status<400&&fres.data?.success){
        toast('fetched · ↑'+(fres.data.ahead||0)+' ↓'+(fres.data.behind||0));
        closePops();
        await loadWorkspace();
      }else{
        fetchBtn.disabled=false; fetchBtn.textContent='Fetch origin';
        toast(fres.data?.error||'fetch failed');
      }
    };
    if(d.github_url){
      const gh=add(actions,'button','tinybtn','Open on GitHub');
      gh.type='button';
      gh.onclick=async e=>{
        e.stopPropagation();
        const opened=await openPathExternally(d.github_url);
        if(!opened){ try{ window.open(d.github_url,'_blank'); }catch{ toast(d.github_url); } }
      };
    }
  }else{
    add(pop,'div','pmeta','No remote configured — nothing to fetch.');
  }

  placePop(pop,anchor,'left');
}

$('btn-checkout')?.addEventListener('click',e=>{ e.stopPropagation(); openCheckoutPop(document.querySelector('.cbox')||$('btn-checkout')); });
$('btn-branch')?.addEventListener('click',e=>{ e.stopPropagation(); openBranchPop(document.querySelector('.cbox')||$('btn-branch')); });


document.querySelectorAll('.ovrow').forEach(r=>r.classList.remove('active'));
  const body=$('ov-'+key);
  const row=document.querySelector('.ovrow[data-ov="'+key+'"]');
  if(body)body.classList.add('open');
  if(row)row.classList.add('active');
}
function toggleOverview(){
  const o=$('overview');
  o.classList.toggle('hidden');
  if(!o.classList.contains('hidden')) openOverview('review');
}
function closeOverview(){$('overview').classList.add('hidden');}
function toggleSidebar(){
  const s=$('sidebar');
  s.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed',s.classList.contains('collapsed'));
}

/* ── conversations list ──────────────────────── */
function relTime(iso){
  if(!iso)return '';
  const ms=Date.now()-new Date(iso).getTime();
  const m=Math.round(ms/60000);
  if(m<1)return 'now';
  if(m<60)return m+'m';
  const h=Math.round(m/60);
  if(h<24)return h+'h';
  return Math.round(h/24)+'d';
}
/* ── sessions: every session owns a daemon memory key ──────────────── */
const SESS_KEY='liber.sessions.v1';
let sessionList=[];
let activeSession='default';
const streamCache=new Map();

function loadSessionState(){
  try{
    const raw=JSON.parse(localStorage.getItem(SESS_KEY)||'{}');
    if(Array.isArray(raw.list))sessionList=raw.list.filter(s=>s&&s.id);
    if(typeof raw.active==='string')activeSession=raw.active;
  }catch{sessionList=[];}
  if(!sessionList.length)sessionList=[{id:'default',title:'Current session',at:Date.now()}];
  if(!sessionList.some(s=>s.id===activeSession))activeSession=sessionList[0].id;
}
function saveSessionState(){
  try{localStorage.setItem(SESS_KEY,JSON.stringify({list:sessionList,active:activeSession}));}catch{/* private mode */}
}
function newSessionId(){return 's'+Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-4);}
function activeSessionObj(){return sessionList.find(s=>s.id===activeSession)||null;}
function emptyMarkup(){return '<div class="empty" id="empty-state"><div class="hero-mark">◢</div><div class="hero-title">What should we build?</div><div class="hero-sub">Machine-enforced grounding · every claim lands on a tool receipt.</div></div>';}
function sessionAge(at){return relTime(new Date(at||Date.now()).toISOString());}
function cacheStream(){if($('stream'))streamCache.set(activeSession,$('stream').innerHTML);}

function renderSessions(){
  const host=$('project-list');if(!host)return;
  host.innerHTML='';
  const p=add(host,'button','proj','<span style="color:var(--dim)">▣</span> dev-bot <span class="grow"></span>');
  p.onclick=()=>{};
  for(const s of sessionList){
    const row=add(host,'div','conv'+(s.id===activeSession?' active':''),
      `<span class="nm">${esc(s.title)}</span><span class="ago">${sessionAge(s.at)}</span>`+
      `<button class="more" type="button" title="Rename or delete" aria-label="Session actions">⋯</button>`);
    row.dataset.id=s.id;
    row.setAttribute('role','button');
    row.tabIndex=0;
    row.onclick=e=>{if(e.target.closest('.more'))return;openSession(s.id);};
    row.onkeydown=e=>{
      if(e.target!==row)return;
      if(e.key==='Enter'||e.key===' '){e.preventDefault();openSession(s.id);}
      if(e.key==='F2'){e.preventDefault();startRename(s.id);}
    };
    row.ondblclick=e=>{if(e.target.closest('.more'))return;e.preventDefault();startRename(s.id);};
    row.oncontextmenu=e=>{e.preventDefault();openSessionMenu(row.querySelector('.more'),s);};
    row.querySelector('.more').onclick=e=>{e.stopPropagation();openSessionMenu(e.currentTarget,s);};
  }
  const c2=add(host,'button','conv','<span class="nm">＋ New session</span>');
  c2.onclick=()=>newConversation();
}

/** Create a read-only link for a session and put it on the clipboard. */
async function shareSession(id){
  const key = (!id||id==='default') ? 'dev-bot' : 'dev-bot#'+id;
  const r=await api('/sessions/share','POST',{key});
  if(r.status!==200||!r.data.success){toast('share failed: '+((r.data&&r.data.error)||r.status));return;}
  const url=new URL(DAEMON+r.data.path).href;
  try{await navigator.clipboard.writeText(url);toast('read-only link copied');}
  catch{toast(url);}
}

function openSessionMenu(anchor,s){
  const pop=$('pop-menu');
  closePops();
  pop.dataset.for='session';
  pop.style.minWidth='180px';
  pop.innerHTML='';
  const items=[
    {label:'Share link (read-only)',hint:'',act:()=>shareSession(s.id)},
    {label:'Rename session',hint:'F2',act:()=>startRename(s.id)},
    {label:'Delete session',hint:'',act:()=>deleteSession(s.id)}
  ];
  for(const item of items){
    const d=add(pop,'div','pi',`<span class="nm">${esc(item.label)}</span>`+(item.hint?`<span class="tag">${esc(item.hint)}</span>`:''));
    d.setAttribute('role','button');d.tabIndex=0;
    d.onclick=()=>{closePops();item.act();};
    d.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();closePops();item.act();}};
  }
  placePop(pop,anchor,'right');
}

function startRename(id){
  const row=document.querySelector(`.conv[data-id="${id}"]`);
  const s=sessionList.find(x=>x.id===id);
  if(!row||!s||row.classList.contains('renaming'))return;
  const nm=row.querySelector('.nm');if(!nm)return;
  const ago=row.querySelector('.ago');if(ago)ago.style.display='none';
  const input=document.createElement('input');
  input.className='rn';input.type='text';input.value=s.title;input.maxLength=64;
  input.setAttribute('aria-label','Session name');
  nm.replaceWith(input);
  row.classList.add('renaming');
  input.focus();input.select();
  let done=false;
  const finish=save=>{
    if(done)return;done=true;
    const v=input.value.replace(/\s+/g,' ').trim();
    if(save&&v&&v!==s.title){
      s.title=v;saveSessionState();
      if(id===activeSession)$('crumb').innerHTML='<span>dev-bot</span><span class="sep">›</span><b>'+esc(s.title)+'</b>';
    }
    renderSessions();
  };
  input.onkeydown=e=>{
    if(e.key==='Enter'){e.preventDefault();finish(true);}
    else if(e.key==='Escape'){e.preventDefault();finish(false);}
    e.stopPropagation();
  };
  input.onblur=()=>finish(true);
}

function deleteSession(id){
  const i=sessionList.findIndex(s=>s.id===id);
  if(i<0)return;
  const removed=sessionList[i];
  sessionList.splice(i,1);
  streamCache.delete(id);
  /* drop that session's daemon window too (the default session keeps its key) */
  if(id!=='default')api('/sessions?key='+encodeURIComponent('dev-bot#'+id),'DELETE').catch(()=>{});
  if(!sessionList.length)sessionList=[{id:'default',title:'Current session',at:Date.now()}];
  if(activeSession===id){
    activeSession=sessionList[Math.min(i,sessionList.length-1)].id;
    saveSessionState();
    paintSession();
  }else{
    saveSessionState();
    renderSessions();
  }
  toast('deleted · '+removed.title);
}

/* ── session history: reopen a session from the daemon, not from RAM ───── */

/** Messages worth showing: the harness stores observations and repair nudges in
 *  the same list, and replaying those as chat would be gibberish. */
const HISTORY_NOISE = /^(OBSERVATION \[E|STOP — you are out|You have at most \d|You returned an empty response|Your reply contained no \[FINAL|DENIED: approval|GROUNDING AUDIT|Your previous answer)/;

function historyPairs(messages) {
  const out = [];
  let pendingUser = null;
  for (const m of messages || []) {
    const text = String(m.content || '').trim();
    if (!text) continue;
    if (m.role === 'user') {
      if (HISTORY_NOISE.test(text)) continue;
      pendingUser = text;
      continue;
    }
    if (m.role === 'assistant') {
      if (text === '[native tool calls]') continue;
      // stored turns may still carry the raw protocol ([THOUGHT:], [FINAL:]);
      // replay the answer the user actually saw, not the machinery.
      const clean = stripInternal(text).trim();
      if (!clean) continue;
      out.push({ user: pendingUser, assistant: clean });
      pendingUser = null;
    }
  }
  if (pendingUser) out.push({ user: pendingUser, assistant: null });
  return out;
}

/** Render stored history into the current view; returns how many turns landed. */
function renderHistory(messages) {
  const stream = $('stream');
  if (!stream) return 0;
  stream.innerHTML = '';
  turns = [];
  const pairs = historyPairs(messages);
  for (const pair of pairs) {
    const turn = newTurn();
    if (pair.user) userMessage(turn, pair.user);
    if (pair.assistant) answerBlock(turn, pair.assistant);
  }
  if (!pairs.length) stream.innerHTML = emptyMarkup();
  stream.scrollTop = stream.scrollHeight;
  return pairs.length;
}

/** Fetch and paint one session's messages from the daemon. */
async function hydrateSession(id) {
  const key = id && id !== 'default' ? 'dev-bot#' + id : 'dev-bot';
  const { status, data } = await api('/sessions/history?key=' + encodeURIComponent(key)).catch(() => ({}));
  if (status !== 200 || !data?.success) return 0;
  const s = activeSessionObj();
  if (s && data.title && (!s.title || s.title === 'New session' || s.title === 'Current session')) {
    s.title = data.title;
    saveSessionState();
    renderSessions();
  }
  return renderHistory(data.messages || []);
}

/** Search every session's stored text; clicking a hit opens that session. */
async function searchSessions(query) {
  const host = $('project-list');
  if (!host) return;
  const q = String(query || '').trim();
  if (q.length < 2) { renderSessions(); return; }

  const local = sessionList.filter(s => String(s.title || '').toLowerCase().includes(q.toLowerCase()));
  const { data } = await api('/sessions/search?q=' + encodeURIComponent(q)).catch(() => ({}));
  const hits = (data?.hits || []).slice(0, 20);

  host.innerHTML = '';
  if (local.length) {
    add(host, 'div', 'sect', '<span>Sessions</span>');
    for (const s of local) {
      const row = add(host, 'div', 'conv', `<span class="nm">${esc(s.title)}</span>`);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.onclick = () => { $('session-search').value = ''; openSession(s.id); };
    }
  }
  add(host, 'div', 'sect', `<span>In messages${hits.length ? ' · ' + hits.length : ''}</span>`);
  if (!hits.length) {
    add(host, 'div', 'skill', 'no match in stored history');
    return;
  }
  for (const hit of hits) {
    const id = String(hit.key || '').replace(/^dev-bot#/, '');
    const row = add(host, 'div', 'conv', `<span class="nm">${esc(hit.snippet)}</span><span class="ago">${esc(hit.role)}</span>`);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.onclick = () => { $('session-search').value = ''; if (id && id !== hit.key) openSession(id); };
  }
}

/* typing filters locally and searches the stored history, debounced */
(function () {
  const input = $('session-search');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => searchSessions(input.value), 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; renderSessions(); input.blur(); }
    if (e.key === 'Enter') { e.preventDefault(); searchSessions(input.value); }
  });
})();

/* ── merge daemon sessions into the sidebar list ─────────────────────── */
/** The sidebar list is local, the messages are on disk. Without this, a fresh
 *  window shows no history even though the daemon still has every session. */
async function syncSessionsFromDaemon(){
  const { status, data } = await api('/sessions').catch(() => ({}));
  if (status !== 200 || !data?.success) return 0;
  const keys = Object.keys(data.sessions || {});
  let added = 0;
  for (const key of keys) {
    const id = key.startsWith('dev-bot#') ? key.slice('dev-bot#'.length) : (key === 'dev-bot' ? 'default' : key);
    if (sessionList.some(s => s.id === id)) continue;
    const row = data.sessions[key] || {};
    const label = row.title || row.last || null;
    sessionList.push({
      id,
      title: label ? String(label).replace(/\s+/g, ' ').slice(0, 48) : 'Session',
      at: Date.now()
    });
    added++;
  }
  if (added) { saveSessionState(); renderSessions(); }
  return added;
}

function paintSession(){
  const s=activeSessionObj();
  const cached=streamCache.get(activeSession);
  $('stream').innerHTML=cached||emptyMarkup();
  $('crumb').innerHTML='<span>dev-bot</span><span class="sep">›</span><b>'+esc(s?s.title:'New session')+'</b>';
  turns=[];ctxChips=[];renderChips();
  renderSessions();
  if(!cached) hydrateSession(activeSession).catch(()=>{});
}

function openSession(id){
  closePops();
  if(id===activeSession)return;
  cacheStream();
  activeSession=id;saveSessionState();
  paintSession();
  $('prompt').focus();
}

async function loadProjects(){
  if(!sessionList.length)loadSessionState();
  renderSessions();
  syncSessionsFromDaemon().catch(()=>{});
  try{
    const {data}=await api('/ps');
    const agents=data?.data||[];
    if(!agents.length){
      const host=$('project-list');
      const n=document.createElement('div');
      n.className='skill';
      n.textContent='daemon offline · sessions are local';
      host.insertBefore(n,host.firstChild);
    }
  }catch{/* daemon offline: the local session list still works */}
}
async function exportSessions(){
  const {data}=await api('/sessions');
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='liber-sessions.json';a.click();
  URL.revokeObjectURL(a.href);
}
function newConversation(){
  cacheStream();
  const s={id:newSessionId(),title:'New session',at:Date.now()};
  sessionList.unshift(s);
  activeSession=s.id;
  saveSessionState();
  streamCache.delete(s.id);
  paintSession();
  $('prompt').focus();
  toast('new session');
}

/* ── settings drawer (Antigravity-style categories) ── */
const NAV=[
  {id:'general',label:'General',icon:'⚙'},
  {id:'model',label:'Models',icon:'🤖',groups:[{id:'main',label:'Main model'},{id:'reasoning',label:'Reasoning'},{id:'limits',label:'Limits'}]},
  {id:'permissions',label:'Permissions',icon:'🛡'},
  {id:'grounding',label:'Grounding',icon:'✔'},
  {id:'appearance',label:'Appearance',icon:'🎨'},
  {id:'memory',label:'Memory & Context',icon:'🧠'},
  {id:'skills',label:'Skills',icon:'◆'},
  {id:'sessions',label:'Sessions',icon:'📜'},
  {id:'shortcuts',label:'Shortcuts',icon:'⌨'},
  {id:'about',label:'About',icon:'ℹ'}
];
function f(label,input,hint){
  const d=document.createElement('div');d.className='f';
  d.innerHTML=`<label>${label}</label><div class="c">${input}${hint?`<div class="hint">${hint}</div>`:''}</div>`;
  return d;
}
function openDrawer(){
  buildNav();renderPanel();
  $('drawer-overlay').classList.add('open');
  setTimeout(()=>$('drawer-search').focus(),50);
}
function closeDrawer(){$('drawer-overlay').classList.remove('open');}
/** Open the settings drawer on a specific category (skips the tree). */
function openSettingsAt(cat){ds={cat,item:null};openDrawer();}
function applyAccent(col){
  document.documentElement.style.setProperty('--accent',col);
  try{localStorage.setItem('liber-accent',col);}catch{}
  document.querySelectorAll('.sw').forEach(s=>{
    s.classList.toggle('sel',(s.dataset.color||'').toLowerCase()===String(col).toLowerCase());
  });
}

/* ── events ──────────────────────────────────── */
$('send-btn').onclick=()=>{ if(busy) stopTurn(); else send(); };
$('prompt').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
  if(e.key==='Tab'){ // quick accept of slash suggestion
    const t=$('prompt');
    if(t.value.startsWith('/')){
      e.preventDefault();
      const hit=SLASH.find(s=>s.cmd.startsWith(t.value.trim()));
      if(hit){t.value=hit.cmd+' ';}
    }
  }
});
$('prompt').addEventListener('input',e=>{
  autoGrow();
  const v=$('prompt').value;
  if(v.startsWith('/')&&!v.includes(' ')) openSlashPop($('prompt'),v.trim());
  else if(v.endsWith('@')) openAtPop($('prompt'));
  else closePops();
});
$('btn-model').onclick=e=>{e.stopPropagation();openModelPop($('btn-model'));};
$('btn-perms').onclick=e=>{e.stopPropagation();openPermsPop($('btn-perms'));};
$('btn-context').onclick=e=>{e.stopPropagation();openAtPop($('btn-context'));};
$('drawer-close').onclick=closeDrawer;
$('drawer-overlay').onclick=e=>{if(e.target===$('drawer-overlay'))closeDrawer();};
$('drawer-search').addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('#drawer-nav .ditem').forEach(el=>{
    const hit=!q||el.textContent.toLowerCase().includes(q);
    el.style.display=hit?'':'none';
  });
});
$('sidebar-toggle').onclick=toggleSidebar;
$('caption-new').onclick=newConversation;
$('overview-toggle').onclick=toggleOverview;
$('ov-close').onclick=closeOverview;
$('new-conv').onclick=newConversation;
$('nav-settings').onclick=openDrawer;
$('nav-skills').onclick=()=>{openOverview('skills');};
/* ── Automations: scheduled prompts that run while you are elsewhere ───── */
function ensureAutomationsModal(){
  let el=document.getElementById('auto-modal');
  if(el) return el;
  el=document.createElement('div');
  el.id='auto-modal';
  el.style.cssText='position:fixed;inset:0;z-index:520;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)';
  el.innerHTML='<div class="auto-card" style="width:min(640px,92vw);max-height:82vh;overflow:auto;background:var(--panel);border:.5px solid var(--border-strong);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.7)">'
    +'<div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--border)">'
      +'<b style="font-size:13px">Automations</b><span class="grow" style="flex:1"></span><button class="tinybtn" id="auto-close">✕</button></div>'
    +'<div id="auto-body" style="padding:12px 14px 14px"></div></div>';
  document.body.appendChild(el);
  el.addEventListener('click',e=>{ if(e.target===el) closeAutomations(); });
  el.querySelector('#auto-close').onclick=closeAutomations;
  return el;
}
function closeAutomations(){ const el=document.getElementById('auto-modal'); if(el) el.style.display='none'; }

async function openAutomations(){
  const el=ensureAutomationsModal();
  el.style.display='flex';
  await paintAutomations();
}

async function paintAutomations(){
  const body=document.getElementById('auto-body');
  if(!body) return;
  body.innerHTML='<div style="color:var(--dim);font-size:12px">reading…</div>';
  const r=await api('/automations').catch(()=>null);
  const jobs=(r&&r.data&&r.data.jobs)||[];
  body.innerHTML='';

  const intro=document.createElement('div');
  intro.style.cssText='color:var(--dim);font-size:12px;line-height:18px;margin-bottom:10px';
  intro.textContent='A prompt that runs on a schedule in its own session. Same engine, same grounding gate and the same terminal policy as a manual turn — it just does not need you to press Enter.';
  body.appendChild(intro);

  if(!jobs.length){
    const empty=document.createElement('div');
    empty.style.cssText='color:var(--dim);font-size:12px;padding:6px 0 10px';
    empty.textContent='No automations yet.';
    body.appendChild(empty);
  }

  for(const j of jobs){
    const row=document.createElement('div');
    row.style.cssText='border:.5px solid var(--border);border-radius:10px;padding:9px 11px;margin-bottom:8px';
    const when=j.schedule.type==='daily'?('daily at '+j.schedule.at):('every '+j.schedule.minutes+' min');
    const last=j.lastResult?((j.lastResult.ok?'✓ ':'✖ ')+(j.lastResult.excerpt||j.lastResult.error||'')).slice(0,110):'never run';
    row.innerHTML='<div style="display:flex;gap:8px;align-items:baseline">'
      +'<b style="font-size:12.5px">'+esc(j.name)+'</b>'
      +'<span style="font-size:11px;color:var(--dim)">'+esc(when)+'</span>'
      +'<span style="flex:1"></span>'
      +'<span style="font-size:11px;color:'+(j.enabled?'var(--green)':'var(--dim)')+'">'+(j.enabled?'on':'off')+'</span></div>'
      +'<div style="font-size:11.5px;color:var(--muted);margin:3px 0 6px">'+esc((j.prompt||'').slice(0,160))+'</div>'
      +'<div style="font-size:11px;color:var(--dim);margin-bottom:7px">last: '+esc(last)+' · runs: '+j.runCount+'</div>';

    const acts=document.createElement('div');
    acts.style.cssText='display:flex;gap:6px;flex-wrap:wrap';
    const mk=(label,fn,primary)=>{
      const b=document.createElement('button');
      b.className=primary?'btn primary':'tinybtn';
      b.textContent=label;
      b.onclick=fn;
      acts.appendChild(b);
      return b;
    };
    mk('Run now',async()=>{ 
      const rr=await api('/automations/run','POST',{id:j.id});
      toast(rr&&rr.data&&rr.data.success?'ran · '+String(rr.data.response||'').slice(0,60):'run failed');
      await paintAutomations();
      loadProjects().catch(()=>{});
    },true);
    mk(j.enabled?'Disable':'Enable',async()=>{ await api('/automations/update','POST',{id:j.id,patch:{enabled:!j.enabled}}); await paintAutomations(); });
    mk('Delete',async()=>{ await api('/automations?id='+encodeURIComponent(j.id),'DELETE'); await paintAutomations(); });
    row.appendChild(acts);
    body.appendChild(row);
  }

  const sep=document.createElement('div');
  sep.style.cssText='border-top:.5px solid var(--border);margin:12px 0 10px';
  body.appendChild(sep);

  const form=document.createElement('div');
  form.innerHTML='<div style="font-size:12px;font-weight:600;margin-bottom:6px">New automation</div>'
    +'<input id="auto-name" placeholder="name, e.g. morning repo check" style="width:100%;margin-bottom:6px;background:rgba(255,255,255,.04);border:.5px solid var(--border-strong);border-radius:8px;padding:6px 9px;color:var(--text);font-size:12px">'
    +'<textarea id="auto-prompt" rows="2" placeholder="prompt the agent runs, e.g. check git status and tell me if anything needs attention" style="width:100%;margin-bottom:6px;background:rgba(255,255,255,.04);border:.5px solid var(--border-strong);border-radius:8px;padding:6px 9px;color:var(--text);font-size:12px;resize:vertical"></textarea>'
    +'<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">'
      +'<select id="auto-type" style="background:rgba(255,255,255,.04);border:.5px solid var(--border-strong);border-radius:8px;padding:5px 8px;color:var(--text);font-size:12px"><option value="interval">every N minutes</option><option value="daily">daily at</option></select>'
      +'<input id="auto-every" type="number" min="1" value="60" style="width:80px;background:rgba(255,255,255,.04);border:.5px solid var(--border-strong);border-radius:8px;padding:5px 8px;color:var(--text);font-size:12px">'
      +'<input id="auto-at" type="time" value="09:00" style="display:none;background:rgba(255,255,255,.04);border:.5px solid var(--border-strong);border-radius:8px;padding:5px 8px;color:var(--text);font-size:12px">'
      +'<button class="btn primary" id="auto-create">Create</button>'
    +'</div>';
  body.appendChild(form);
  form.querySelector('#auto-type').onchange=e=>{
    const daily=e.target.value==='daily';
    form.querySelector('#auto-every').style.display=daily?'none':'';
    form.querySelector('#auto-at').style.display=daily?'':'none';
  };
  form.querySelector('#auto-create').onclick=async()=>{
    const name=form.querySelector('#auto-name').value.trim()||'Automation';
    const prompt=form.querySelector('#auto-prompt').value.trim();
    if(!prompt){ toast('a prompt is required'); return; }
    const type=form.querySelector('#auto-type').value;
    const schedule=type==='daily'
      ? {type:'daily',at:form.querySelector('#auto-at').value||'09:00'}
      : {type:'interval',minutes:Number(form.querySelector('#auto-every').value)||60};
    const rr=await api('/automations','POST',{name,prompt,schedule});
    if(rr&&rr.data&&rr.data.success){ toast('automation created'); await paintAutomations(); }
    else toast(rr&&rr.data&&rr.data.error?rr.data.error:'could not create');
  };
}

/** Speak the final answer once a turn lands, if the operator asked for it. */
function speakFinal(text){
  const prefs=uiPrefs();
  if(!prefs.speakReplies) return;
  const clean=String(text||'').replace(/GROUNDING AUDIT[\s\S]*$/i,'').replace(/\[E\d+\]/g,'').replace(/[*_#>\`]/g,'').trim();
  if(!clean) return;
  api('/voice/speak','POST',{text:clean.slice(0,1200),voice:prefs.voiceName||undefined,rate:Number(prefs.voiceRate)||0,play:true}).catch(()=>{});
}

$('nav-automations').onclick=()=>openAutomations();

$('btn-compact').onclick=()=>handleSlash('/compact');
$('btn-review').onclick=()=>openOverview('review');
document.querySelectorAll('.ovrow').forEach(r=>r.onclick=()=>openOverview(r.dataset.ov));
document.addEventListener('click',e=>{
  if(e.target.closest('.pop'))return;
  if(e.target.closest('[data-menu],#btn-model,#btn-perms,#btn-context,#btn-checkout,#btn-branch')||e.target.closest('#project-list .conv'))return;
  closePops();
});
document.addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  if(e.ctrlKey&&k==='b'){e.preventDefault();toggleSidebar();}
  if(e.ctrlKey&&e.altKey&&k==='o'){e.preventDefault();toggleOverview();}
  if(e.ctrlKey&&k===','){e.preventDefault();openDrawer();}
  if(e.ctrlKey&&k==='k'){e.preventDefault();openDrawer();}
  if(e.ctrlKey&&k==='/'){e.preventDefault();openModelPop($('btn-model'));}
  if(e.ctrlKey&&k==='n'){e.preventDefault();newConversation();}
  if(e.ctrlKey&&(e.key==='?'||(e.shiftKey&&k==='/'))){e.preventDefault();openSettingsAt('keybinds');}
  if(e.key==='Escape'){ if(busy) stopTurn(); closePops();closeDrawer();closeOverview();}
});

/* ── SETTINGS v2: category tree + subpages ─────────────── */
const NAV2=[
  {id:'model',label:'Model',icon:'◈',groups:[
    {id:'main',label:'Main model'},
    {id:'fallback',label:'Fallback models'},
    {id:'auxiliary',label:'Auxiliary models'},
    {id:'moa',label:'Mixture of Agents'}
  ]},
  {id:'chat',label:'Chat',icon:'▭'},
  {id:'appearance',label:'Appearance',icon:'◐'},
  {id:'workspace',label:'Workspace',icon:'▣'},
  {id:'safety',label:'Safety',icon:'⛨'},
  {id:'browser',label:'Browser',icon:'◎'},
  {id:'vault',label:'Vault & Secrets',icon:'⚿'},
  {id:'memory',label:'Memory & Context',icon:'◇'},
  {id:'voice',label:'Voice',icon:'◍'},
  {id:'advanced',label:'Advanced',icon:'⚙'},
  {id:'notifications',label:'Notifications',icon:'◔'},
  {id:'billing',label:'Billing',icon:'▤'},
  {id:'providers',label:'Providers',icon:'⌁'},
  {id:'connectors',label:'Connectors',icon:'⇄'},
  {id:'access',label:'Access & Tokens',icon:'⚿'},
  {id:'keybinds',label:'Keyboard Shortcuts',icon:'⌨'},
  {id:'apikeys',label:'Tools & Keys',icon:'⚿'},
  {id:'sessions',label:'Sessions',icon:'▦'},
  {id:'about',label:'About',icon:'ℹ'}
];
let ds={cat:'model',item:'main'};

function buildNav(){
  const nav=$('drawer-nav');nav.innerHTML='';
  for(const cat of NAV2){
    if(cat.groups){
      const wrap=document.createElement('div');
      wrap.innerHTML=`<div class="dgroup-h"><span>${cat.icon} ${esc(cat.label)}</span><span>▾</span></div>`;
      for(const g of cat.groups){
        const it=add(wrap,'div','ditem'+(ds.cat===cat.id&&ds.item===g.id?' active':''),g.label);
        it.setAttribute("role","button"); it.tabIndex=0;
        it.onclick=()=>{ds={cat:cat.id,item:g.id};buildNav();renderPanel();};
      }
      nav.appendChild(wrap);
    }else{
      const it=add(nav,'div','ditem'+(ds.cat===cat.id&&!ds.item?' active':''),`${cat.icon} ${cat.label}`);
      it.setAttribute('role','button'); it.tabIndex=0;
      it.onclick=()=>{ds={cat:cat.id,item:null};buildNav();renderPanel();};
    }
  }
  const foot=document.createElement('div');
  foot.style.cssText='padding:10px 8px 4px;border-top:1px solid var(--border);margin-top:8px;display:flex;flex-direction:column;gap:6px';
  foot.innerHTML=`<button class="btn" id="cfg-export" style="width:100%;text-align:left">↧ Export config</button>
    <button class="btn" id="cfg-import" style="width:100%;text-align:left" disabled title="Not implemented in this build">↥ Import config</button>
    <button class="btn" id="cfg-reset" style="width:100%;text-align:left">⟲ Reset to defaults</button>`;
  nav.appendChild(foot);
  foot.querySelector('#cfg-export').onclick=exportConfig;
  foot.querySelector('#cfg-reset').onclick=resetConfig;
}

function crumb(){
  const cat=NAV2.find(c=>c.id===ds.cat);
  const g=cat?.groups?.find(x=>x.id===ds.item);
  $('drawer-crumb').innerHTML='<span>Settings</span>'+(cat?` <span class="sep">›</span> <span>${esc(cat.label)}</span>`:'')+(g?` <span class="sep">›</span> <b>${esc(g.label)}</b>`:'');
}

function unavailable(title,what){
  return `<h3>${esc(title)}</h3><div class="pd">${esc(what)}</div>
  <div class="card"><div class="card-h">Not available in this build</div>
  <div class="card-b" style="padding:10px 11px;font-family:var(--sans);font-size:12px;color:var(--muted);line-height:1.6">
  The daemon exposes no backend for this panel, so it is shown read-only instead of pretending to save settings. Everything else in this drawer applies live to <code>liber.yaml</code>.
  </div></div>`;
}

async function exportConfig(){
  const {data}=await api('/config/export');
  if(!data.success){toast('export failed');return;}
  const blob=new Blob([data.yaml],{type:'text/yaml'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='liber.yaml';a.click();
  URL.revokeObjectURL(a.href);
  toast('exported liber.yaml (credentials redacted)');
}
async function resetConfig(){
  if(!confirm('Reset every setting in this drawer to the shipped defaults? Model/provider/endpoint are kept.'))return;
  const {status,data}=await api('/config/reset','POST',{});
  if(status===200&&data.success){
    toast('reset '+data.reset.length+' keys to defaults');
    await loadConfig();renderPanel();
  }else toast('reset failed: '+(data.error||status));
}

async function renderPanel(){
  crumb();
  const p=$('drawer-panel');
  const {data:cd}=await api('/config');
  const c=cd?.config||{};
  const e=c.engine||{},g=c.grounding||{},l=c.limits||{},m=c.memory||{},pol=c.policy||{},term=pol.terminal||{};
  const sel=(id,opts,val)=>`<select id="${id}">${opts.map(o=>`<option value="${o[0]}"${o[0]===val?' selected':''}>${o[1]}</option>`).join('')}</select>`;
  const apply=async(payload,label)=>{
    const r=await api('/config','POST',payload);
    if(r.status===200&&r.data.success){toast(label+' saved');await loadConfig();}
    else toast('failed: '+(r.data.error||r.status));
  };
  p.innerHTML='';
  const cat=ds.cat,item=ds.item;

  /* ── MODEL ─────────────────────────────── */
  if(cat==='model'){
    if(item==='main'){
      p.innerHTML=`<h3>Main model</h3><div class="pd">The model that runs every agent turn. Applies immediately and is written back to liber.yaml.</div>
      <div class="tabs" id="mtabs">
        <button class="tab active" data-t="defaults">Defaults</button>
        <button class="tab" data-t="reasoning">Reasoning</button>
        <button class="tab" data-t="max">Max</button>
      </div>
      <div id="t-defaults"></div><div id="t-reasoning" style="display:none"></div><div id="t-max" style="display:none"></div>
      <div class="brow"><button class="btn primary" id="m-apply">Apply</button></div>`;
      p.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
        p.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        ['defaults','reasoning','max'].forEach(k=>{p.querySelector('#t-'+k).style.display=k===t.dataset.t?'':'none';});
      });
      const td=p.querySelector('#t-defaults');
      td.appendChild(f('Provider',sel('m-prov',[['openai','openai (OpenAI-compatible)'],['anthropic','anthropic'],['gemini','gemini'],['ollama','ollama (local)']],e.provider),'Groq / Mistral / DeepSeek / Together / OpenRouter / xAI all run through the openai adapter.'));
      td.appendChild(f('Model ID',`<input type="text" id="m-model" value="${esc(e.model||'')}">`,'Exact id the provider expects.'));
      td.appendChild(f('Endpoint',`<input type="text" id="m-endpoint" value="${esc(e.endpoint||'')}">`,'Base URL; /chat/completions is appended.'));
      td.appendChild(f('Context window override',`<input type="number" id="m-ctx" min="0" step="1000" value="${e.context_window_override??0}">`,'0 = detected window. Shown in turn telemetry.'));
      const tr=p.querySelector('#t-reasoning');
      tr.appendChild(f('Reasoning effort',sel('m-eff',[['auto','auto'],['low','low'],['medium','medium'],['high','high']],e.reasoning_effort||'auto'),'Forwarded to the provider only when not auto.'));
      tr.appendChild(f('Inherit',`<input type="text" value="inherit · main model effort" disabled style="opacity:.6">`,'Single-model build: no separate reasoning model to inherit from.'));
      const tm=p.querySelector('#t-max');
      tm.appendChild(f('Max output tokens',`<input type="number" id="m-maxtok" min="0" step="256" value="${e.max_tokens??4096}">`));
      tm.appendChild(f('Temperature',`<input type="number" id="m-temp" min="0" max="2" step="0.1" value="${e.temperature??0.2}">`,'0 = deterministic; 0.2 is the grounding-friendly default.'));
      tm.appendChild(f('Top-p',`<input type="number" id="m-topp" min="0" max="1" step="0.05" value="${e.top_p??1}">`));
      p.querySelector('#m-apply').onclick=()=>apply({
        'engine.provider':p.querySelector('#m-prov').value,
        'engine.model':p.querySelector('#m-model').value.trim(),
        'engine.endpoint':p.querySelector('#m-endpoint').value.trim(),
        'engine.context_window_override':Number(p.querySelector('#m-ctx').value||0),
        'engine.reasoning_effort':p.querySelector('#m-eff').value,
        'engine.max_tokens':Number(p.querySelector('#m-maxtok').value||4096),
        'engine.temperature':Number(p.querySelector('#m-temp').value||0.2),
        'engine.top_p':Number(p.querySelector('#m-topp').value||1)
      },'main model');
      return;
    }
    if(item==='fallback'){
      const chain = Array.isArray(e.fallback_models) ? e.fallback_models : [];
      p.innerHTML=`<h3>Fallback models</h3>
        <div class="pd">Tried in order when the main model fails — same provider and the same API key, a different model id. One key is enough.</div>
        <div class="f"><label>Chain</label><div class="c"><textarea id="fb-list" rows="5" placeholder="glm-5.3-flash&#10;gpt-oss:120b">${chain.join('\n')}</textarea>
          <div class="hint">One model id per line, best first. Leave empty to disable. Only models the current provider serves.</div></div></div>
        <div class="brow" style="gap:6px;flex-wrap:wrap">
          <button class="btn primary" id="fb-save">Save chain</button>
          <button class="tinybtn" id="fb-clear">Clear</button>
        </div>
        <div class="pmeta" style="padding:8px 0 0">A failed call is retried on the next model; a stream that already emitted text is not replayed, so partial answers are never duplicated.</div>`;
      p.querySelector('#fb-clear').onclick=()=>{p.querySelector('#fb-list').value='';};
      p.querySelector('#fb-save').onclick=async()=>{
        const list=p.querySelector('#fb-list').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,8);
        await apply({'engine.fallback_models':list},'fallback');
      };
      return;
    }
    if(item==='auxiliary'){
      const tasks=[['Vision','image analysis'],['Compression','context compaction'],['Skill search','skill retrieval'],['Session titles','naming'],['Review','/review verifier'],['Curator','memory hygiene']];
      p.innerHTML=`<h3>Auxiliary models</h3><div class="pd">Helper tasks run on the main model by default. Assigning a dedicated model per task needs a second adapter this build does not keep.</div>
        <table class="tbl"><thead><tr><th>Task</th><th>Model</th></tr></thead><tbody>
        ${tasks.map(([n,d])=>`<tr><td>${esc(n)}<div style="color:var(--dim);font-size:11px">${esc(d)}</div></td><td style="color:var(--muted)">inherit · ${esc(e.model||'main')}</td></tr>`).join('')}
        </tbody></table>`;
      return;
    }
    if(item==='moa'){
      p.innerHTML=`<h3>Mixture of Agents</h3><div class="pd">Named presets where an aggregator runs the tool loop and reference models advise.</div>
        <div class="card"><div class="card-h">Disabled in this build</div><div class="card-b" style="padding:10px 11px;font-family:var(--sans);font-size:12px;color:var(--muted);line-height:1.6">
        The engine runs one adapter per turn. A real MoA needs parallel generation and a merge step; enabling the toggle without that would be a fake switch.
        </div></div>
        <div class="brow"><button class="btn" disabled>Add preset</button></div>`;
      return;
    }
  }

  /* ── CHAT ──────────────────────────────── */
  if(cat==='chat'){
    const prefs=uiPrefs();
    p.innerHTML=`<h3>Chat</h3><div class="pd">How turns, tools and reasoning render in the conversation.</div>
      <h3 style="font-size:12px;margin:10px 0 6px">Tool call display</h3>
      <div class="f"><label>Payloads</label><div class="c">${sel('c-tools',[['product','Product — hide raw payloads'],['technical','Technical — show full input/output']],prefs.toolDisplay)}</div></div>
      <div class="f"><label>Collapse thinking by default</label><div class="c"><input type="checkbox" id="c-collapse" ${prefs.collapseThinking?'checked':''}></div></div>
      <div class="f"><label>Hide code diffs</label><div class="c"><input type="checkbox" id="c-hidediff" ${prefs.hideDiffs?'checked':''}><div class="hint">Changed-files rows keep +/- counts without the file list.</div></div></div>
      <div class="f"><label>Hide thread timeline</label><div class="c"><input type="checkbox" id="c-hidetl" ${prefs.hideTimeline?'checked':''}><div class="hint">Turn navigator arrows in the conversation header.</div></div></div>
      <h3 style="font-size:12px;margin:14px 0 6px">Execution</h3>
      <div class="f"><label>Queued messages</label><div class="c">${sel('c-queue',[['queue','Queue — wait for the current turn'],['send','Send immediately']],'queue')}<div class="hint">The daemon serialises turns per agent, so queue is the enforced behaviour.</div></div></div>
      <div class="brow"><button class="btn primary" id="c-save">Save chat display</button></div>`;
    p.querySelector('#c-save').onclick=()=>{
      setUiPrefs({
        toolDisplay:p.querySelector('#c-tools').value,
        collapseThinking:p.querySelector('#c-collapse').checked,
        hideDiffs:p.querySelector('#c-hidediff').checked,
        hideTimeline:p.querySelector('#c-hidetl').checked
      });
      applyUiPrefs();
      toast('chat display saved');
    };
    return;
  }

  /* ── APPEARANCE ────────────────────────── */
  if(cat==='appearance'){
    const prefs=uiPrefs();
    p.innerHTML=`<h3>Appearance</h3><div class="pd">Theme, typography and layout. Stored locally on this machine.</div>
      <div class="dsec">Accent</div>
      <div class="f"><label>Accent color</label><div class="c"><div style="display:flex;gap:8px" id="sws"></div></div></div>
      <div class="dsec">Typography</div>
      <div class="f"><label>UI scale</label><div class="c">${sel('a-scale',[['0.9','90%'],['1','100%'],['1.1','110%'],['1.2','120%']],String(prefs.scale))}</div></div>
      <div class="f"><label>Chat font</label><div class="c"><input type="text" id="a-font" value="${esc(prefs.chatFont||'')}" placeholder="Segoe UI or a CSS font stack"><div class="hint">Blank uses the app font.</div></div></div>
      <div class="dsec">Window &amp; layout</div>
      <div class="f"><label>Session density</label><div class="c">${sel('a-density',[['compact','Compact'],['comfortable','Comfortable'],['detailed','Detailed']],prefs.density)}</div></div>
      <div class="f"><label>Translucency</label><div class="c">${sel('a-trans',[['off','Off'],['clear','Clear'],['glass','Glass']],'off')}<div class="hint">Off in this build — the window is opaque by design.</div></div></div>
      <div class="brow"><button class="btn primary" id="a-save">Save appearance</button></div>`;
    const sw=p.querySelector('#sws');
    for(const col of ACCENTS){
      const s=document.createElement('div');s.className='sw';s.style.background=col;s.dataset.color=col;
      s.onclick=()=>applyAccent(col);sw.appendChild(s);
    }
    applyAccent(localStorage.getItem('liber-accent')||ACCENTS[0]);
    p.querySelector('#a-save').onclick=()=>{
      const scale=Number(p.querySelector('#a-scale').value)||1;
      const font=p.querySelector('#a-font').value.trim();
      const density=p.querySelector('#a-density').value;
      setUiPrefs({scale,chatFont:font,density});
      applyUiPrefs();
      toast('appearance saved');
    };
    return;
  }

  /* ── WORKSPACE ─────────────────────────── */
  if(cat==='workspace'){
    const w=(await api('/workspace')).data?.workspace||{};
    p.innerHTML=`<h3>Workspace</h3><div class="pd">Where the agent reads, writes and runs commands.</div>
      <div class="dsec">Projects &amp; discovery</div>
      <div class="f"><label>Working directory</label><div class="c"><input type="text" value="${esc(w.cwd||'')}" disabled style="opacity:.7"></div></div>
      <div class="f"><label>Branch</label><div class="c"><input type="text" value="${esc(w.branch||'—')}" disabled style="opacity:.7"></div></div>
      <div class="f"><label>Changed files</label><div class="c"><input type="text" value="${(w.totals?.files||0)} files · +${(w.totals?.additions||0)} −${(w.totals?.deletions||0)}" disabled style="opacity:.7"></div></div>
      <div class="dsec">Files &amp; execution</div>
      <div class="f"><label>Write roots</label><div class="c"><textarea id="w-roots">${(pol.write_roots||['.']).join('\n')}</textarea><div class="hint">One per line, relative to the working directory. Writes outside are refused.</div></div></div>
      <div class="f"><label>Terminal mode</label><div class="c">${sel('w-mode',[['read_only','read_only'],['allowlist','allowlist'],['prompt','prompt'],['open','open']],term.mode)}</div></div>
      <div class="brow"><button class="btn primary" id="w-save">Save workspace policy</button></div>`;
    p.querySelector('#w-save').onclick=()=>apply({
      'policy.write_roots':p.querySelector('#w-roots').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
      'policy.terminal.mode':p.querySelector('#w-mode').value
    },'workspace');
    return;
  }

  /* ── SAFETY ────────────────────────────── */
  if(cat==='safety'){
    p.innerHTML=`<h3>Safety</h3><div class="pd">Approvals, the grounding gate and network rules.</div>
      <div class="dsec">Approvals</div>
      <div class="f"><label>Permission preset</label><div class="c">${sel('s-preset',PRESETS.map(x=>[x.id,x.label]),permissions)}<div class="hint">${esc((PRESETS.find(x=>x.id===permissions)||{}).desc||'')}</div></div></div>
      <div class="f"><label>Max repairs</label><div class="c"><input type="number" id="s-rep" min="0" max="5" value="${g.max_repairs??2}"><div class="hint">How many times a blocked answer may be rewritten before delivery.</div></div></div>
      <div class="dsec">Grounding gate</div>
      <div class="f"><label>Gate enabled</label><div class="c"><input type="checkbox" id="s-en" ${g.enabled!==false?'checked':''}></div></div>
      <div class="f"><label>Require read-back</label><div class="c"><input type="checkbox" id="s-rb" ${g.require_readback!==false?'checked':''}></div></div>
      <div class="f"><label>Require citations</label><div class="c"><input type="checkbox" id="s-cite" ${g.require_citations!==false?'checked':''}></div></div>
      <div class="f"><label>Semantic verifier</label><div class="c"><input type="checkbox" id="s-sem" ${g.semantic_verifier!==false?'checked':''}><div class="hint">Fails open (PASS with semantic: error) when the verifier model is unreachable.</div></div></div>
      <div class="dsec">Command sandbox</div>
      <div id="s-box" class="pmeta" style="padding:0 0 8px;font-size:11.5px;color:var(--muted)">probing…</div>
      <div class="f"><label>Execution surface</label><div class="c">
        <select id="s-backend" style="width:100%">
          <option value="docker">docker — container, no network, read-only root</option>
          <option value="powershell">powershell — constrained language mode, same machine</option>
        </select>
        <div class="hint">A container cannot see Windows, your keys or the network. The PowerShell mode stays on this machine and is a much thinner barrier.</div>
      </div></div>
      <div class="f"><label>Container image</label><div class="c"><input type="text" id="s-image" placeholder="alpine:latest"><div class="hint">Only the workspace is mounted, at /work, read-write. The root filesystem is read-only.</div></div></div>
      <div class="f"><label>Allow container network</label><div class="c"><input type="checkbox" id="s-net"><div class="hint">Off by default: a command that needs the internet should say so out loud.</div></div></div>
      <div class="dsec">Privacy &amp; network</div>
      <div class="f"><label>Allowed URLs</label><div class="c"><input type="text" value="fetch_url is unrestricted; no per-URL rules in this build" disabled style="opacity:.7"></div></div>
      <div class="brow"><button class="btn primary" id="s-save">Save safety</button></div>`;
    (async()=>{
      const r=await api('/sandbox').catch(()=>null);
      const d=(r&&r.data)||{};
      const box=p.querySelector('#s-box');
      if(box && d.capabilities){
        const caps=d.capabilities;
        box.innerHTML=''
          +'<div>'+ (d.backend==='docker'&&caps.docker ? '✓ running in a container' : '⚠ running on this machine (no container)') +'</div>'
          +'<div style="margin-top:3px">constrained-language: '+(caps['constrained-language']?'available':'—')+' · docker: '+(caps.docker?('available ('+(d.docker&&d.docker.server||'?')+')'):'unavailable')+' · wsl: '+(caps.wsl?'present':'—')+'</div>'
          +'<div style="margin-top:3px;color:var(--dim)">'+esc(d.note||'')+'</div>';
        if(p.querySelector('#s-backend')) p.querySelector('#s-backend').value=d.backend||'docker';
        if(p.querySelector('#s-image')&&d.docker) p.querySelector('#s-image').value=d.docker.image||'alpine:latest';
        if(p.querySelector('#s-net')&&d.docker) p.querySelector('#s-net').checked=!!d.docker.network;
      }
    })();
    p.querySelector('#s-save').onclick=async()=>{
      const pr=PRESETS.find(x=>x.id===p.querySelector('#s-preset').value);
      await applyPreset(pr);
      await apply({
        'grounding.enabled':p.querySelector('#s-en').checked,
        'grounding.max_repairs':Number(p.querySelector('#s-rep').value),
        'grounding.require_readback':p.querySelector('#s-rb').checked,
        'grounding.require_citations':p.querySelector('#s-cite').checked,
        'grounding.semantic_verifier':p.querySelector('#s-sem').checked,
        'policy.terminal.backend':(p.querySelector('#s-backend')||{}).value||'docker',
        'policy.terminal.image':((p.querySelector('#s-image')||{}).value||'alpine:latest').trim()||'alpine:latest',
        'policy.terminal.allow_network':!!(p.querySelector('#s-net')||{}).checked
      },'safety');
    };
    return;
  }

  /* ── MEMORY ────────────────────────────── */
  if(cat==='memory'){
    p.innerHTML=`<h3>Memory &amp; Context</h3><div class="pd">Standing facts are injected into every turn, so a new session already knows you and this workspace.</div>
      <div class="dsec">What the agent remembers</div>
      <div id="mm-list" class="pmeta" style="padding:0 0 8px">reading…</div>
      <div class="f"><label>New memory</label><div class="c">
        <input type="text" id="mm-key" placeholder="key, e.g. pref.language">
        <input type="text" id="mm-val" placeholder="value, e.g. Indonesian, technical terms in English" style="margin-top:6px">
        <div class="hint">Injected on every turn (budget 1400 chars, newest first). Delete anything you do not want in the prompt.</div>
      </div></div>
      <div class="brow"><button class="btn primary" id="mm-add">Save memory</button></div>
      <div class="dsec">Conversation window</div>
      <div class="f"><label>Window size</label><div class="c"><input type="number" id="mm-win" min="1" max="200" value="${m.window_size??20}"><div class="hint">Messages kept per agent; applied immediately.</div></div></div>
      <div class="f"><label>Persist session</label><div class="c"><input type="checkbox" id="mm-per" ${m.persist!==false?'checked':''}><div class="hint">Writes .liber/session.json with credentials redacted.</div></div></div>
      <div class="dsec">Context &amp; compression</div>
      <div class="brow" style="border-top:none;padding-top:0">
        <button class="btn" id="mm-compact">Compact now</button>
        <button class="btn" id="mm-clear">Clear history</button>
      </div>`;

    const list = p.querySelector('#mm-list');
    const paint = (data) => {
      const entries = (data && data.entries) || [];
      if (!entries.length) { list.innerHTML = '<span style="color:var(--dim)">nothing stored yet — the agent starts each session clean</span>'; return; }
      list.innerHTML = '';
      for (const e of entries) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:.5px solid var(--border)';
        const k = document.createElement('code');
        k.textContent = e.key;
        k.style.cssText = 'color:var(--accent);font-size:11px;min-width:110px';
        const v = document.createElement('span');
        v.textContent = String(e.value).slice(0, 120);
        v.style.cssText = 'flex:1;font-size:12px;color:var(--text)';
        const del = document.createElement('button');
        del.className = 'tinybtn';
        del.textContent = 'forget';
        del.onclick = async () => {
          await api('/memory?key=' + encodeURIComponent(e.key), 'DELETE');
          await loadMemory();
        };
        row.append(k, v, del);
        list.appendChild(row);
      }
      const meta = document.createElement('div');
      meta.style.cssText = 'margin-top:6px;color:var(--dim);font-size:11px';
      meta.textContent = entries.length + ' entries · ' + (data.chars || 0) + ' of 1400 chars injected';
      list.appendChild(meta);
    };
    const loadMemory = async () => {
      const r = await api('/memory').catch(() => null);
      paint(r && r.data);
    };
    loadMemory();

    p.querySelector('#mm-add').onclick = async () => {
      const key = p.querySelector('#mm-key').value.trim();
      const value = p.querySelector('#mm-val').value.trim();
      if (!key) { toast('a key is required'); return; }
      const r = await api('/memory', 'POST', { key, value });
      if (r && r.data && r.data.success) {
        p.querySelector('#mm-key').value = '';
        p.querySelector('#mm-val').value = '';
        toast('remembered · ' + key);
        paint(r.data);
      } else toast('could not save');
    };

    p.querySelector('#mm-compact').onclick=async()=>{
      const r=await api('/compact','POST',{});
      toast(r.status===200?'history compacted':'compact failed');
    };
    p.querySelector('#mm-clear').onclick=async()=>{
      const key=activeSession==='default'?'dev-bot':'dev-bot#'+activeSession;
      const r=await api('/sessions?key='+encodeURIComponent(key),'DELETE');
      toast(r.status===200?'session history cleared':'clear failed');
      streamCache.delete(activeSession);paintSession();
    };
    return;
  }

  /* ── ADVANCED ──────────────────────────── */
  if(cat==='advanced'){
    p.innerHTML=`<h3>Advanced</h3><div class="pd">Limits, tool access and the terminal backend.</div>
      <div class="dsec">Today's usage</div>
      <div id="av-budget" class="pmeta" style="padding:0 0 8px">reading…</div>
      <div class="brow" id="av-budget-actions" style="gap:6px;flex-wrap:wrap">
        <button class="tinybtn" id="av-reset-day">Reset today</button>
        <button class="tinybtn" id="av-plus-1m">+1M tokens</button>
        <button class="tinybtn" id="av-unlimited">No limit</button>
      </div>
      <div class="dsec">Agent limits</div>
      <div class="f"><label>Max loops / turn</label><div class="c"><input type="number" id="av-loops" min="1" max="100" value="${l.circuit_breaker?.max_loops??12}"></div></div>
      <div class="f"><label>Max tokens / day</label><div class="c"><input type="number" id="av-tok" min="0" value="${l.max_tokens_per_day??0}"><div class="hint">0 = unlimited. The guard blocks the turn before the next model call, so a spent day stops mid-task.</div></div></div>
      <div class="f"><label>Max cost / day ($)</label><div class="c"><input type="number" id="av-cost" min="0" step="0.1" value="${l.max_cost_per_day??0}"><div class="hint">Enforced only when price_per_1k is set.</div></div></div>
      <div class="dsec">Output limits</div>
      <div class="f"><label>Max output tokens</label><div class="c"><input type="number" id="av-out" min="0" step="256" value="${e.max_tokens??4096}"></div></div>
      <div class="dsec">Terminal backend</div>
      <div class="f"><label>Mode</label><div class="c">${sel('av-mode',[['read_only','read_only'],['allowlist','allowlist'],['prompt','prompt'],['open','open']],term.mode)}</div></div>
      <div class="f"><label>Allowlist</label><div class="c"><textarea id="av-allow">${(term.allowlist||[]).join('\n')}</textarea><div class="hint">Prefixes that may run in allowlist mode. Read-only inventory commands are always allowed.</div></div></div>
      <div class="f"><label>Denylist</label><div class="c"><textarea id="av-deny">${(term.denylist||[]).join('\n')}</textarea><div class="hint">Always blocked, in every mode.</div></div></div>
      <div class="dsec">Subagents</div>
      <div class="f"><label>Parallel limit</label><div class="c"><input type="text" value="4 (fixed in code)" disabled style="opacity:.7"><div class="hint">task/tasks run read-only children with depth 1.</div></div></div>
      <div class="brow"><button class="btn primary" id="av-save">Save advanced</button></div>`;

    const fmt = n => Number(n||0).toLocaleString('en-US');
    const paintBudget = b => {
      const box = p.querySelector('#av-budget');
      if (!box) return;
      if (!b) { box.innerHTML = 'unavailable'; return; }
      const pct = b.percent_used == null ? 'no limit' : b.percent_used + '% of the day';
      const state = b.allowed
        ? '<span style="color:var(--green)">allowed</span>'
        : '<span style="color:var(--red)">blocked — next turn will be refused</span>';
      box.innerHTML = `<b style="color:var(--text)">${fmt(b.spent_tokens)}</b> tokens · ${b.calls} calls · $${Number(b.spent_usd||0).toFixed(4)}<br>`
        + `Limit ${b.limit_tokens == null ? 'none' : fmt(b.limit_tokens)} (${pct}) · ${state}`
        + (b.remaining_tokens == null ? '' : `<br>Remaining today: <b style="color:var(--text)">${fmt(b.remaining_tokens)}</b>`);
    };
    const loadBudget = async () => {
      const r = await api('/budget').catch(() => null);
      paintBudget(r?.data?.budget);
      return r?.data?.budget;
    };
    loadBudget();

    p.querySelector('#av-reset-day').onclick = async () => {
      const r = await api('/budget', 'POST', { action: 'reset' });
      if (r?.data?.budget) { paintBudget(r.data.budget); toast('budget counter reset for today'); }
      else toast('reset failed');
    };
    p.querySelector('#av-plus-1m').onclick = async () => {
      const cur = await loadBudget();
      const next = Math.max(0, Number(cur?.limit_tokens || 0)) + 1_000_000;
      const r = await api('/budget/limit', 'POST', { tokens: next });
      if (r?.data?.budget) { paintBudget(r.data.budget); p.querySelector('#av-tok').value = next; toast('limit → ' + Number(next).toLocaleString('en-US')); }
      else toast(r?.data?.error || 'could not raise the limit');
    };
    p.querySelector('#av-unlimited').onclick = async () => {
      const r = await api('/budget/limit', 'POST', { tokens: 0 });
      if (r?.data?.budget) { paintBudget(r.data.budget); p.querySelector('#av-tok').value = 0; toast('token limit removed (0 = no limit)'); }
      else toast(r?.data?.error || 'could not clear the limit');
    };

    p.querySelector('#av-save').onclick=()=>apply({
      'limits.circuit_breaker.max_loops':Number(p.querySelector('#av-loops').value),
      'limits.max_tokens_per_day':Number(p.querySelector('#av-tok').value),
      'limits.max_cost_per_day':Number(p.querySelector('#av-cost').value),
      'engine.max_tokens':Number(p.querySelector('#av-out').value),
      'policy.terminal.mode':p.querySelector('#av-mode').value,
      'policy.terminal.allowlist':p.querySelector('#av-allow').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
      'policy.terminal.denylist':p.querySelector('#av-deny').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
    },'advanced');
    return;
  }


  /* ── PROVIDERS ─────────────────────────── */
  if(cat==='providers'){ await renderProviders(p); return; }

  /* ── KEYBINDS ──────────────────────────── */
  if(cat==='keybinds'){
    const groups=[
      ['Navigation', [
        ['Ctrl + N','New conversation'],
        ['Ctrl + K','Open settings (search focus)'],
        ['Ctrl + ,','Open settings'],
        ['Ctrl + B','Toggle sidebar'],
        ['Ctrl + Alt + O','Toggle overview rail'],
        ['Ctrl + ?','This page'],
        ['Esc','Close popover or drawer'],
      ]],
      ['Composer', [
        ['Enter','Send message'],
        ['Shift + Enter','New line'],
        ['Tab','Accept slash suggestion'],
        ['Ctrl + /','Model and reasoning picker'],
        ['@','Mention a file, skill or URL'],
        ['/','Slash actions'],
        ['↑ / ↓','Navigate a popup list'],
      ]],
    ];
    p.innerHTML=`<h3>Keyboard Shortcuts</h3>
      <div class="pd">Every binding below is live in this build. Rebinding needs a shortcut layer the shell does not have yet.</div>
      ${groups.map(([title,rows])=>`
        <div class="dsec">${esc(title)}</div>
        <table class="tbl"><thead><tr><th style="width:38%">Key</th><th>Action</th></tr></thead><tbody>
        ${rows.map(([k,d])=>`<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}
        </tbody></table>`).join('')}`;
    return;
  }

  /* ── TOOLS & KEYS ──────────────────────── */
  if(cat==='apikeys'){
    p.innerHTML=`<h3>Tools &amp; Keys</h3><div class="pd">What the agent may execute, and where keys come from.</div>
      <div class="dsec">Tools</div>
      <table class="tbl"><thead><tr><th>Tool</th><th>State</th></tr></thead><tbody>
      ${[['read_file','on'],['search_files','on'],['write_file','policy-gated'],['patch','policy-gated'],['terminal','policy-gated'],['fetch_url','on'],['web_search','on'],['task / tasks','on (depth 1)'],['memory','on'],['skill','on'],['todo_list','on']]
        .map(([n,s])=>`<tr><td>${esc(n)}</td><td style="color:${s==='on'?'var(--green)':'var(--amber)'}">${esc(s)}</td></tr>`).join('')}
      </tbody></table>
      <div class="dsec">API keys</div>
      <div class="f"><label>OpenAI-compatible</label><div class="c"><input type="text" value="from .env: OPENAI_API_KEY" disabled style="opacity:.7"></div></div>
      <div class="f"><label>Anthropic</label><div class="c"><input type="text" value="from .env: ANTHROPIC_API_KEY" disabled style="opacity:.7"></div></div>
      <div class="f"><label>Google</label><div class="c"><input type="text" value="from .env: GEMINI_API_KEY" disabled style="opacity:.7"></div></div>
      <div class="f"><label>MCP servers</label><div class="c"><input type="text" value="not supported in this build" disabled style="opacity:.7"></div></div>`;
    return;
  }

  /* ── SESSIONS ──────────────────────────── */
  if(cat==='sessions'){
    const se=(await api('/sessions')).data||{};
    const sessions=se.sessions||{};
    p.innerHTML=`<h3>Sessions</h3><div class="pd">Live conversation state and its persisted copy.</div>
      <table class="tbl"><thead><tr><th>Agent</th><th>Messages</th><th>Last</th></tr></thead><tbody>
      ${Object.keys(sessions).length?Object.entries(sessions).map(([id,s])=>`<tr><td>${esc(id)}</td><td>${s.messages}</td><td style="color:var(--dim)">${esc((s.last||'').slice(0,70))}</td></tr>`).join(''):'<tr><td colspan="3">No sessions.</td></tr>'}
      </tbody></table>
      ${se.persisted?`<div class="pd" style="margin-top:10px">Persisted: <span style="font-family:var(--mono)">${esc(se.persisted.file)}</span> (${se.persisted.size_bytes} bytes)</div>`:''}
      <div class="dsec">Archive &amp; retention</div>
      <div class="f"><label>Archive</label><div class="c"><input type="text" value="not implemented — clear or export instead" disabled style="opacity:.7"></div></div>
      <div class="brow"><button class="btn" id="ss-export">Export JSON</button><button class="btn" id="ss-clear">Clear all</button></div>`;
    p.querySelector('#ss-export').onclick=exportSessions;
    p.querySelector('#ss-clear').onclick=async()=>{if(!confirm('Clear all sessions?'))return;await api('/sessions','DELETE');renderPanel();};

    /* Shared links: what exists, when it dies, and how to kill it now. A link is a
       capability URL — read-only, sanitized server-side, revocable at any time. */
    const sh=(await api('/sessions/share')).data||{};
    const links=sh.shares||[];
    const box=document.createElement('div');
    const cell=(x)=>`<tr${x.expired?' style="opacity:.45"':''}>`+
      `<td style="font-family:var(--mono)">${esc(x.key)}</td>`+
      `<td style="color:var(--dim)">${esc(String(x.expires_at||'').slice(0,16).replace('T',' '))}</td>`+
      `<td>${x.views||0}</td>`+
      `<td>${x.revoked?'revoked':`<button class="tinybtn" data-id="${esc(x.id)}">Revoke</button>`}</td></tr>`;
    box.innerHTML='<div class="dsec">Shared links</div>'+(links.length
      ? '<table class="tbl"><thead><tr><th>Session</th><th>Expires</th><th>Views</th><th></th></tr></thead><tbody>'+
        links.map(cell).join('')+'</tbody></table>'
      : '<div class="pd">No links yet. Right-click a session in the sidebar → Share link (read-only).</div>');
    p.appendChild(box);
    box.querySelectorAll('button[data-id]').forEach(b=>b.onclick=async()=>{
      const r=await api('/sessions/share?id='+encodeURIComponent(b.dataset.id),'DELETE');
      toast(r.data&&r.data.success?'link revoked':'revoke failed');
      renderPanel();
    });
    return;
  }

  /* ── ABOUT ─────────────────────────────── */
  if(cat==='about'){
    const who=(await api('/whoami')).data||{};
    p.innerHTML=`<h3>◢ L i B E R ◣</h3><div class="pd">Autonomous agent orchestrator with machine-enforced grounding.</div>
      <table class="tbl"><tbody>
      <tr><td style="width:150px">App</td><td>${esc(who.version||'')} · Neutralino / WebView2</td></tr>
      <tr><td>Daemon</td><td style="font-family:var(--mono)">${esc(who.cwd||'')}</td></tr>
      <tr><td>Node</td><td>${esc(who.version||'')}</td></tr>
      <tr><td>Platform</td><td>${esc(who.platform||'')} / ${esc(who.arch||'')} · ${who.cpus||'?'} cpus</td></tr>
      <tr><td>Model</td><td>${esc(e.model||'')} (${esc(e.provider||'')})</td></tr>
      <tr><td>License</td><td>MIT</td></tr>
      </tbody></table>
      <div class="dsec">Version &amp; updates</div>
      <div class="brow" style="border-top:none;padding-top:0"><button class="btn" id="ab-check">Check daemon</button></div>`;
    p.querySelector('#ab-check').onclick=async()=>{
      const r=await api('/healthz');
      toast(r.status===200?'daemon healthy':'daemon unreachable');
    };
    return;
  }

  /* ── NOTIFICATIONS ─────────────────────── */
  if(cat==='notifications'){
    const prefs=uiPrefs();
    p.innerHTML=`<h3>Notifications</h3>
      <div class="pd">A desktop toast when a turn finishes or needs you — the window only, nothing is sent anywhere.</div>
      <div class="f"><label>Notify when a turn finishes</label><div class="c"><input type="checkbox" id="nt-done" ${prefs.notifyDone!==false?'checked':''}><div class="hint">Skipped while this window is focused.</div></div></div>
      <div class="brow" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="nt-save">Save</button><button class="tinybtn" id="nt-test">Send a test toast</button></div>`;
    p.querySelector('#nt-save').onclick=()=>{
      const next={...uiPrefs(),notifyDone:!!p.querySelector('#nt-done').checked};
      setUiPrefs({notifyDone:next.notifyDone});
      toast('notifications '+(next.notifyDone?'on':'off'));
    };
    p.querySelector('#nt-test').onclick=async()=>{
      try{
        if(typeof window.Neutralino==='undefined'||!Neutralino.os?.showNotification){ toast('desktop notifications are not available here'); return; }
        await Neutralino.os.showNotification('LiBER','Test toast — this is how a finished turn will look.');
        toast('test toast sent');
      }catch(err){ toast('toast failed: '+err.message); }
    };
    return;
  }

  if(cat==='access'){
    p.innerHTML=`<h3>Access &amp; Tokens</h3>
      <div class="pd">Every client gets its own token, scopes and rate limit, so a phone can read while the desktop app still does everything — and revoking one does not break the others. Tokens are stored as SHA-256, never in the clear.</div>
      <div class="dsec">Clients</div>
      <div id="ac-list" class="pmeta" style="padding:0 0 10px">reading…</div>
      <div class="dsec">New client</div>
      <div class="f"><label>Label</label><div class="c"><input type="text" id="ac-label" placeholder="e.g. phone via tailscale"></div></div>
      <div class="f"><label>Scopes</label><div class="c" style="display:flex;gap:12px;flex-wrap:wrap">
        <label style="display:flex;gap:5px;align-items:center;font-size:12px"><input type="checkbox" class="ac-scope" value="read" checked>read</label>
        <label style="display:flex;gap:5px;align-items:center;font-size:12px"><input type="checkbox" class="ac-scope" value="chat" checked>chat</label>
        <label style="display:flex;gap:5px;align-items:center;font-size:12px"><input type="checkbox" class="ac-scope" value="tools">tools</label>
        <label style="display:flex;gap:5px;align-items:center;font-size:12px"><input type="checkbox" class="ac-scope" value="admin">admin</label>
      </div></div>
      <div class="f"><label>Requests per minute</label><div class="c"><input type="number" id="ac-rate" value="240" min="1" max="10000"></div></div>
      <div class="brow" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="ac-create">Create client</button><button class="tinybtn" id="ac-audit">Show audit log</button></div>
      <div id="ac-token" style="display:none;margin-top:10px;padding:9px 10px;border:.5px solid var(--border-strong);border-radius:9px;background:rgba(255,255,255,.03)">
        <div style="font-size:11px;color:var(--amber);margin-bottom:5px">This token is shown once. Copy it now.</div>
        <div id="ac-token-val" style="font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;user-select:all"></div>
        <div class="brow" style="margin-top:6px"><button class="tinybtn" id="ac-copy">Copy</button></div>
      </div>
      <div id="ac-audit-box" class="hint" style="display:none;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:10.5px;line-height:15px;margin-top:8px;color:var(--dim);max-height:260px;overflow:auto"></div>`;
    const listEl=p.querySelector('#ac-list');
    const paint=async()=>{
      listEl.textContent='reading…';
      const r=await api('/clients').catch(()=>null);
      const rows=(r&&r.data&&r.data.clients)||[];
      listEl.innerHTML='';
      for(const c of rows){
        const box=document.createElement('div');
        box.style.cssText='border:.5px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:8px';
        box.innerHTML='<div style="display:flex;gap:8px;align-items:baseline">'
          +'<b style="font-size:12.5px">'+esc(c.label)+'</b>'
          +'<span style="font-size:10.5px;color:var(--dim);font-family:ui-monospace,monospace">'+esc(c.id)+'</span>'
          +'<span style="flex:1"></span>'
          +'<span style="font-size:10.5px;color:var(--dim)">'+c.perMin+'/min</span></div>'
          +'<div style="font-size:11px;color:var(--muted);margin:3px 0 2px">scopes: '+esc(c.scopes.join(', '))+'</div>'
          +'<div style="font-size:10.5px;color:var(--dim)">calls: '+c.calls+' · last used: '+esc(c.lastUsedAt?c.lastUsedAt.slice(0,16).replace('T',' '):'never')+'</div>';
        const acts=document.createElement('div');
        acts.style.cssText='display:flex;gap:6px;margin-top:7px';
        const rot=document.createElement('button');
        rot.className='tinybtn'; rot.textContent='Rotate token';
        rot.onclick=async()=>{
          const rr=await api('/clients/rotate','POST',{id:c.id});
          if(rr&&rr.data&&rr.data.success) showToken(rr.data.token);
          else toast((rr&&rr.data&&rr.data.error)||'rotate failed');
          await paint();
        };
        acts.appendChild(rot);
        if(c.id!=='local'){
          const rev=document.createElement('button');
          rev.className='tinybtn'; rev.textContent='Revoke'; rev.style.color='var(--red)';
          rev.onclick=async()=>{ await api('/clients?id='+encodeURIComponent(c.id),'DELETE'); toast('revoked '+c.label); await paint(); };
          acts.appendChild(rev);
        }
        box.appendChild(acts);
        listEl.appendChild(box);
      }
    };
    const showToken=(token)=>{
      p.querySelector('#ac-token').style.display='';
      p.querySelector('#ac-token-val').textContent=token;
    };
    p.querySelector('#ac-copy').onclick=async()=>{
      const t=p.querySelector('#ac-token-val').textContent;
      try{ await navigator.clipboard.writeText(t); toast('token copied'); }catch{ toast('select the token and copy manually'); }
    };
    p.querySelector('#ac-create').onclick=async()=>{
      const label=p.querySelector('#ac-label').value.trim()||'client';
      const scopes=[...p.querySelectorAll('.ac-scope')].filter(x=>x.checked).map(x=>x.value);
      if(!scopes.length){ toast('pick at least one scope'); return; }
      const rr=await api('/clients','POST',{label,scopes,perMin:Number(p.querySelector('#ac-rate').value)||240});
      if(rr&&rr.data&&rr.data.success){ showToken(rr.data.token); p.querySelector('#ac-label').value=''; await paint(); }
      else toast((rr&&rr.data&&rr.data.error)||'could not create');
    };
    p.querySelector('#ac-audit').onclick=async()=>{
      const box=p.querySelector('#ac-audit-box');
      if(box.style.display!=='none'){ box.style.display='none'; return; }
      const r=await api('/clients/audit?tail=25').catch(()=>null);
      const rows=(r&&r.data&&r.data.entries)||[];
      box.textContent=rows.map(e=>e.ts.slice(11,19)+'  '+(e.client||'unknown')+'  '+e.method+' '+e.endpoint+'  '+(e.status||e.decision)+'  '+(e.reason||e.scope||'')).join('\n')||'no entries yet';
      box.style.display='';
    };
    await paint();
    return;
  }

  if(cat==='connectors'){
    p.innerHTML=`<h3>Connectors</h3>
      <div class="pd">A connector turns an HTTP API into a tool the agent can call — no browser, no copy-paste. Headers written as <code>vault:name</code> are resolved at call time, so tokens stay in the vault.</div>
      <div id="cn-list" class="pmeta" style="padding:0 0 10px">reading…</div>
      <div class="dsec">Declaration file</div>
      <div class="pmeta" id="cn-file" style="padding:0 0 8px;font-size:11px"></div>
      <div class="brow" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="cn-reload">Reload connectors</button><button class="tinybtn" id="cn-example">Show an example</button></div>
      <div id="cn-ex" class="hint" style="display:none;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:10.5px;line-height:15px;margin-top:8px;color:var(--dim)"></div>`;
    const listEl=p.querySelector('#cn-list');
    const paint=async()=>{
      listEl.textContent='reading…';
      const r=await api('/connectors').catch(()=>null);
      const d=(r&&r.data)||{};
      p.querySelector('#cn-file').textContent=d.file||'';
      listEl.innerHTML='';
      const rows=d.connectors||[];
      if(!rows.length){ listEl.textContent='No connectors declared. Create the file below and reload.'; }
      for(const c of rows){
        const box=document.createElement('div');
        box.style.cssText='border:.5px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:8px';
        box.innerHTML='<div style="font-size:12.5px;font-weight:600">'+esc(c.label)+' <span style="font-weight:400;color:var(--dim);font-size:11px">'+esc(c.id)+'</span></div>'
          +'<div style="font-size:11px;color:var(--muted);margin:2px 0 6px">'+esc(c.baseUrl)+'</div>';
        for(const a of c.actions){
          const row=document.createElement('div');
          row.style.cssText='font-size:11px;color:var(--dim);padding:1px 0';
          row.textContent='• '+a.name+'  '+a.method+' '+a.path+(a.description?' — '+a.description:'');
          box.appendChild(row);
        }
        listEl.appendChild(box);
      }
      if((d.problems||[]).length){
        const warn=document.createElement('div');
        warn.style.cssText='font-size:11px;color:var(--amber);padding:6px 0';
        warn.textContent='Skipped: '+d.problems.join(' · ');
        listEl.appendChild(warn);
      }
    };
    p.querySelector('#cn-reload').onclick=async()=>{ const r=await api('/connectors/reload','POST',{}); toast('installed '+(((r&&r.data&&r.data.installed)||[]).join(', ')||'none')); await paint(); };
    p.querySelector('#cn-ex').onclick=()=>{
      const ex=p.querySelector('#cn-ex');
      if(ex.style.display!=='none'){ ex.style.display='none'; return; }
      ex.textContent=JSON.stringify({connectors:[{id:'myapi',label:'My API',baseUrl:'https://api.example.com',headers:{authorization:'Bearer vault:myapi.token'},actions:[{name:'list',method:'GET',path:'/items/{kind}',description:'list items'}]}]},null,2);
      ex.style.display='';
    };
    await paint();
    return;
  }

  if(cat==='voice'){
    const prefs=uiPrefs();
    p.innerHTML=`<h3>Voice</h3>
      <div class="pd">Replies can be read aloud with the voices already installed in Windows. There is no microphone pipeline: speech-to-text is not wired, so you still type.</div>
      <div class="dsec">Read replies aloud</div>
      <div class="f"><label>Speak every finished reply</label><div class="c">
        <input type="checkbox" id="vc-auto" ${prefs.speakReplies?'checked':''}>
        <div class="hint">Only the final answer is spoken — not tool output, not the audit footer.</div>
      </div></div>
      <div class="f"><label>Voice</label><div class="c">
        <select id="vc-voice" style="width:100%"><option value="">loading…</option></select>
        <div class="hint" id="vc-hint"></div>
      </div></div>
      <div class="f"><label>Rate</label><div class="c">
        <input type="range" id="vc-rate" min="-5" max="5" step="1" value="${Number(prefs.voiceRate)||0}" style="width:100%">
        <div class="hint" id="vc-rate-v">${Number(prefs.voiceRate)||0}</div>
      </div></div>
      <div class="brow" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="vc-test">Say a test line</button><button class="tinybtn" id="vc-save">Save</button></div>`;
    const sel=p.querySelector('#vc-voice');
    api('/voice').then(r=>{
      const d=(r&&r.data)||{};
      const list=d.voices||[];
      sel.innerHTML='';
      if(!list.length){ sel.innerHTML='<option value="">no voices installed</option>'; p.querySelector('#vc-hint').textContent=d.available?'No SAPI voices found.':'Speech is Windows-only in this build.'; return; }
      for(const v of list){
        const o=document.createElement('option');
        o.value=v.name; o.textContent=v.name+' · '+v.locale;
        if(prefs.voiceName===v.name) o.selected=true;
        sel.appendChild(o);
      }
      p.querySelector('#vc-hint').textContent=list.length+' installed · audio is written to '+d.audioDir;
    }).catch(()=>{ sel.innerHTML='<option value="">unavailable</option>'; });
    p.querySelector('#vc-rate').oninput=e=>{ p.querySelector('#vc-rate-v').textContent=e.target.value; };
    p.querySelector('#vc-save').onclick=()=>{
      setUiPrefs({speakReplies:!!p.querySelector('#vc-auto').checked,voiceName:sel.value,voiceRate:Number(p.querySelector('#vc-rate').value)});
      toast('voice settings saved');
    };
    p.querySelector('#vc-test').onclick=async()=>{
      const r=await api('/voice/speak','POST',{text:'Liber voice check. One, two, three.',voice:sel.value||undefined,rate:Number(p.querySelector('#vc-rate').value)});
      if(r&&r.data&&r.data.success) toast('spoke · '+Math.round((r.data.bytes||0)/1024)+' KB wav');
      else toast((r&&r.data&&r.data.error)||'speech failed');
    };
    return;
  }

  if(cat==='vault'){
    p.innerHTML=`<h3>Vault &amp; Secrets</h3>
      <div class="pd">API keys and tokens, encrypted at rest with AES-256-GCM. The key file sits beside the vault, so this protects a leaked file, a synced folder or a backup — not someone who already reads your whole profile.</div>
      <div class="dsec">Stored secrets</div>
      <div id="vt-list" class="pmeta" style="padding:0 0 10px">reading…</div>
      <div class="f"><label>Add or replace</label><div class="c">
        <input type="text" id="vt-name" placeholder="name, e.g. github.token" autocomplete="off">
        <input type="password" id="vt-value" placeholder="value — stored encrypted, never shown again" autocomplete="new-password" style="margin-top:6px">
        <div class="hint">Listing shows only the last four characters. The agent can list, add and delete; reading a value back into a prompt is disabled by default.</div>
      </div></div>
      <div class="brow" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="vt-save">Save secret</button><button class="tinybtn" id="vt-migrate">Encrypt existing provider keys</button></div>`;
    const list=()=>p.querySelector('#vt-list');
    const paint=async()=>{
      list().textContent='reading…';
      const r=await api('/vault').catch(()=>null);
      const rows=(r&&r.data&&r.data.entries)||[];
      list().innerHTML='';
      if(!rows.length){ list().textContent='No secrets stored yet.'; return; }
      for(const row of rows){
        const line=document.createElement('div');
        line.style.cssText='display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:.5px solid var(--border)';
        line.innerHTML='<span style="font-size:12px">'+esc(row.name)+'</span>'
          +'<span style="font-size:11px;color:var(--dim)">'+esc(row.hint||'')+'</span>'
          +'<span style="flex:1"></span>'
          +'<span style="font-size:10.5px;color:var(--dim)">'+esc((row.updatedAt||'').slice(0,10))+'</span>';
        const del=document.createElement('button');
        del.className='tinybtn'; del.textContent='Forget';
        del.onclick=async()=>{ await api('/vault?name='+encodeURIComponent(row.name),'DELETE'); await paint(); toast('removed '+row.name); };
        line.appendChild(del);
        list().appendChild(line);
      }
    };
    p.querySelector('#vt-save').onclick=async()=>{
      const name=p.querySelector('#vt-name').value.trim();
      const value=p.querySelector('#vt-value').value;
      if(!name||!value){ toast('name and value are required'); return; }
      const r=await api('/vault','POST',{name,value});
      if(r&&r.data&&r.data.success){ p.querySelector('#vt-name').value=''; p.querySelector('#vt-value').value=''; toast('saved '+name); await paint(); }
      else toast((r&&r.data&&r.data.error)||'could not save');
    };
    p.querySelector('#vt-migrate').onclick=async()=>{
      const r=await api('/vault/migrate','POST',{});
      const moved=(r&&r.data&&r.data.moved)||[];
      toast(moved.length?('encrypted '+moved.length+' key(s)'):'nothing to encrypt');
      await paint();
    };
    await paint();
    return;
  }

  /* ── HONEST STUBS ──────────────────────── */
  const STUBS={
    browser:['Browser','The agent drives a real headless Chromium (open, click, type, extract, screenshot) — but there is no in-app browser pane you can watch, and no browser subagent.'],
    voice:['Voice','No speech-to-text or text-to-speech pipeline is wired into LiBER.'],

    billing:['Billing','LiBER runs on your own API keys. There is no metering, credit balance or plan — limits are enforced locally in the Advanced page.'],
  };
  if(STUBS[cat]){ p.innerHTML=unavailable(STUBS[cat][0],STUBS[cat][1]); return; }

  p.innerHTML=unavailable('Settings','Unknown page.');
}

/* UI preferences (local, not daemon config) */
function uiPrefs(){
  let raw={};
  try{raw=JSON.parse(localStorage.getItem('liber-ui')||'{}');}catch{}
  return {toolDisplay:'product',collapseThinking:false,hideDiffs:false,hideTimeline:false,scale:1,chatFont:'',density:'comfortable',notifyDone:true,...raw};
}
function setUiPrefs(patch){
  const next={...uiPrefs(),...patch};
  try{localStorage.setItem('liber-ui',JSON.stringify(next));}catch{}
  return next;
}
function applyUiPrefs(){
  const p=uiPrefs();
  document.documentElement.style.fontSize=(14*p.scale)+'px';
  if(p.chatFont){document.body.style.fontFamily=p.chatFont;}
  else{document.body.style.fontFamily='';}
  document.body.dataset.density=p.density;
  document.body.dataset.tools=p.toolDisplay;
  document.querySelectorAll('#nav-prev,#nav-next').forEach(el=>{el.style.display=p.hideTimeline?'none':'';});
}

/* ── PROVIDERS: keys, subscriptions, custom endpoints, local runtimes ── */
let provTab='keys', provFilter='', provData=null;

async function renderProviders(host){
  const {data}=await api('/providers');
  provData=data||{};
  const rows=provData.providers||[];
  const imports=provData.imports||[];
  const customs=provData.custom||[];

  host.innerHTML=`
    <h3>Providers</h3>
    <div class="pd">Set a key for any provider, import a subscription token from a CLI you already signed into, or point LiBER at your own endpoint. Keys are stored in <span style="font-family:var(--mono)">.liber/credentials.json</span> (mode 0600) and never sent back to this window.</div>
    <div class="tabs" id="ptabs">
      <button class="tab ${provTab==='keys'?'active':''}" data-t="keys">API keys</button>
      <button class="tab ${provTab==='accounts'?'active':''}" data-t="accounts">Accounts</button>
      <button class="tab ${provTab==='custom'?'active':''}" data-t="custom">Custom endpoints</button>
      <button class="tab ${provTab==='local'?'active':''}" data-t="local">Local models</button>
    </div>
    <div class="f"><label>Search</label><div class="c"><input type="text" id="p-search" placeholder="provider, endpoint or env var" value="${esc(provFilter)}"></div></div>
    <div id="p-body"></div>`;

  host.querySelectorAll('#ptabs .tab').forEach(t=>t.onclick=()=>{provTab=t.dataset.t;renderProviders(host);});
  const search=host.querySelector('#p-search');
  search.oninput=()=>{provFilter=search.value;drawProviderBody(host);};

  drawProviderBody(host,rows,imports,customs);

  async function drawProviderBody(h, rws, imps, cst){
    rws=rws||provData.providers||[]; imps=imps||provData.imports||[]; cst=cst||provData.custom||[];
    const body=h.querySelector('#p-body');
    const q=provFilter.trim().toLowerCase();
    const match=p=>!q||[p.id,p.label,p.base,p.env,p.adapter].join(' ').toLowerCase().includes(q);

    if(provTab==='keys'){
      const list=rws.filter(p=>p.kind==='api'&&match(p));
      body.innerHTML=`<div class="pd" style="margin:6px 0 8px">${list.filter(p=>p.configured).length} of ${list.length} configured. Saved keys take precedence over <span style="font-family:var(--mono)">.env</span>.</div>
        <div id="p-rows"></div>`;
      const wrap=body.querySelector('#p-rows');
      for(const p of list) wrap.appendChild(providerRow(p));
      return;
    }

    if(provTab==='accounts'){
      body.innerHTML=`<div class="pd" style="margin:6px 0 10px">Merlin-style "sign in with a subscription" without copying secrets out of another app: LiBER imports the token the vendor's own CLI already stored, and can run an OAuth device flow for any client id you own.</div>
        <div class="dsec">Import from an installed CLI</div><div id="p-imports"></div>
        <div class="dsec">Paste a token</div>
        <div class="f"><label>Provider</label><div class="c"><select id="ac-prov">${rws.filter(p=>p.kind==='api').map(p=>`<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div></div>
        <div class="f"><label>Access token</label><div class="c"><input type="password" id="ac-token" placeholder="sk-… / oauth access token"><div class="hint">Stored like a key, shown only as a last-4 hint afterwards.</div></div></div>
        <div class="brow"><button class="btn primary" id="ac-save">Store token</button></div>
        <div class="dsec">OAuth device flow (your own client)</div>
        <div class="pd" style="margin:0 0 8px">Needs a client id and the provider's device/token endpoints. LiBER never ships someone else's client id.</div>
        <div class="f"><label>Provider id</label><div class="c"><input type="text" id="df-prov" value="openrouter"></div></div>
        <div class="f"><label>Client ID</label><div class="c"><input type="text" id="df-client" placeholder="your app client id"></div></div>
        <div class="f"><label>Device code URL</label><div class="c"><input type="text" id="df-device" placeholder="https://provider/oauth/device/code"></div></div>
        <div class="f"><label>Token URL</label><div class="c"><input type="text" id="df-token" placeholder="https://provider/oauth/token"></div></div>
        <div class="f"><label>Scope</label><div class="c"><input type="text" id="df-scope" value="openid offline_access"></div></div>
        <div class="brow"><button class="btn" id="df-start">Start sign-in</button><button class="btn" id="df-poll" disabled>I approved it — finish</button></div>
        <div id="df-out"></div>`;

      const imp=body.querySelector('#p-imports');
      if(!imps.length) imp.innerHTML='<div class="act">No import sources.</div>';
      for(const i of imps){
        const row=document.createElement('div');
        row.className='card';
        row.innerHTML=`<div class="card-h"><b>${esc(i.label)}</b>
          <span style="color:${i.available?'var(--green)':'var(--dim)'};font-size:11px">${i.available?'found on this machine':'not found'}</span>
          <span class="grow" style="flex:1"></span>
          <button class="btn" ${i.available?'':'disabled'}>Import</button></div>
          <div class="card-b" style="padding:8px 11px;font-family:var(--sans);font-size:11.5px;color:var(--muted)">
          source: <span style="font-family:var(--mono)">${esc(importSourceHint(i.id))}</span>${i.updated_at?` · updated ${esc(i.updated_at.slice(0,16).replace('T',' '))}`:''} → stored as <span style="font-family:var(--mono)">${esc(i.provider)}</span></div>`;
        row.querySelector('button').onclick=async()=>{
          const r=await api('/providers/import','POST',{id:i.id});
          if(r.status===200&&r.data.success){
            toast(`imported ${r.data.via} → ${r.data.imported} (${r.data.hint})`);
            await renderProviders(host);
          } else toast('import failed: '+(r.data.error||r.status));
        };
        imp.appendChild(row);
      }

      body.querySelector('#ac-save').onclick=async()=>{
        const r=await api('/providers/key','POST',{id:body.querySelector('#ac-prov').value,key:body.querySelector('#ac-token').value});
        if(r.status===200&&r.data.success){toast('token stored for '+r.data.id+' ('+r.data.hint+')');await renderProviders(host);}
        else toast('failed: '+(r.data.error||r.status));
      };

      let pollTimer=null;
      body.querySelector('#df-start').onclick=async()=>{
        const payload={
          provider:body.querySelector('#df-prov').value.trim(),
          client_id:body.querySelector('#df-client').value.trim(),
          device_code_url:body.querySelector('#df-device').value.trim(),
          token_url:body.querySelector('#df-token').value.trim(),
          scope:body.querySelector('#df-scope').value.trim()
        };
        const out=body.querySelector('#df-out');
        const r=await api('/providers/oauth/start','POST',payload);
        if(r.status!==200||!r.data.success){out.innerHTML=`<div class="act bad">${esc(r.data.error||('HTTP '+r.status))}</div>`;return;}
        const d=r.data;
        out.innerHTML=`<div class="card"><div class="card-h">Open this and enter the code</div>
          <div class="card-b" style="padding:10px 11px;font-family:var(--mono);font-size:12px;color:var(--text)">
          ${d.verification_uri?`<div>${esc(d.verification_uri)}</div>`:''}
          ${d.verification_uri_complete?`<div style="color:var(--dim)">${esc(d.verification_uri_complete)}</div>`:''}
          <div style="font-size:18px;letter-spacing:.18em;margin-top:6px;color:var(--accent)">${esc(d.user_code||'')}</div>
          <div style="color:var(--dim);margin-top:6px">poll every ${d.interval}s · expires in ${d.expires_in}s</div></div></div>`;
        const poll=body.querySelector('#df-poll');
        poll.disabled=false;
        poll.onclick=async()=>{
          const pr=await api('/providers/oauth/poll','POST',{provider:payload.provider});
          if(pr.data.success){toast('signed in → '+payload.provider);clearInterval(pollTimer);await renderProviders(host);}
          else toast(pr.data.pending?'still waiting for approval':('failed: '+(pr.data.error||'')));
        };
        clearInterval(pollTimer);
        pollTimer=setInterval(async()=>{
          const pr=await api('/providers/oauth/poll','POST',{provider:payload.provider});
          if(pr.data.success){clearInterval(pollTimer);toast('signed in → '+payload.provider);await renderProviders(host);}
          else if(!pr.data.pending){clearInterval(pollTimer);poll.disabled=true;out.insertAdjacentHTML('beforeend',`<div class="act bad">${esc(pr.data.error||'stopped')}</div>`);}
        },Math.max(3,(d.interval||5))*1000);
      };
      return;
    }

    if(provTab==='custom'){
      body.innerHTML=`<div class="pd" style="margin:6px 0 10px">Any OpenAI-compatible, Anthropic, Gemini or Ollama endpoint: Azure, Cloudflare, a self-hosted gateway, a tunnel.</div>
        <div class="f"><label>Label</label><div class="c"><input type="text" id="cu-label" placeholder="My gateway"></div></div>
        <div class="f"><label>Base URL</label><div class="c"><input type="text" id="cu-base" placeholder="https://host/v1"></div></div>
        <div class="f"><label>Adapter</label><div class="c"><select id="cu-adapter"><option value="openai">openai-compatible</option><option value="anthropic">anthropic</option><option value="gemini">gemini</option><option value="ollama">ollama</option></select></div></div>
        <div class="f"><label>API key</label><div class="c"><input type="password" id="cu-key" placeholder="optional for local gateways"></div></div>
        <div class="brow"><button class="btn primary" id="cu-add">Add endpoint</button></div>
        <div class="dsec">Saved endpoints</div><div id="cu-list"></div>`;
      const list=body.querySelector('#cu-list');
      if(!cst.length) list.innerHTML='<div class="act">No custom endpoints yet.</div>';
      for(const cu of cst){
        const row=document.createElement('div');
        row.className='card';
        row.innerHTML=`<div class="card-h"><b>${esc(cu.label)}</b><span style="font-family:var(--mono);font-size:11px;color:var(--dim)">${esc(cu.base)}</span>
          <span class="grow" style="flex:1"></span><button class="btn" data-a="test">Test</button><button class="btn" data-a="use">Use</button><button class="btn" data-a="del">Remove</button></div>`;
        row.querySelector('[data-a="test"]').onclick=()=>testProvider(cu.id);
        row.querySelector('[data-a="use"]').onclick=()=>useProvider(cu.adapter,cu.base);
        row.querySelector('[data-a="del"]').onclick=async()=>{await api('/providers/clear','POST',{id:cu.id});await renderProviders(host);};
        list.appendChild(row);
      }
      body.querySelector('#cu-add').onclick=async()=>{
        const r=await api('/providers/custom','POST',{
          label:body.querySelector('#cu-label').value.trim(),
          base:body.querySelector('#cu-base').value.trim(),
          adapter:body.querySelector('#cu-adapter').value,
          api_key:body.querySelector('#cu-key').value.trim()||null
        });
        if(r.status===200&&r.data.success){toast('endpoint saved');await renderProviders(host);}
        else toast('failed: '+(r.data.error||r.status));
      };
      return;
    }

    // local
    const locals=rws.filter(p=>p.kind==='local'&&match(p));
    body.innerHTML=`<div class="pd" style="margin:6px 0 10px">Runtimes on this machine. No key needed; the base URL is what matters.</div><div id="l-rows"></div>`;
    const wrap=body.querySelector('#l-rows');
    if(!locals.length) wrap.innerHTML='<div class="act">No local runtimes matched.</div>';
    for(const p of locals) wrap.appendChild(providerRow(p,true));
  }

  function providerRow(p,isLocal){
    const row=document.createElement('div');
    row.className='card';
    row.innerHTML=`<div class="card-h">
        <b>${esc(p.label)}</b>
        <span style="font-family:var(--mono);font-size:10.5px;color:var(--dim)">${esc(p.adapter)}</span>
        <span style="font-size:11px;color:${p.configured?'var(--green)':'var(--dim)'}">${p.configured?('configured · '+esc(p.source||'')+(p.hint?' · '+esc(p.hint):'')):'not configured'}</span>
        <span style="flex:1"></span>
        <button class="btn" data-a="use">Use</button>
      </div>
      <div style="padding:8px 11px;display:flex;flex-direction:column;gap:6px">
        <div style="font-family:var(--mono);font-size:11px;color:var(--dim)">${esc(p.base||'set a base URL in Custom endpoints')}${p.env?' · env '+esc(p.env):''}${p.expires_at?' · expires '+esc(fmtWhen(p.expires_at)):''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <input type="password" placeholder="${isLocal?'optional key':'paste API key'}" style="flex:1;min-width:180px;background:var(--panel2);border:1px solid var(--border-strong);border-radius:6px;padding:6px 9px;color:var(--text);font-family:var(--mono);font-size:12px;outline:none" data-f="key">
          <button class="btn" data-a="save">Save</button>
          <button class="btn" data-a="test">Test</button>
          ${p.configured?'<button class="btn" data-a="clear">Clear</button>':''}
        </div>
        <div data-f="result" style="font-family:var(--mono);font-size:11px;color:var(--dim)"></div>
      </div>`;
    const keyInput=row.querySelector('[data-f="key"]');
    const result=row.querySelector('[data-f="result"]');
    row.querySelector('[data-a="use"]').onclick=()=>useProvider(p.adapter,p.base,p.id);
    row.querySelector('[data-a="test"]').onclick=async()=>{
      const typed=keyInput.value.trim();
      result.textContent=typed?'testing the pasted key…':'testing saved credential…';
      const r=await api('/providers/test','POST',{id:p.id,key:typed||undefined});
      const t=r.data.result||{};
      result.innerHTML=t.ok
        ? `<span style="color:var(--green)">✓ ${t.status} · ${t.model_count} models · ${t.latency_ms}ms</span>${t.sample&&t.sample.length?' · '+esc(t.sample.slice(0,3).join(', ')):''}${t.auth_checked===false?' <span style="color:var(--amber)">· list is public — key not verified</span>':''}`
        : `<span style="color:var(--red)">✖ ${esc(t.error||'failed')}</span>`;
      if(t.ok&&typed&&t.auth_checked!==false){
        const saved=await api('/providers/key','POST',{id:p.id,key:typed});
        if(saved.status===200&&saved.data.success){
          toast(p.label+' verified and saved ('+saved.data.hint+')');
          await renderProviders(host);
        }
      }
    };
    row.querySelector('[data-a="save"]').onclick=async()=>{
      const v=keyInput.value.trim();
      if(!v){result.textContent='paste a key first';return;}
      const r=await api('/providers/key','POST',{id:p.id,key:v});
      if(r.status===200&&r.data.success){keyInput.value='';toast(p.label+' key saved ('+r.data.hint+')');await renderProviders(host);}
      else result.textContent=r.data.error||('HTTP '+r.status);
    };
    const clr=row.querySelector('[data-a="clear"]');
    if(clr) clr.onclick=async()=>{await api('/providers/clear','POST',{id:p.id});toast(p.label+' credential cleared');await renderProviders(host);};
    return row;
  }

  async function testProvider(id){
    const r=await api('/providers/test','POST',{id});
    const t=r.data.result||{};
    toast(t.ok?`ok · ${t.model_count} models · ${t.latency_ms}ms`:(t.error||'failed'));
  }

  async function useProvider(adapter,base,id){
    const model=prompt('Model id for this endpoint (blank keeps the current one):',currentModel||'');
    if(model===null)return;
    const payload={'engine.provider':adapter,'engine.endpoint':base};
    if(model.trim())payload['engine.model']=model.trim();
    const r=await api('/config','POST',payload);
    if(r.status===200&&r.data.success){
      currentModel=r.data.applied?.engine?.model||currentModel;
      renderModel();
      toast('switched to '+adapter+' @ '+base);
    } else toast('switch failed: '+(r.data.error||r.status));
  }
}

function fmtWhen(v){
  const n=Number(v);
  const d=new Date(Number.isFinite(n)&&n>1e12?n:v);
  if(isNaN(d.getTime()))return String(v);
  return d.toISOString().slice(0,16).replace('T',' ');
}

function importSourceHint(id){
  return ({
    'claude-code':'~/.claude/.credentials.json',
    'gemini-cli':'~/.gemini/oauth_creds.json',
    'codex-cli':'~/.codex/auth.json',
    'qwen-code':'~/.qwen/oauth_creds.json',
    'github-copilot':'gh auth token (~/.config/gh/hosts.yml)'
  })[id]||id;
}

/* ── boot ────────────────────────────────────── */
(async()=>{
  await loadToken();
  try{
    const {status}=await api('/healthz');
    setState(status===200?'online':'',status===200?'IDLE':'OFFLINE');
  }catch{setState('','OFFLINE');}
  await loadConfig().catch(()=>{});
  await loadWorkspace().catch(()=>{});
  await loadSkills().catch(()=>{});
  loadSessionState();
  paintSession();
  await loadProjects().catch(()=>{});
  checkInterrupted().catch(()=>{});
  bindMenus();
  applyAccent(localStorage.getItem('liber-accent')||ACCENTS[0]);
  applyUiPrefs();
  openOverview('review');
  setInterval(()=>{loadWorkspace().catch(()=>{});},20000);
  setInterval(()=>{refreshBudget().catch(()=>{});},60000);
  $('prompt').focus();
})();
