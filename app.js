const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const state={user:null,role:null,view:'dashboard',cache:{}};
const ROLE={
  coordinator:{label:'Coordinator / Administrator',icon:'C',tone:'coordinator'},
  student:{label:'Student',icon:'S',tone:'student'},
  adviser:{label:'Adviser',icon:'A',tone:'adviser'},
  panel_member:{label:'Panel Member',icon:'P',tone:'panel'}
};
const NAV={
  coordinator:[
    ['group','Operations'],['dashboard','Dashboard','⌂'],['requests','Defense Requests','↗'],['schedules','Defense Scheduling','◷'],['panels','Panel Assignment','◇'],['rooms','Rooms','□'],
    ['group','Academic records'],['projects','Projects','▣'],['evaluations','Evaluations','✓'],['reports','Reports','▤'],
    ['group','Administration'],['users','User Management','♙'],['management','Project Plan','▥']
  ],
  student:[
    ['group','My process'],['dashboard','Dashboard','⌂'],['requests','Defense Request','↗'],['schedules','My Schedule','◷'],['projects','My Project','▣'],['panels','Assigned Panel','◇'],['evaluations','Defense Result','✓']
  ],
  adviser:[
    ['group','Advising'],['dashboard','Dashboard','⌂'],['projects','Assigned Students & Projects','▣'],['schedules','Defense Schedule','◷'],['evaluations','Evaluation / Comments','✓']
  ],
  panel_member:[
    ['group','Defense duties'],['dashboard','Dashboard','⌂'],['schedules','Assigned Defenses & Schedule','◷'],['evaluations','Evaluation','✓']
  ]
};
const TITLES={dashboard:['Overview','Dashboard'],requests:['Defense workflow','Defense Requests'],schedules:['Scheduling','Defense Scheduling'],panels:['Assignments','Panel Assignment'],rooms:['Facilities','Rooms'],projects:['Academic records','Projects'],evaluations:['Results','Evaluations'],users:['Administration','User Management'],management:['Project controls','Project Plan'],reports:['Reports','Reports']};

let csrfToken='';
async function api(url,opts={}){
  const method=(opts.method||'GET').toUpperCase();
  if(method!=='GET'&&method!=='HEAD'&&url!=='/api/csrf'&&!csrfToken){ const c=await fetch('/api/csrf',{credentials:'same-origin'}); const cd=await c.json().catch(()=>({})); csrfToken=cd.token||''; }
  const headers={'Content-Type':'application/json',...(opts.headers||{})}; if(method!=='GET'&&method!=='HEAD'&&csrfToken)headers['X-CSRF-Token']=csrfToken;
  const res=await fetch(url,{credentials:'same-origin',...opts,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'Request failed.');
  return data;
}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\'':'&#39;','"':'&quot;'}[c]));}
function money(v){return new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:0}).format(Number(v||0));}
function dateParts(v){const s=String(v??'').trim(); const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(!m)return null; const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]); if(!Number.isInteger(y)||!Number.isInteger(mo)||!Number.isInteger(d)||mo<1||mo>12||d<1||d>31)return null; return {y,mo,d};}
function dateFmt(v){const p=dateParts(v); if(!p)return '—'; const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${months[p.mo-1]} ${p.d}, ${p.y}`;}
// Use a predictable numeric date field for manual entry. The browser's native
// date control uses locale-specific segments, which can shift/reset while a
// user types month/day digits. Keep the visible value as MM/DD/YYYY and send
// only a validated YYYY-MM-DD calendar date to the API.
function dateEntryIso(value){
  const raw=String(value??'').trim();
  let y,mo,d,m;
  if((m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/))){y=Number(m[1]);mo=Number(m[2]);d=Number(m[3]);}
  else if((m=raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))){mo=Number(m[1]);d=Number(m[2]);y=Number(m[3]);}
  else {
    const digits=raw.replace(/\D/g,'');
    if(digits.length!==8)return '';
    mo=Number(digits.slice(0,2));d=Number(digits.slice(2,4));y=Number(digits.slice(4,8));
  }
  if(!y||mo<1||mo>12||d<1||d>31)return '';
  const check=new Date(Date.UTC(y,mo-1,d));
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==mo-1||check.getUTCDate()!==d)return '';
  return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function dateEntryDisplay(value){
  const iso=dateEntryIso(value); if(!iso)return '';
  const [y,mo,d]=iso.split('-'); return `${mo}/${d}/${y}`;
}
function dateInputMarkup(id,value=''){
  return `<input id="${id}" class="date-entry" type="text" inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" placeholder="MM/DD/YYYY" title="Enter date as MM/DD/YYYY, for example 11/20/2026" data-date-entry value="${esc(dateEntryDisplay(value))}">`;
}
function readDateInput(input){
  const iso=dateEntryIso(input?.value);
  if(!iso)throw new Error('Enter a valid date as MM/DD/YYYY (for example, 11/20/2026).');
  return iso;
}
function optionalDateInputIso(input){return dateEntryIso(input?.value)||'';}
function maskDateEntry(input){
  const oldValue=input.value;
  const caret=input.selectionStart??oldValue.length;
  const digitsBefore=oldValue.slice(0,caret).replace(/\D/g,'').length;
  const digits=oldValue.replace(/\D/g,'').slice(0,8);
  let formatted=digits;
  if(digits.length>2)formatted=`${digits.slice(0,2)}/${digits.slice(2)}`;
  if(digits.length>4)formatted=`${digits.slice(0,2)}/${digits.slice(2,4)}/${digits.slice(4)}`;
  input.value=formatted;
  const separators=(digitsBefore>2?1:0)+(digitsBefore>4?1:0);
  const nextCaret=Math.min(formatted.length,digitsBefore+separators);
  try{input.setSelectionRange(nextCaret,nextCaret);}catch{}
}
document.addEventListener('input',event=>{
  const input=event.target.closest?.('[data-date-entry]');
  if(input)maskDateEntry(input);
});
function timeFmt(v){if(!v)return '—'; const s=String(v); const m=s.match(/(?:^|T)(\d{1,2}):(\d{2})/); if(!m)return '—'; const h=Number(m[1]), min=Number(m[2]); if(!Number.isInteger(h)||!Number.isInteger(min)||h<0||h>23||min<0||min>59)return '—'; const d=new Date(2000,0,1,h,min); return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}
function manilaClock(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,minutes:Number(p.hour)*60+Number(p.minute)};}
function futureDefenseStartError(date,start){if(!date||!start)return '';const now=manilaClock(),match=String(start).match(/^(\d{2}):(\d{2})$/);if(!match)return '';const mins=Number(match[1])*60+Number(match[2]);if(date<now.date)return 'Defense schedules cannot be placed in the past. Choose today or a future date.';if(date===now.date&&mins<=now.minutes)return 'The defense start time has already passed. Choose a later start time in Philippine time.';return '';}
function constrainFutureDateTime(dateInput,timeInput){if(!dateInput)return ()=>{};const update=()=>{const now=manilaClock(),date=optionalDateInputIso(dateInput);if(timeInput){if(date===now.date)timeInput.min=now.time;else timeInput.removeAttribute('min');}};update();dateInput.addEventListener('input',update);dateInput.addEventListener('change',update);return update;}
function statusTag(v=''){const cls=v.toLowerCase().replace(/\s+/g,'');const map={'inprogress':'inprogress','notstarted':'planned','planning':'planned','requirements':'requirements','design':'design','development':'inprogress','testing':'testing','resubmitted':'resubmitted','atrisk':'atrisk','returned':'returned','active':'active','pendingconfirmation':'pendingconfirmation','pendingevaluation':'pendingevaluation','awaitingcoordinatordecision':'pendingconfirmation','awaitingevaluations':'pendingevaluation','notconducted':'notconducted','reschedulerequested':'reschedulerequested'};return `<span class="status ${map[cls]||cls}">${esc(v)}</span>`}
function displayedScheduleStatus(s){return s?.display_status||s?.status||'Unknown'}
function dashboardSchedule(schedules=[]){const active=(schedules||[]).filter(s=>s.status!=='Cancelled');const futureOrOngoing=active.find(s=>['Upcoming','Ongoing'].includes(displayedScheduleStatus(s)));if(futureOrOngoing)return futureOrOngoing;const byMostRecent=(items)=>[...items].sort((a,b)=>`${b.defense_date} ${String(b.start_time||'').slice(0,5)}`.localeCompare(`${a.defense_date} ${String(a.start_time||'').slice(0,5)}`));const needsFollowUp=byMostRecent(active.filter(s=>['Pending Confirmation','Pending Evaluation','Awaiting Coordinator Decision','Not Conducted','Reschedule Requested'].includes(displayedScheduleStatus(s))));return needsFollowUp[0]||byMostRecent(active)[0]||null}
function projectPhaseInfo(status){const phases=[['Planning','Define project scope, objectives, resources, and the work plan.'],['Requirements','Gather and document the system’s functional and technical requirements.'],['Design','Prepare the system architecture, interface, and database design.'],['Development','Build and integrate the approved system features.'],['Testing','Test the system, record issues, and verify corrections.'],['Completed','The project has been marked complete by the coordinator.']];const index=phases.findIndex(x=>x[0]===status);return {index,label:index<0?'Status not set':phases[index][0],description:index<0?'Ask the coordinator to review the project phase.':phases[index][1]}}
function projectPlanStatusCard(plan){if(!plan)return '<div class="project-plan-status"><span>Overall project-plan timeline</span><b>Not available</b></div>';return `<div class="project-plan-status"><div class="project-plan-status-copy"><span>Overall project-plan timeline</span><strong>${dateFmt(plan.startDate)} – ${dateFmt(plan.endDate)}</strong><small>Deadline-based status · as of ${dateFmt(plan.today)}</small></div>${statusTag(plan.status)}</div>`}
function adviserProjectCard(p){
  const phase=projectPhaseInfo(p.status);
  const position=phase.index<0?'—':`${phase.index+1} of 6`;
  const assignedStudents=(p.students||[]).map(st=>st.full_name).filter(Boolean);
  return `<article class="adviser-project-card">
    <div class="adviser-project-top">
      <div class="adviser-project-name"><b>${esc(p.title)}</b><small>${esc(p.type||'Project')}</small></div>
      <div class="adviser-project-phase-badge">${statusTag(phase.label)}</div>
    </div>
    <div class="adviser-project-students"><span>Assigned student${assignedStudents.length===1?'':'s'}</span><strong>${esc(assignedStudents.join(', ')||'No students assigned')}</strong></div>
    <div class="adviser-project-current"><span>Current development phase</span><strong>${position} · ${esc(phase.label)}</strong><p>${esc(phase.description)}</p></div>
    <div class="project-phase-steps" aria-label="Project development phases">${['Planning','Requirements','Design','Development','Testing','Completed'].map((label,i)=>`<span class="project-phase-step ${phase.index>=0&&i<phase.index?'is-done':''} ${i===phase.index?'is-current':''}" title="${label}"><i></i><small>${label}</small></span>`).join('')}</div>
  </article>`;
}
function panelOutcomeActions(s){const status=displayedScheduleStatus(s);if(status==='Pending Confirmation')return `<div class="panel-outcome-actions"><button class="btn purple" data-panel-outcome="${s.id}" data-outcome="Conducted">Confirm Conducted</button><button class="btn" data-panel-outcome="${s.id}" data-outcome="Not Conducted">Report Not Conducted</button></div>`;if(status==='Upcoming')return `<div class="panel-outcome-actions">${s.panel_proceedance==='Pending'?`<button class="btn purple" data-proceed="${s.id}">Proceed</button>`:statusTag('Proceed Confirmed')}<button class="btn" data-reschedule="${s.id}">Reschedule</button></div>`;if(status==='Pending Evaluation')return `<button class="btn" data-view="evaluations">Evaluate Defense</button>`;if(status==='Completed')return `<button class="btn" data-view="evaluations">View Evaluation</button>`;return statusTag(status)}
function initials(name=''){return name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'?'}
function avatarMarkup(user, cls='user-table-avatar'){
  const name=esc(user?.full_name||'');
  const initial=esc(initials(user?.full_name||''));
  const hasImage=!!user?.profile_image;
  const previewAttrs=hasImage?` role="button" tabindex="0" aria-label="View ${name} profile picture" data-profile-preview="${esc(user.profile_image)}" data-profile-preview-alt="${name} profile picture"`:' aria-hidden="true"';
  if(!hasImage) return `<span class="${cls}"${previewAttrs}>${initial}</span>`;
  return `<span class="${cls} has-image profile-preview-trigger"${previewAttrs}><img src="${esc(user.profile_image)}" alt="${name} profile picture" onerror="this.style.display='none';this.nextElementSibling.style.display='grid';"><span class="avatar-fallback" style="display:none">${initial}</span></span>`;
}
function setAvatar(el,user){if(!el)return; el.outerHTML=avatarMarkup(user,el.className||'top-avatar');}
function openImagePreview(src,alt='Profile picture'){
  if(!src) return;
  $('#imagePreviewModal')?.remove();
  const wrap=document.createElement('div');
  wrap.className='image-preview-backdrop';
  wrap.id='imagePreviewModal';
  wrap.innerHTML=`<div class="image-preview-dialog" role="dialog" aria-modal="true" aria-label="${esc(alt)}">
    <button type="button" class="image-preview-close" data-close-image-preview aria-label="Close image preview">×</button>
    <img class="image-preview-image" src="${esc(src)}" alt="${esc(alt)}" onerror="this.hidden=true;this.closest('.image-preview-dialog').querySelector('.image-preview-error').hidden=false;">
    <div class="image-preview-error" hidden>Profile image could not be displayed.</div>
  </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(()=>wrap.classList.add('is-open'));
  setTimeout(()=>wrap.querySelector('.image-preview-close')?.focus(),0);
}
function roleLabel(r){return ROLE[r]?.label||r}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.remove('show'),2600)}

function applyRoleTheme(role){ document.body.classList.remove('theme-student','theme-adviser','theme-panel','theme-coordinator'); const tone=ROLE[role]?.tone; if(tone) document.body.classList.add('theme-'+tone); }
function showApp(){
  // The system now uses a fixed light appearance; role accent colors remain enabled.
  applyLightTheme();
  applyRoleTheme(state.role);
  // Hide the authentication shell explicitly. The high-specificity landing-page
  // display rules previously overrode the generic .hidden utility class.
  const authRoot=$('#authRoot');
  const appRoot=$('#appRoot');
  authRoot.classList.add('hidden');
  authRoot.setAttribute('hidden','');
  authRoot.setAttribute('aria-hidden','true');
  authRoot.inert=true;
  appRoot.classList.remove('hidden');
  appRoot.removeAttribute('hidden');
  appRoot.removeAttribute('aria-hidden');
  appRoot.inert=false;
  $('#identityName').textContent=state.user.full_name;$('#identityRole').textContent=state.user.role_label;
  setAvatar($('#avatar'), state.user);
  const profileButton=$('#profileButton');
  if(profileButton){
    profileButton.onclick=(e)=>{
      if(e.target.closest('[data-profile-preview]')) return;
      openProfile();
    };
  }
  renderNav();renderView('dashboard');
}
function renderNav(){
  const nav=$('#nav');nav.innerHTML=(NAV[state.role]||[]).map(item=>item[0]==='group'?`<div class="nav-group">${item[1]}</div>`:`<button class="nav-btn ${state.view===item[0]?'active':''}" data-view="${item[0]}"><span class="nav-icon">${item[2]}</span><span>${item[1]}</span></button>`).join('');
}
function pageHead(kicker,title,desc,actions=''){return `<div class="page-intro"><div><p class="micro">${esc(kicker)}</p><h2>${esc(title)}</h2><p>${esc(desc)}</p></div><div class="actions">${actions}</div></div>`}
function stat(label,value,detail,accent=''){return `<div class="stat-card"><small>${esc(label)}</small><strong class="${accent}">${esc(value)}</strong><em>${esc(detail)}</em></div>`}

async function renderView(view){
  const allowed=(NAV[state.role]||[]).some(x=>x[0]===view);
  if(!allowed) view='dashboard';
  state.view=view;renderNav();
  const t=TITLES[view]||['Workspace','Dashboard'];$('#pageKicker').textContent=t[0];$('#pageTitle').textContent=t[1];$('#today').textContent=new Intl.DateTimeFormat('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(new Date());
  const root=$('#content');root.innerHTML='<div class="panel"><div class="empty">Loading workspace…</div></div>';
  try{
    const builders={dashboard:dashboardView,requests:requestsView,schedules:schedulesView,panels:panelsView,rooms:roomsView,projects:projectsView,evaluations:evaluationsView,users:usersView,management:managementView,reports:reportsView};
    root.innerHTML=await builders[view]();
  }catch(e){root.innerHTML=`<div class="panel"><div class="empty danger">${esc(e.message)}</div></div>`}
}

async function dashboardView(){
  const d=await api('/api/dashboard');state.cache.dashboard=d;
  if(state.role==='student') return studentDashboard(d);
  if(state.role==='adviser') return adviserDashboard(d);
  if(state.role==='panel_member') return panelDashboard(d);
  return coordinatorDashboard(d);
}
function commonTimeline(rows,empty='No scheduled defenses.'){return rows?.length?rows.map(s=>`<div class="timeline-item"><div class="timeline-date"><b>${dateFmt(s.defense_date)}</b><br>${timeFmt(s.start_time)}–${timeFmt(s.end_time)}</div><div class="timeline-main"><b>${esc(s.title)} · ${esc(s.defense_type||'Defense')}</b><small>${esc(s.title)}${s.room_name?' · '+esc(s.room_name):''}</small></div><div>${statusTag(displayedScheduleStatus(s))}</div></div>`).join(''):`<div class="empty">${empty}</div>`}
function requestRows(rows,actions=false){const list=actions?(rows||[]).filter(r=>r.status==='Pending'):(rows||[]);return list.length?list.map(r=>`<div class="request-item"><div class="request-main"><b>${esc(r.title)} · ${esc(r.defense_type)}</b><small>${esc(dateFmt(r.preferred_date))} · ${esc(timeFmt(r.preferred_time))}${r.review_feedback?' · '+esc(r.review_feedback):''}</small></div><div>${statusTag(r.status)}</div>${actions?`<div><button class="btn purple" data-review="${r.id}" data-review-status="approve">Approve</button> <button class="btn" data-review="${r.id}" data-review-status="return">Return</button></div>`:''}</div>`).join(''):`<div class="empty">${actions?'No requests are waiting for review.':'No requests found.'}</div>`}
function dashScroll(content, extra=''){return `<div class="dash-scroll ${extra}">${content}</div>`}
function coordinatorDashboard(d){return `${pageHead('Coordinator workspace','Dashboard','Review requests, control schedules, assign panels and rooms, and monitor project delivery.','')}
<div class="grid-4">${stat('Active users',d.counts.active_users,'administrator-managed accounts')}${stat('Projects',d.counts.projects,'registered thesis & capstone records')}${stat('Pending requests',d.counts.pending_requests,'awaiting review')}${stat('Upcoming defenses',d.counts.upcoming,'scheduled defense activities','accent-number')}</div>
<div class="dash-grid"><section class="panel"><div class="panel-head"><div><h3>Defense schedule</h3><span>Upcoming and current defense activities</span></div><button class="btn" data-view="schedules">View all</button></div><div class="panel-body">${dashScroll(commonTimeline(d.schedules))}</div></section>
<section class="panel"><div class="panel-head"><div><h3>Requests needing review</h3><span>Adviser/student workflow</span></div><button class="btn" data-view="requests">Open requests</button></div><div class="panel-body">${dashScroll(requestRows(d.requests,true))}</div></section></div>
<div class="split-grid"><section class="panel"><div class="panel-head"><div><h3>Project plan</h3><span>Timeline status: ${esc(d.projectPlan?.status||'Not available')}</span></div><button class="btn" data-view="management">Open plan</button></div><div class="panel-body"><div class="metric-row"><span>Timeline status</span><b>${statusTag(d.projectPlan?.status||'Not available')}</b></div><div class="metric-row"><span>Project timeline</span><b>${dateFmt(d.projectPlan?.startDate)} – ${dateFmt(d.projectPlan?.endDate)}</b></div><div class="metric-row"><span>Estimated budget</span><b>${money(292700)}</b></div><div class="metric-row"><span>Tracked risks</span><b>12</b></div><div style="margin-top:10px"><div class="metric-row"><span>Recorded weekly progress</span><b>${Number(d.counts.progress||0)}%</b></div><div class="progress"><span style="width:${Number(d.counts.progress||0)}%"></span></div></div></div></section>
<section class="panel"><div class="panel-head"><div><h3>Workflow guardrails</h3><span>Access and scheduling controls</span></div></div><div class="panel-body"><div class="notice"><b>Administrator-issued accounts</b>Public registration is disabled. Schedule creation checks student, adviser, room, date, time, and panel availability before saving.</div></div></section></div>`}
function studentDashboard(d){const next=dashboardSchedule(d.schedules);const activeDefense=(d.schedules||[]).find(s=>s.status==='Upcoming');const requestAction=activeDefense?'<button class="btn" disabled title="An active defense is already assigned to your project.">Defense already scheduled</button>':'<button class="btn primary" data-modal="student-request">Request defense</button>';return `${pageHead('Student workspace','Dashboard','Follow your defense request from preferred date and time through final result.',requestAction)}${activeDefense?'<div class="notice" style="margin-bottom:14px"><b>Request unavailable</b> Your project already has an active defense schedule. You can request another defense after the current schedule is completed or cancelled.</div>':''}
<div class="grid-4">${stat('My project',d.counts.projects,'registered project')}${stat('Requests',d.counts.pending_requests,'pending review')}${stat('Upcoming defense',d.counts.upcoming,next?dateFmt(next.defense_date):'not scheduled','accent-number')}${stat('Result records',state.cache.dashboard?.counts?.evaluations||0,'visible evaluation records')}</div>
<div class="dash-grid"><section class="panel"><div class="panel-head"><div><h3>Defense status</h3><span>${next?'Status of your nearest or most recent defense':'Your schedule will appear here after approval'}</span></div></div><div class="panel-body">${dashScroll(next?`<div class="project-card"><div><p class="micro">${esc(next.defense_type)}</p><h3 class="project-title">${esc(next.title)}</h3><div class="project-meta"><span class="chip">${dateFmt(next.defense_date)}</span><span class="chip">${timeFmt(next.start_time)}–${timeFmt(next.end_time)}</span><span class="chip">${esc(next.room_name||'Room TBA')}</span></div></div><div>${statusTag(displayedScheduleStatus(next))}</div></div>`:'<div class="empty">No defense has been scheduled yet. Check your request status or submit a request.</div>')}</div></section>
<section class="panel"><div class="panel-head"><div><h3>My requests</h3><span>Preferred defense date & time</span></div><button class="btn" data-view="requests">View</button></div><div class="panel-body">${dashScroll(requestRows(d.requests))}</div></section></div>
<section class="panel" style="margin-top:15px"><div class="panel-head"><div><h3>Result</h3><span>Review your recorded defense result</span></div><button class="btn" data-view="evaluations">Open result</button></div><div class="panel-body"><div class="notice"><b>Result clarification</b>If you are not satisfied with a recorded result, use the result page to contact the adviser for clarification.</div></div></section>`}
function adviserDashboard(d){
  // /api/dashboard already scopes d.projects to projects assigned to this adviser.
  const adviserProjects=Array.isArray(d.projects)?d.projects:[];
  const students=adviserProjects.flatMap(p=>(p.students||[]).map(st=>({...st,project_title:p.title})));
  const studentRows=students.length?students.map(st=>`<article class="adviser-student-row">
    <span class="adviser-student-avatar" aria-hidden="true">${esc(initials(st.full_name||''))}</span>
    <div class="adviser-student-copy"><b>${esc(st.full_name||'Unnamed student')}</b><small>${esc(st.project_title||'Project not specified')}</small></div>
  </article>`).join(''):'<div class="empty">No students are assigned to your projects yet.</div>';
  return `${pageHead('Adviser workspace','Dashboard','View your assigned students, monitor the progress of projects under your advising, review defense schedules, and provide evaluations/comments when assigned.','')}
<div class="grid-4">${stat('Assigned projects',adviserProjects.length,'under your advising')}${stat('Assigned students',students.length,'students linked to your projects')}${stat('Upcoming defenses',d.counts.upcoming,'for assigned projects','accent-number')}${stat('My evaluations',d.counts.evaluations,'evaluation records')}</div>
<div class="dash-grid">
  <section class="panel"><div class="panel-head"><div><h3>Assigned students</h3><span>Students linked to projects you advise</span></div><button class="btn" data-view="projects">View projects</button></div><div class="panel-body">${dashScroll(studentRows,'adviser-student-list')}</div></section>
  <section class="panel"><div class="panel-head"><div><h3>Project progress</h3><span>Development status of projects assigned to you and your students</span></div><button class="btn" data-view="projects">View projects</button></div><div class="panel-body">${dashScroll(adviserProjects.length?adviserProjects.map(adviserProjectCard).join(''):'<div class="empty">No projects are currently assigned to you.</div>','adviser-project-scroll')}</div></section>
</div>
<section class="panel" style="margin-top:15px"><div class="panel-head"><div><h3>Evaluation / comments</h3><span>Evaluate only when you are assigned as an evaluator for the defense</span></div><button class="btn" data-view="evaluations">Open evaluations</button></div><div class="panel-body"><div class="notice"><b>Assigned-project access only.</b> Your evaluation workspace includes only defenses where you have an explicit panel assignment.</div></div></section>`;
}
function panelDashboard(d){const activeSchedules=(d.schedules||[]).filter(x=>x.status!=='Cancelled');const next=dashboardSchedule(activeSchedules);return `${pageHead('Panel workspace','Dashboard','Review assigned defenses. Confirm whether an elapsed defense was conducted, report one that did not happen, and evaluate after confirmation.','')}
<div class="grid-4">${stat('Assigned defenses',d.counts.assigned_defenses,'panel duties','accent-number')}${stat('Upcoming',d.counts.upcoming,'future scheduled defenses')}${stat('My evaluations',d.counts.evaluations,'confirmed records')}${stat('Defense room',next?.room_name||'—',next?dateFmt(next.defense_date):'no assigned defense')}</div>
<div class="dash-grid"><section class="panel"><div class="panel-head"><div><h3>Assigned defenses</h3><span>Actions change when the scheduled defense time passes</span></div><button class="btn" data-view="schedules">View all</button></div><div class="panel-body">${dashScroll(activeSchedules.length?activeSchedules.map(s=>`<div class="timeline-item"><div class="timeline-date"><b>${dateFmt(s.defense_date)}</b><br>${timeFmt(s.start_time)}–${timeFmt(s.end_time)}</div><div class="timeline-main"><b>${esc(s.title)} · ${esc(s.defense_type)}</b><small>${esc(s.room_name||'Room TBA')}${s.panel_outcome_note?' · '+esc(s.panel_outcome_note):''}</small></div><div>${panelOutcomeActions(s)}</div></div>`).join(''):'<div class="empty">No assigned defenses.</div>')}</div></section>
<section class="panel"><div class="panel-head"><div><h3>Evaluation</h3><span>Submit scores after conducting and observing the defense</span></div><button class="btn" data-view="evaluations">Open</button></div><div class="panel-body"><div class="notice"><b>Confirm before submission.</b>Your scores and comments are saved to the defense record and can be updated only through the evaluation workflow.</div></div></section></div>`}

async function projectsView(){const d=await api('/api/projects');state.cache.projects=d.projects||[];let add=state.role==='coordinator'?'<button class="btn primary" data-modal="project">Add project</button>':'';let extra='';return `${pageHead('Academic records',state.role==='student'?'My Project':'Projects',state.role==='student'?'Your registered thesis or capstone project.':state.role==='adviser'?'Projects currently assigned to your advising role.':state.role==='panel_member'?'Projects connected to your assigned defenses.':'Maintain thesis and capstone records.',add)}<section class="panel"><div class="panel-body">${d.projects?.length?d.projects.map(p=>`<div class="panel" style="margin-bottom:12px"><div class="panel-body project-card"><div><p class="micro">${esc(p.type)}</p><h3 class="project-title">${esc(p.title)}</h3><div class="project-meta"><span class="chip">Adviser: ${esc(p.adviser_name||'Unassigned')}</span><span class="chip">${esc(p.students?.map(s=>s.full_name).join(', ')||'No student')}</span></div></div><div>${statusTag(p.status)}${state.role==='coordinator'?`<div style="margin-top:10px"><select class="status-select" data-project-status="${p.id}"><option ${p.status==='Planning'?'selected':''}>Planning</option><option ${p.status==='Requirements'?'selected':''}>Requirements</option><option ${p.status==='Design'?'selected':''}>Design</option><option ${p.status==='Development'?'selected':''}>Development</option><option ${p.status==='Testing'?'selected':''}>Testing</option><option ${p.status==='Completed'?'selected':''}>Completed</option></select><button class="btn danger-btn" data-project-delete="${p.id}" style="margin-left:8px">Remove</button></div>`:''}</div></div></div>`).join(''):'<div class="empty">No projects available.</div>'}</div></section>${extra}`}
async function studentFeedbackHtml(){const d=await api('/api/feedback');return d.feedback?.length?d.feedback.map(f=>`<div class="timeline-item"><div class="timeline-date">${dateFmt(f.created_at?.slice?.(0,10)||'')}</div><div class="timeline-main"><b>${esc(f.title)}</b><small>${esc(f.feedback)}</small></div><div>${statusTag(f.status)} ${f.status==='Open'?`<button class="btn primary" data-feedback-resubmit="${f.id}">Resubmit</button>`:''}</div></div>`).join(''):'<div class="empty">No adviser feedback has been recorded.</div>'}
async function clarificationHtml(){const d=await api('/api/result-clarifications');return d.clarifications?.length?d.clarifications.map(c=>`<div class="timeline-item"><div class="timeline-date">${dateFmt(c.defense_date)}</div><div class="timeline-main"><b>${esc(c.title)} · ${esc(c.student_name)}</b><small>${esc(c.message)}${c.resolution_note?' · Response: '+esc(c.resolution_note):''}</small></div><div>${statusTag(c.status)} ${c.status==='Open'?`<button class="btn" data-clarification-resolve="${c.id}">Resolve</button>`:''}</div></div>`).join(''):'<div class="empty">No result clarification requests.</div>'}
async function feedbackHtml(){const d=await api('/api/feedback');return d.feedback?.length?d.feedback.map(f=>`<div class="timeline-item"><div class="timeline-date">${dateFmt(f.created_at?.slice?.(0,10)||'')}</div><div class="timeline-main"><b>${esc(f.title)}</b><small>${esc(f.feedback)}</small></div><div>${statusTag(f.status)} ${f.status==='Resubmitted'?`<button class="btn" data-feedback-satisfied="${f.id}">Satisfied</button>`:''}</div></div>`).join(''):'<div class="empty">No advising feedback has been recorded.</div>'}

async function requestsView(){const isStudent=state.role==='student';const [d,studentProjects]=await Promise.all([api('/api/defense-requests'),isStudent?api('/api/my-projects'):Promise.resolve({projects:[]})]);state.cache.requests=d.requests||[];const isReviewer=state.role==='coordinator';const activeProjectIds=new Set((studentProjects.projects||[]).filter(p=>p.active_defense).map(p=>Number(p.id)));const hasActiveDefense=activeProjectIds.size>0;const action=isStudent?(hasActiveDefense?'<button class="btn" disabled title="An active defense is already assigned to your project.">Defense already scheduled</button>':'<button class="btn primary" data-modal="student-request">New request</button>'):'';const description=isStudent?(hasActiveDefense?'Your project already has an active defense schedule. A new request is available after it is completed or cancelled.':'Submit your proposal or final-defense request with a preferred date and time.'):'Review requests, approve them for scheduling, or proceed directly to the defense.';return `${pageHead('Defense workflow',isStudent?'Defense Request':'Defense Requests',description,action)}${hasActiveDefense?'<div class="notice" style="margin-bottom:14px"><b>Existing defense schedule</b> A defense is already assigned to your project. View its date, time, and status under My Schedule.</div>':''}<section class="panel"><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Project</th><th>Defense</th><th>Preferred schedule</th><th>Status</th><th>Feedback</th>${isReviewer?'<th>Decision / Scheduling</th>':isStudent?'<th>Action</th>':''}</tr></thead><tbody>${d.requests?.length?d.requests.map(r=>`<tr><td><b>${esc(r.title)}</b></td><td>${esc(r.defense_type)}</td><td>${dateFmt(r.preferred_date)}<br>${timeFmt(r.preferred_time)}</td><td>${statusTag(r.status)}</td><td class="muted">${esc(r.review_feedback||'—')}</td>${isReviewer?`<td>${r.status==='Pending'?`<button class="btn purple" data-review="${r.id}" data-review-status="approve">Approve</button> <button class="btn" data-review="${r.id}" data-review-status="return">Return</button>`:r.status==='Approved'?`<button class="btn primary" data-schedule-request="${r.id}">Create Schedule</button>`:'—'}</td>`:isStudent?`<td>${r.status==='Returned'?(activeProjectIds.has(Number(r.project_id))?'<span class="muted">Defense already scheduled</span>':`<button class="btn" data-resubmit-request="${r.id}">Revise & resubmit</button>`):'—'}</td>`:''}</tr>`).join(''):'<tr><td colspan="6"><div class="empty">No defense requests found.</div></td></tr>'}</tbody></table></div></section>`}

async function schedulesView(){
  const d=await api('/api/schedules');
  const allSchedules=d.schedules||[];
  const visibleSchedules=allSchedules.filter(s=>s.status!=='Cancelled');
  state.cache.schedules=visibleSchedules;
  const canManage=state.role==='coordinator';
  const canPanel=state.role==='panel_member';
  let reschedule=canPanel?'<span class="chip">After the defense ends, confirm whether it was conducted or report that it did not happen.</span>':'';
  const action=canManage?'<button class="btn primary" data-modal="schedule">Add defense schedule</button>':'';
  return `${pageHead('Scheduling',state.role==='student'?'My Schedule':state.role==='panel_member'?'Assigned Defense':'Defense Schedule',state.role==='coordinator'?'Create future schedules, review panel reports, and manage rescheduling. The system checks student, adviser, panel, room, project, date, and time conflicts automatically before saving.':canPanel?'Review assignments. Before the defense, proceed or request reschedule; after the end time, record the actual outcome.':'View the defense status and outcome for your assigned work.',action)}
  <section class="panel"><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Project</th><th>Type</th><th>Time</th><th>Room</th><th>Status</th>${canPanel?'<th>Panel action</th>':''}${canManage?'<th>Manage</th>':''}</tr></thead><tbody>${visibleSchedules.length?visibleSchedules.map(s=>{const display=displayedScheduleStatus(s);return `<tr><td>${dateFmt(s.defense_date)}</td><td><b>${esc(s.title)}</b></td><td>${esc(s.defense_type)}</td><td>${timeFmt(s.start_time)}–${timeFmt(s.end_time)}</td><td>${esc(s.room_name||'Room TBA')}</td><td>${statusTag(display)}${s.panel_outcome_note?`<br><small class="muted schedule-outcome-note">${esc(s.panel_outcome_note)}</small>`:''}</td>${canPanel?`<td>${panelOutcomeActions(s)}</td>`:''}${canManage?`<td>${s.status==='Upcoming'&&s.panel_outcome!=='Conducted'?`<button class="btn" data-schedule-edit="${s.id}">Edit</button> <button class="btn" data-cancel="${s.id}">Cancel</button>`:s.status==='Completed'?'<span class="muted">Evaluations complete</span>':s.panel_outcome==='Conducted'?'<span class="muted">Awaiting evaluations</span>':'<span class="muted">Review panel report</span>'}</td>`:''}</tr>`}).join(''):'<tr><td colspan="8"><div class="empty">No active defense schedules found.</div></td></tr>'}</tbody></table></div></section>${canManage?`<section class="panel" style="margin-top:15px"><div class="panel-head"><div><h3>Reschedule requests</h3><span>Panel members can request a different defense time before the scheduled event</span></div></div><div class="panel-body">${await rescheduleRequestsHtml()}</div></section>`:''}${reschedule?`<div style="margin-top:12px">${reschedule}</div>`:''}`}

async function rescheduleRequestsHtml(){const d=await api('/api/reschedule-requests');return d.requests?.length?d.requests.map(r=>`<div class="request-item"><div class="request-main"><b>${esc(r.requester_name)} · ${esc(r.title)}</b><small>Current: ${dateFmt(r.defense_date)} ${timeFmt(r.start_time)} · Requested: ${dateFmt(r.preferred_date)} ${timeFmt(r.preferred_time)}<br>${esc(r.reason)}</small></div>${statusTag(r.status)}${r.status==='Pending'?`<div><button class="btn purple" data-resched-review="${r.id}" data-status="Approved">Approve</button> <button class="btn" data-resched-review="${r.id}" data-status="Rejected">Reject</button></div>`:''}</div>`).join(''):'<div class="empty">No reschedule requests.</div>'}

async function panelsView(){
  const d=await api('/api/panels');state.cache.panels=d.assignments||[];const canAssign=state.role==='coordinator';
  return `${pageHead('Assignments','Panel Assignment',state.role==='coordinator'?'Assign chairperson, panel members, and adviser roles to defense schedules. Assignments lock after the defense outcome is recorded.':state.role==='panel_member'?'Your assigned defense roles.':state.role==='student'?'Panel members assigned to your defense.':'Panel assignment for your students.',canAssign?'<button class="btn primary" data-modal="panel">Assign panel</button>':'' )}<section class="panel"><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Project</th><th>Member</th><th>Panel role</th><th>Status</th>${canAssign?'<th>Action</th>':''}</tr></thead><tbody>${d.assignments?.length?d.assignments.map(a=>{const locked=!!a.panel_outcome||a.status==='Completed'||a.status==='Cancelled'||a.result_status==='Finalized';return `<tr><td>${dateFmt(a.defense_date)}<br>${timeFmt(a.start_time)}</td><td><b>${esc(a.title)}</b></td><td>${esc(a.full_name)}<br><span class="muted">${esc(a.email)}</span></td><td>${esc(a.panel_role)}</td><td>${statusTag(displayedScheduleStatus(a))}</td>${canAssign?`<td>${locked?'<span class="muted">Locked</span>':`<button class="btn danger-btn" data-panel-delete="${a.id}">Remove</button>`}</td>`:''}</tr>`}).join(''):'<tr><td colspan="5"><div class="empty">No panel assignments found.</div></td></tr>'}</tbody></table></div></section>`
}

async function roomsView(){const d=await api('/api/rooms');return `${pageHead('Facilities','Rooms','Manage defense rooms, seating capacity, and availability.','<button class="btn primary" data-modal="room">Add room</button>')}<section class="panel"><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Room</th><th>Location</th><th>Capacity</th><th>Availability</th><th>Action</th></tr></thead><tbody>${d.rooms.map(r=>`<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.location)}</td><td>${Number(r.capacity)||'—'} people</td><td><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-room="${r.id}" ${r.is_available?'checked':''}> <span class="muted">${r.is_available?'Available':'Unavailable'}</span></label></td><td><button class="btn" data-room-edit="${r.id}">Edit</button> <button class="btn danger-btn" data-room-delete="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table></div></section>`}

async function evaluationsView(){
  const d=await api('/api/evaluations');
  const canSubmit=(state.role==='panel_member'||state.role==='adviser');
  const finalizationPanel=state.role==='coordinator'?`<section class="panel" style="margin-bottom:15px"><div class="panel-head"><div><h3>Final result review</h3><span>Unanimous evaluator decisions are finalized automatically. Conflicting decisions require a Coordinator decision.</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Defense</th><th>Evaluator submissions</th><th>Individual decisions</th><th>Final status</th><th>Action</th></tr></thead><tbody>${d.finalizations?.length?d.finalizations.map(f=>{const ready=f.result_status==='Awaiting Coordinator';const complete=f.result_status==='Finalized';const progress=`${Number(f.submitted_count)}/${Number(f.expected_count)} submitted · ${Number(f.decision_count)}/${Number(f.expected_count)} decisions`;return `<tr><td><b>${esc(f.title)}</b><br>${dateFmt(f.defense_date)} · ${esc(f.defense_type)}</td><td>${progress}</td><td class="muted">${esc(f.evaluation_summary)}</td><td>${complete?statusTag(f.final_defense_result):ready?statusTag('Awaiting Coordinator Decision'):statusTag('Awaiting Evaluations')}</td><td>${ready?`<button class="btn primary" data-finalize-result="${f.schedule_id}">Finalize result</button>`:'—'}</td></tr>`}).join(''):'<tr><td colspan="5"><div class="empty">No conducted defenses are awaiting evaluations or final-result review.</div></td></tr>'}</tbody></table></div></section>`:'';
  return `${pageHead('Assessment',state.role==='student'?'Defense Result':state.role==='panel_member'?'Evaluation':'Evaluations',state.role==='student'?'Review the final defense result and evaluator feedback.':canSubmit?'Submit your individual scores, recommendation and defense decision for assigned defenses.':'Review individual evaluations and finalize any conflicting defense decisions.',canSubmit?'<button class="btn primary" data-modal="evaluation">Submit evaluation</button>':'' )}${finalizationPanel}<section class="panel"><div class="panel-head"><div><h3>Individual evaluations</h3><span>Each evaluator’s decision is preserved separately from the final recorded result.</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Defense</th><th>Evaluator</th><th>Scores</th><th>Recommendation</th><th>Evaluator decision</th><th>Final result</th><th>Comments</th>${state.role==='student'?'<th>Action</th>':''}</tr></thead><tbody>${d.evaluations?.length?d.evaluations.map(e=>{const avg=((Number(e.technical_score)+Number(e.presentation_score)+Number(e.documentation_score))/3).toFixed(1);return `<tr><td><b>${esc(e.title)}</b><br>${dateFmt(e.defense_date)} · ${esc(e.defense_type)}</td><td>${esc(e.evaluator_name)}</td><td>Technical ${Number(e.technical_score).toFixed(0)}<br>Presentation ${Number(e.presentation_score).toFixed(0)}<br>Documentation ${Number(e.documentation_score).toFixed(0)}<br><b>Average ${avg}</b></td><td>${esc(e.recommendation)}</td><td>${statusTag(e.defense_result||'Decision not recorded')}</td><td>${e.final_defense_result?statusTag(e.final_defense_result):statusTag(e.result_status==='Awaiting Coordinator'?'Awaiting Coordinator Decision':'Pending')}</td><td class="muted">${esc(e.comments||'—')}${e.result_decision_note?`<br><small>Final decision: ${esc(e.result_decision_note)}</small>`:''}</td>${state.role==='student'?`<td><button class="btn" data-clarify="${e.schedule_id}">Not satisfied / Clarify</button></td>`:''}</tr>`}).join(''):`<tr><td colspan="${state.role==='student'?8:7}"><div class="empty">No evaluation result is available.</div></td></tr>`}</tbody></table></div></section>`;
}

async function openFinalizeResultModal(scheduleId){
  try{
    const data=await api('/api/evaluations');
    const item=(data.finalizations||[]).find(x=>Number(x.schedule_id)===Number(scheduleId));
    if(!item||item.result_status!=='Awaiting Coordinator')return toast('This defense is not waiting for a Coordinator final decision. Refresh the page.');
    const evaluatorRows=(data.evaluations||[]).filter(e=>Number(e.schedule_id)===Number(scheduleId)).map(e=>{
      const average=((Number(e.technical_score)+Number(e.presentation_score)+Number(e.documentation_score))/3).toFixed(1);
      return `<div class="eval-review-item"><div class="eval-review-top"><b>${esc(e.evaluator_name)}</b>${statusTag(e.defense_result||'Decision not recorded')}</div><div class="eval-review-scores"><span>Technical <b>${Number(e.technical_score).toFixed(1)}</b></span><span>Presentation <b>${Number(e.presentation_score).toFixed(1)}</b></span><span>Documentation <b>${Number(e.documentation_score).toFixed(1)}</b></span><span>Average <b>${average}</b></span></div><div class="eval-review-meta"><b>Recommendation:</b> ${esc(e.recommendation||'—')}</div>${e.comments?`<p>${esc(e.comments)}</p>`:''}</div>`;
    }).join('');
    const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='finalResultModal';
    wrap.innerHTML=`<div class="modal"><div class="modal-head"><div><p class="micro">FINAL RESULT REVIEW</p><h3>${esc(item.title)}</h3></div><button class="modal-close" data-close-final-result>×</button></div><div class="modal-form"><div class="full notice"><b>Evaluator decisions disagree</b><br>${esc(item.evaluation_summary)}<br><br>${Number(item.submitted_count)} of ${Number(item.expected_count)} assigned evaluators submitted evaluations. Review their scores, recommendations and comments, then select the Coordinator's final result and explain the decision.</div><div class="full eval-review-list"><h4>Individual evaluator submissions</h4>${evaluatorRows||'<p class="muted">No individual evaluation details were found.</p>'}</div><label class="full">Final defense result<select id="final-defense-result"><option>Passed</option><option>Failed</option><option>For Revision</option><option>Re-defense Required</option></select></label><label class="full">Decision note<textarea id="final-decision-note" maxlength="2000" placeholder="Explain why this is the final result based on the evaluator submissions." required></textarea></label><div class="modal-actions"><button class="btn" data-close-final-result>Cancel</button><button class="btn primary" id="saveFinalDefenseResult">Record final result</button></div></div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelectorAll('[data-close-final-result]').forEach(btn=>btn.addEventListener('click',()=>wrap.remove()));
    $('#saveFinalDefenseResult').onclick=async()=>{try{const note=$('#final-decision-note').value.trim();if(!note)throw new Error('Explain the Coordinator final decision.');await api(`/api/evaluations/${scheduleId}/final-result`,{method:'PATCH',body:JSON.stringify({defense_result:$('#final-defense-result').value,decision_note:note})});wrap.remove();toast('Final defense result recorded.');await renderView('evaluations');}catch(e){toast(e.message)}};
  }catch(e){toast(e.message)}
}

async function usersView(){const d=await api('/api/users?_='+Date.now());return `${pageHead('Administration','User Management','Create, update, deactivate, and remove system accounts. The main Coordinator / Administrator account is protected from changes by other coordinators.','<button class="btn primary" data-modal="user">Create account</button>')}<section class="panel"><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${d.users.map(u=>`<tr><td><div class="user-name-cell">${avatarMarkup(u)}<b>${esc(u.full_name)}</b>${u.is_primary_coordinator?'<span class="role-label"></span>':''}</div></td><td>${esc(u.email)}</td><td><span class="role-label role-label-${esc(u.role)}">${esc(roleLabel(u.role))}</span></td><td>${u.is_active?statusTag('Active'):statusTag('At Risk')}</td><td><div class="table-actions">${u.is_primary_coordinator?(u.is_active?'<span class="muted">Protected account</span>':`<button class="btn" data-user-toggle="${u.id}" data-active="false">Activate</button><span class="muted">Protected from deactivation/deletion</span>`):u.id!==state.user.id?`<button class="btn" data-user-edit="${u.id}">Edit</button><button class="btn" data-user-toggle="${u.id}" data-active="${u.is_active}">${u.is_active?'Deactivate':'Activate'}</button><button class="btn danger-btn" data-user-delete="${u.id}">Delete</button>`:'<span class="muted">Current account</span>'}</div></td></tr>`).join('')}</tbody></table></div></section>`}

async function managementView(){const d=await api('/api/management');return `${pageHead('Project controls','Project Plan',`Scheduled timeline: ${dateFmt(d.projectPlan.startDate)} – ${dateFmt(d.projectPlan.endDate)}. The overall timeline is marked Completed after its end date; individual task records stay unchanged.` ,statusTag(d.projectPlan.status))}
<div class="grid-4">${stat('WBS phases','7','major phases')}${stat('Project weeks','12',`${dateFmt(d.projectPlan.startDate)} – ${dateFmt(d.projectPlan.endDate)}`)}${stat('Budget',money(d.budgetTotal),'estimated total')}${stat('Timeline status',d.projectPlan.status,`as of ${dateFmt(d.projectPlan.today)}`,'accent-number')}</div>
<div class="management-grid"><section class="panel management-wbs"><div class="panel-head"><div><h3>Work Breakdown Structure</h3><span>Work-package statuses and progress are synchronized from the Weekly Tracker</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Work package</th><th>Target dates</th><th>Status</th><th>Progress</th></tr></thead><tbody>${d.wbs.map(w=>`<tr><td><b>${esc(w.code)}</b></td><td>${w.phase?'<b>':''}${esc(w.item)}${w.phase?'</b>':''}</td><td>${esc(w.target_dates)}</td><td>${statusTag(w.status)}</td><td>${Number(w.progress??0)}%</td></tr>`).join('')}</tbody></table></div></section>
<section class="panel"><div class="panel-head"><div><h3>Gantt Chart</h3><span>Activity status and progress follow the mapped weekly tasks</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Activity</th><th>Status</th><th>Progress</th>${Array.from({length:12},(_,i)=>`<th>W${i+1}</th>`).join('')}</tr></thead><tbody>${d.gantt.map(g=>`<tr><td><b>${esc(g.activity)}</b></td><td>${statusTag(g.status)}</td><td>${Number(g.progress??0)}%</td>${Array.from({length:12},(_,i)=>`<td>${i+1>=g.week_start&&i+1<=g.week_end?`<span class="status ${g.status.toLowerCase().replace(/\s+/g,'')}">●</span>`:'—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
<section class="panel"><div class="panel-head"><div><h3>Budget Plan</h3><span>Estimated project cost</span></div><strong>${money(d.budgetTotal)}</strong></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Category</th><th>Description</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr></thead><tbody>${d.budget.map(b=>`<tr><td><b>${esc(b.category)}</b></td><td>${esc(b.description)}</td><td>${esc(b.quantity)}</td><td>${money(b.unit_cost)}</td><td><b>${money(b.total)}</b></td></tr>`).join('')}</tbody></table></div></section>
<section class="panel"><div class="panel-head"><div><h3>Risk Register</h3><span>R1–R12 with mitigation and owners</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Risk</th><th>Category</th><th>Likelihood</th><th>Impact</th><th>Level</th><th>Mitigation</th><th>Owner</th></tr></thead><tbody>${d.risks.map(r=>`<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.description)}</td><td>${esc(r.category)}</td><td>${esc(r.likelihood)}</td><td>${esc(r.impact)}</td><td>${statusTag(r.risk_level)}</td><td>${esc(r.mitigation)}</td><td>${esc(r.owner)}</td></tr>`).join('')}</tbody></table></div></section>
<section class="panel"><div class="panel-head"><div><h3>System Flowchart</h3><span>From account creation through defense reporting</span></div></div><div class="flow-wrap"><img src="/assets/system-flowchart.png" alt="ThesisFlow system process flowchart showing account creation, login, project assignment, student defense request, Coordinator review, scheduling, panel and room assignment, conflict detection, defense outcome, evaluation, result recording, and Coordinator reporting"></div></section>
<section class="panel"><div class="panel-head"><div><h3>Weekly Tracker</h3><span>Changes here automatically update the related WBS work packages and Gantt activities</span></div></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>Week</th><th>Focus</th><th>Expected output</th><th>Status</th><th>Progress</th><th>Update</th></tr></thead><tbody>${d.weekly.map(w=>`<tr><td><b>Week ${w.week}</b></td><td>${esc(w.focus)}</td><td>${esc(w.expected_output)}</td><td>${statusTag(w.status)}</td><td>${w.progress}%</td><td><select data-week-status="${w.week}"><option ${w.status==='Not started'?'selected':''}>Not started</option><option ${w.status==='In Progress'?'selected':''}>In Progress</option><option ${w.status==='Completed'?'selected':''}>Completed</option><option ${w.status==='At Risk'?'selected':''}>At Risk</option></select></td></tr>`).join('')}</tbody></table></div></section></div>`}

async function reportsView(){const d=await api('/api/reports/summary');return `${pageHead('Reporting','Reports','Complete defense-related reports required by the project scope.','<button class="btn primary" data-export>Export all reports</button>')}<div class="grid-4">${stat('Projects',d.projects,'registered projects')}${stat('Defense requests',d.requests,'recorded requests')}${stat('Schedules',d.schedules,'active schedules')}${stat('Evaluations',d.evaluations,'recorded evaluations')}</div><div class="report-grid" style="margin-top:15px"><section class="panel report-card"><div class="panel-head"><div><h3>Defense Schedule Report</h3><span>Dates, times, projects, rooms and status</span></div><button class="btn" data-report="defense-schedule">View</button></div></section><section class="panel report-card"><div class="panel-head"><div><h3>Panel Assignment Report</h3><span>Chairperson, panel members and adviser</span></div><button class="btn" data-report="panel-assignment">View</button></div></section><section class="panel report-card"><div class="panel-head"><div><h3>Student Status Report</h3><span>Projects, students, advisers and status</span></div><button class="btn" data-report="student-status">View</button></div></section><section class="panel report-card"><div class="panel-head"><div><h3>Evaluation Report</h3><span>Scores, recommendations and results</span></div><button class="btn" data-report="evaluation">View</button></div></section></div><section id="reportResult" class="panel" style="margin-top:15px"><div class="empty">Choose a report to preview its complete records.</div></section>`}

function openModal(type){
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';
  wrap.addEventListener('click',e=>{if(e.target===wrap)wrap.remove()});
  let title='',body='',action='';
  if(type==='user'){title='Create account';action='user';body=`<div class="modal-form"><label>Full name<input id="f-name" required></label><label>Email address<input id="f-email" type="email" required></label><label>Password<input id="f-password" type="password" minlength="8" required></label><label>Role<select id="f-role"><option value="student">Student</option><option value="adviser">Adviser</option><option value="panel_member">Panel Member</option><option value="coordinator">Coordinator / Administrator</option></select></label><div class="full notice"><b>Administrator-issued account</b>This account is created by the Coordinator / Administrator. Public registration remains disabled.</div></div>`}
  if(type==='project'){
    title='Add project';action='project';body=`<div class="modal-form"><label>Type<select id="f-type"><option>Thesis</option><option>Capstone</option></select></label><label>Adviser<select id="f-adviser"><option value="">Loading available advisers…</option></select></label><label class="full">Project title<input id="f-title" placeholder="Enter thesis or capstone title" required></label><div class="full"><label for="f-student-search">Students</label><span class="field-note">Select the students who will be part of this project.</span><input id="f-student-search" type="search" placeholder="Search students by name or email" autocomplete="off"><div id="f-students" class="project-student-picker" role="group" aria-label="Select students for this project"><div class="muted">Loading students…</div></div><div class="muted" id="f-student-selection-count" aria-live="polite">0 students selected</div></div><div class="full notice"><b>Project assignment rule</b>Each student and adviser can only be assigned to one existing project at a time. People already assigned to a project cannot be selected again. Remove the previous project first if it was created by mistake.</div><div class="full muted" id="f-project-assignment-note"></div></div>`
  }
  if(type==='student-request'){title='Submit defense request';action='student-request';body=`<div class="modal-form"><label class="full">Project<select id="f-project"><option value="">Loading assigned projects…</option></select></label><div id="student-project-note" class="full muted"></div><label>Defense type<select id="f-defense-type"><option>Proposal Defense</option><option>Final Defense</option></select></label><label>Preferred date (MM/DD/YYYY)${dateInputMarkup('f-date')}</label><label>Preferred time<input id="f-time" type="time"></label><label class="full">Reason / notes<textarea id="f-reason" placeholder="Optional details for the reviewer"></textarea></label></div>`}
  if(type==='room'){title='Add room';action='room';body=`<div class="modal-form"><label>Room name<input id="f-name" required></label><label>Capacity (people)<input id="f-capacity" type="number" min="1" max="10000" step="1" value="30" required></label><label class="full">Location<input id="f-location" required></label></div>`}
  if(type==='schedule'){title='Add defense schedule';action='schedule';body=`<div class="modal-form"><label class="full">Project<select id="f-schedule-project"><option value="">Loading projects…</option></select></label><label>Defense type<select id="f-schedule-type"><option>Proposal Defense</option><option>Final Defense</option></select></label><label>Defense date (MM/DD/YYYY)${dateInputMarkup('f-schedule-date')}</label><label>Start time<input id="f-schedule-start" type="time"></label><label>End time<input id="f-schedule-end" type="time"></label><label>Room<select id="f-schedule-room"><option value="">No room assigned</option></select></label><label class="full">Notes<textarea id="f-schedule-notes" placeholder="Optional scheduling notes"></textarea></label><div class="full notice"><b>Manual scheduling</b>This creates a defense schedule directly for the selected project. Approved student requests can still generate schedules automatically.</div></div>`}
  
  if(type==='panel'){title='Assign panel';action='panel';body=`<div class="modal-form"><label class="full">Project<select id="f-panel-project"><option value="">Loading projects…</option></select></label><label class="full">Defense schedule<select id="f-schedule"><option value="">Select a project first</option></select></label><label>Defense date<input id="f-panel-date" type="date" readonly></label><label>Defense time<input id="f-panel-time" type="text" readonly placeholder="Select a defense schedule"></label><label>Person<select id="f-member"></select></label><label>Assignment<select id="f-panel-role"><option>Chairperson</option><option>Panel Member</option><option>Adviser</option></select></label><div class="full notice"><b>Assignment rules</b> Select the project and its defense schedule first. The defense date and time are taken directly from that schedule and cannot be edited here. Chairperson and Panel Member use panel-member accounts. Adviser uses the adviser assigned to the selected project; the Adviser is counted as a required evaluator only when explicitly assigned to this defense.</div></div>`}
  if(type==='evaluation'){title='Submit evaluation';action='evaluation';body=`<div class="modal-form"><label class="full">Assigned defense<select id="f-schedule"></select></label><label>Technical score<input id="f-technical" type="number" min="0" max="100"></label><label>Presentation score<input id="f-presentation" type="number" min="0" max="100"></label><label>Documentation score<input id="f-documentation" type="number" min="0" max="100"></label><label>Recommendation<select id="f-recommendation"><option>Approved</option><option>For Revision</option><option>Re-defense Required</option></select></label><label>Defense result<select id="f-defense-result"><option>Passed</option><option>Failed</option><option>For Revision</option><option>Re-defense Required</option></select></label><label class="full">Comments<textarea id="f-comments"></textarea></label><div class="full notice"><b>Confirmation step</b> Review the scores and comments before you submit. The submission is recorded as the confirmed evaluation.</div></div>`;loadEvaluationOptions()}
  if(type==='feedback'){title='Provide advising feedback';action='feedback';body=`<div class="modal-form"><label class="full">Assigned project<select id="f-project"></select></label><label class="full">Feedback<textarea id="f-feedback" placeholder="Write clear advising feedback and revision points."></textarea></label></div>`;loadFeedbackProjects()}
  wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>${title}</h3><button class="modal-close" data-close-modal>×</button></div>${body}<div class="modal-form"><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-submit-modal="${action}">${type==='evaluation'?'Submit evaluation':'Save'}</button></div></div></div>`;
  document.body.appendChild(wrap);
  if(type==='project') loadProjectPeople().catch(err=>toast(err.message));
  if(type==='schedule'){constrainFutureDateTime($('#f-schedule-date'),$('#f-schedule-start'));loadScheduleCreateOptions().catch(err=>toast(err.message));}
  if(type==='student-request'){constrainFutureDateTime($('#f-date'),$('#f-time'));loadStudentProjects().catch(err=>{const note=$('#student-project-note');if(note)note.textContent=err.message;toast(err.message)});}
  if(type==='panel') loadPanelOptions().catch(err=>toast(err.message));
}
async function openScheduleEdit(id){const d=await api('/api/schedules');const s=d.schedules.find(x=>Number(x.id)===Number(id));if(!s)return toast('Schedule not found.');const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';wrap.innerHTML=`<div class="modal"><div class="modal-head"><div><p class="micro">DEFENSE SCHEDULE</p><h3>Edit schedule</h3></div><button class="modal-close" data-close-modal>×</button></div><div class="modal-form"><label class="full">Project<select id="se-project"></select></label><label>Defense type<select id="se-type"><option>Proposal Defense</option><option>Final Defense</option></select></label><label>Date (MM/DD/YYYY)${dateInputMarkup('se-date',s.defense_date)}</label><label>Start time<input id="se-start" type="time" value="${String(s.start_time).slice(0,5)}"></label><label>End time<input id="se-end" type="time" value="${String(s.end_time).slice(0,5)}"></label><label>Room<select id="se-room"></select></label><label class="full">Notes<textarea id="se-notes">${esc(s.notes||'')}</textarea></label><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveScheduleEdit">Save changes</button></div></div></div>`;document.body.appendChild(wrap);constrainFutureDateTime($('#se-date'),$('#se-start'));const p=await api('/api/projects');$('#se-project').innerHTML=p.projects.map(x=>`<option value="${x.id}" ${Number(x.id)===Number(s.project_id)?'selected':''}>${esc(x.title)}</option>`).join('');$('#se-type').value=s.defense_type;const refreshEditRooms=async()=>{const date=optionalDateInputIso($('#se-date'));const r=await api(`/api/rooms?date=${encodeURIComponent(date)}&start=${encodeURIComponent($('#se-start').value)}&end=${encodeURIComponent($('#se-end').value)}&exclude_id=${encodeURIComponent(id)}`);$('#se-room').innerHTML='<option value="">No room assigned</option>'+(r.rooms||[]).filter(x=>x.is_available||Number(x.id)===Number(s.room_id)).map(x=>`<option value="${x.id}" ${Number(x.id)===Number(s.room_id)?'selected':''} ${x.occupied&&Number(x.id)!==Number(s.room_id)?'disabled':''}>${esc(x.name)} · ${esc(x.location)}${x.occupied&&Number(x.id)!==Number(s.room_id)?' · Occupied':''}</option>`).join('');};await refreshEditRooms();['#se-date','#se-start','#se-end'].forEach(sel=>$(sel)?.addEventListener('change',refreshEditRooms));$('#se-date')?.addEventListener('blur',refreshEditRooms);$('#saveScheduleEdit').onclick=async()=>{try{const date=readDateInput($('#se-date'));const pastError=futureDefenseStartError(date,$('#se-start').value);if(pastError)throw new Error(pastError);await api('/api/schedules/'+id,{method:'PATCH',body:JSON.stringify({project_id:Number($('#se-project').value),defense_type:$('#se-type').value,defense_date:date,start_time:$('#se-start').value,end_time:$('#se-end').value,room_id:Number($('#se-room').value)||null,notes:$('#se-notes').value})});wrap.remove();toast('Schedule updated.');renderView('schedules')}catch(e){toast(e.message)}};}
async function loadProjectPeople(){
  const [a,s]=await Promise.all([api('/api/advisers'),api('/api/students')]);
  const adviser=$('#f-adviser'),students=$('#f-students');
  if(adviser){
    const available=(a.users||[]).filter(u=>!u.assigned_project_title);
    adviser.innerHTML=`<option value="">${available.length?'Select adviser':'No unassigned adviser available'}</option>`+
      (a.users||[]).map(u=>`<option value="${u.id}" ${u.assigned_project_title?'disabled':''}>${esc(u.full_name)} · ${esc(u.email)}${u.assigned_project_title?` — Already assigned: ${esc(u.assigned_project_title)}`:''}</option>`).join('');
  }
  if(students){
    const users=s.users||[];
    const available=users.filter(u=>!u.assigned_project_title);
    students.innerHTML=users.length?users.map(u=>{
      const assigned=!!u.assigned_project_title;
      const searchText=`${u.full_name||''} ${u.email||''}`.toLowerCase();
      return `<label class="project-student-option${assigned?' is-assigned':''}" data-search="${esc(searchText)}"><input type="checkbox" name="project-students" value="${u.id}" ${assigned?'disabled':''}><span class="project-student-copy"><strong>${esc(u.full_name)}</strong><small>${esc(u.email)}${assigned?` · Already assigned to: ${esc(u.assigned_project_title)}`:''}</small></span>${assigned?'<span class="project-student-state">Assigned</span>':''}</label>`;
    }).join(''):'<div class="project-student-empty">No student accounts are available.</div>';
    students.addEventListener('change',updateProjectStudentSelection);
    updateProjectStudentSelection();
    const search=$('#f-student-search');
    search?.addEventListener('input',()=>{
      const query=search.value.trim().toLowerCase();
      students.querySelectorAll('.project-student-option').forEach(row=>{row.classList.toggle('hidden',!String(row.dataset.search||'').includes(query));});
    });
    if(!available.length){
      const note=document.querySelector('#f-project-assignment-note');
      if(note)note.textContent='All student accounts are already assigned to projects. Remove an existing project assignment before selecting those students.';
    }
  }
  const note=document.querySelector('#f-project-assignment-note');
  if(note&&!note.textContent)note.textContent='Each student and adviser can only belong to one project at a time. Students already assigned to another project are shown as unavailable.';
}
function updateProjectStudentSelection(){
  const container=$('#f-students');
  const count=$('#f-student-selection-count');
  if(!container||!count)return;
  const selected=container.querySelectorAll('input[name="project-students"]:checked:not(:disabled)').length;
  count.textContent=`${selected} student${selected===1?'':'s'} selected`;
}
async function loadStudentProjects(){const s=$('#f-project');const note=$('#student-project-note');const submit=document.querySelector('[data-submit-modal="student-request"]');if(submit)submit.disabled=true;const d=await api('/api/my-projects');if(!s)return;if(!d.projects.length){s.innerHTML='<option value="">No assigned project available</option>';s.disabled=true;if(note)note.innerHTML='<span class="notice-inline">You do not have a project assigned yet. A Coordinator must add you to a project before you can request a defense.</span>';if(submit)submit.disabled=true;return;}const available=d.projects.filter(p=>!p.active_defense);s.innerHTML=d.projects.map(p=>{const active=p.active_defense;const detail=active?` — Defense already scheduled: ${dateFmt(active.defense_date)} ${timeFmt(active.start_time)}–${timeFmt(active.end_time)} (${esc(active.display_status)})`:'';return `<option value="${p.id}" ${active?'disabled':''} ${!active&&Number(p.id)===Number(available[0]?.id)?'selected':''}>${esc(p.title)} · ${esc(p.type)} · Adviser: ${esc(p.adviser_name)}${detail}</option>`}).join('');s.disabled=!available.length;if(submit)submit.disabled=!available.length;if(note){if(!available.length){const active=d.projects.find(p=>p.active_defense)?.active_defense;note.innerHTML=`<span class="notice-inline">This project already has an active defense schedule${active?` for ${dateFmt(active.defense_date)} at ${timeFmt(active.start_time)}`:''}. You cannot submit another request until the current defense is completed or cancelled. Check My Schedule for details.</span>`;}else if(d.projects.some(p=>p.active_defense)){note.textContent='Projects with an active defense schedule are disabled. Choose a project without an active defense to continue.';}else{note.textContent=`${available.length} assigned project${available.length===1?'':'s'} available for a defense request.`;}}}
async function loadScheduleCreateOptions(){const p=await api('/api/projects');const pe=$('#f-schedule-project');if(pe)pe.innerHTML=p.projects?.length?p.projects.map(x=>`<option value="${x.id}">${esc(x.title)} · ${esc(x.type||'Project')}</option>`).join(''):'<option value="">No projects available</option>';await refreshScheduleRooms();}
async function refreshScheduleRooms(){const re=$('#f-schedule-room');if(!re)return;const date=optionalDateInputIso($('#f-schedule-date')),start=$('#f-schedule-start')?.value||'',end=$('#f-schedule-end')?.value||'';const r=await api(`/api/rooms?date=${encodeURIComponent(date)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);const rooms=(r.rooms||[]);const hasSlot=!!(date&&start&&end);re.innerHTML='<option value="">No room assigned</option>'+rooms.filter(x=>x.is_available).map(x=>`<option value="${x.id}" ${x.occupied?'disabled':''}>${esc(x.name)} · ${esc(x.location)} · Capacity: ${Number(x.capacity)||'—'}${x.occupied?' · Occupied':''}</option>`).join('');if(hasSlot&&!rooms.some(x=>x.is_available&&!x.occupied))re.innerHTML='<option value="">No rooms available for this time</option>';}
async function loadScheduleOptions(){}
async function loadPanelOptions(){const m=await api('/api/panel-options');const projectEl=$('#f-panel-project');const scheduleEl=$('#f-schedule');if(!projectEl||!scheduleEl)return;const options={panelMembers:m.panelMembers||[],advisers:m.advisers||[]};const schedules=(m.schedules||[]).filter(x=>x.status!=='Cancelled'&&x.status!=='Completed'&&!x.panel_outcome&&x.result_status!=='Finalized');const projects=[...new Map(schedules.map(x=>[Number(x.project_id),{id:Number(x.project_id),title:x.title,type:x.type}])).values()];projectEl.innerHTML=projects.length?projects.map(x=>`<option value="${x.id}">${esc(x.title)} · ${esc(x.type||'Project')}</option>`).join(''):'<option value="">No active defense schedule exists yet</option>';projectEl.disabled=!projects.length;const fillSchedules=()=>{const pid=Number(projectEl.value);const matches=schedules.filter(x=>Number(x.project_id)===pid);scheduleEl.innerHTML=matches.length?matches.map(x=>`<option value="${x.id}">${dateFmt(x.defense_date)} · ${esc(x.title)} · ${timeFmt(x.start_time)}–${timeFmt(x.end_time)}</option>`).join(''):'<option value="">No defense schedule for this project</option>';scheduleEl.disabled=!matches.length;const schedule=matches[0];renderPanelMemberOptions(schedule,options)};projectEl.onchange=fillSchedules;scheduleEl.onchange=()=>{const schedule=schedules.find(x=>Number(x.id)===Number(scheduleEl.value));renderPanelMemberOptions(schedule,options)};fillSchedules();}
function renderPanelMemberOptions(schedule,options){const el=$('#f-member');if(!el)return;const dateEl=$('#f-panel-date');const timeEl=$('#f-panel-time');if(dateEl)dateEl.value=schedule?.defense_date?String(schedule.defense_date).slice(0,10):'';if(timeEl)timeEl.value=schedule?(timeFmt(schedule.start_time)+'–'+timeFmt(schedule.end_time)):'';const adviser=options.advisers.find(a=>Number(a.id)===Number(schedule?.adviser_id));const panels=options.panelMembers||[];const role=$('#f-panel-role')?.value;let html='';if(role==='Adviser'){html=adviser?`<option value="${adviser.id}">${esc(adviser.full_name)} · Adviser</option>`:'<option value="">Assigned adviser unavailable</option>';}else{html=panels.map(u=>`<option value="${u.id}">${esc(u.full_name)} · Panel Member</option>`).join('');}el.innerHTML=html;}
async function loadEvaluationOptions(){const [s,p]=await Promise.all([api('/api/schedules'),api('/api/panels')]);const assigned=new Set((p.assignments||[]).filter(x=>Number(x.user_id)===Number(state.user?.id)).map(x=>Number(x.schedule_id)));const eligible=(s.schedules||[]).filter(x=>x.status!=='Cancelled' && x.result_status!=='Finalized' && x.panel_outcome==='Conducted' && assigned.has(Number(x.id)));setTimeout(()=>{const el=$('#f-schedule');if(el)el.innerHTML=eligible.length?eligible.map(x=>`<option value="${x.id}">${dateFmt(x.defense_date)} · ${esc(x.title)} · ${esc(x.defense_type)}</option>`).join(''):'<option value="">No conducted defenses assigned to you are available for evaluation</option>'},0)}
async function loadFeedbackProjects(){const p=await api('/api/projects');setTimeout(()=>{const el=$('#f-project');if(el)el.innerHTML=p.projects.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('')},0)}

async function submitModal(type){
  try{
    if(type==='user'){await api('/api/users',{method:'POST',body:JSON.stringify({full_name:$('#f-name').value,email:$('#f-email').value,password:$('#f-password').value,role:$('#f-role').value})});toast('Account created.');}
    if(type==='project'){
      const ids=[...$('#f-students').querySelectorAll('input[name="project-students"]:checked:not(:disabled)')].map(input=>Number(input.value)).filter(Number.isSafeInteger);
      if(ids.length<1) throw new Error('Select at least one student for this project.');
      if(!$('#f-adviser').value) throw new Error('Select an available, unassigned adviser.');
      if($('#f-adviser').selectedOptions[0]?.disabled) throw new Error('The selected adviser is already assigned to another project. Choose an unassigned adviser.');
      await api('/api/projects',{method:'POST',body:JSON.stringify({title:$('#f-title').value,type:$('#f-type').value,adviser_id:Number($('#f-adviser').value),student_ids:ids})});
      toast('Project added. Student and adviser assignments were checked.');
    }
    if(type==='student-request'){const projectId=Number($('#f-project').value),date=readDateInput($('#f-date')),time=$('#f-time').value;if(!projectId)throw new Error('Select an assigned project before submitting your request.');const pastError=futureDefenseStartError(date,time);if(pastError)throw new Error(pastError);await api('/api/defense-requests',{method:'POST',body:JSON.stringify({project_id:projectId,defense_type:$('#f-defense-type').value,preferred_date:date,preferred_time:time,reason:$('#f-reason').value})});toast('Defense request submitted.');}
    if(type==='room'){await api('/api/rooms',{method:'POST',body:JSON.stringify({name:$('#f-name').value,location:$('#f-location').value,capacity:Number($('#f-capacity').value)})});toast('Room added.');}
    if(type==='schedule'){
      const payload={project_id:Number($('#f-schedule-project').value),defense_type:$('#f-schedule-type').value,defense_date:readDateInput($('#f-schedule-date')),start_time:$('#f-schedule-start').value,end_time:$('#f-schedule-end').value,room_id:Number($('#f-schedule-room').value)||null,notes:$('#f-schedule-notes').value};
      if(!payload.project_id) throw new Error('Select a project before saving the defense schedule.');
      if(!payload.defense_date||!payload.start_time||!payload.end_time) throw new Error('Enter the defense date, start time, and end time.');
      const pastError=futureDefenseStartError(payload.defense_date,payload.start_time);if(pastError)throw new Error(pastError);
      await api('/api/schedules',{method:'POST',body:JSON.stringify(payload)});
      $('#modal')?.remove();
      toast('Defense schedule saved.');
      await renderView('schedules');
      return;
    }
    if(type==='panel'){await api('/api/panels',{method:'POST',body:JSON.stringify({schedule_id:Number($('#f-schedule').value),user_id:Number($('#f-member').value),panel_role:$('#f-panel-role').value})});toast('Panel assignment saved.');}
    if(type==='evaluation'){const saved=await api('/api/evaluations',{method:'POST',body:JSON.stringify({schedule_id:Number($('#f-schedule').value),technical_score:Number($('#f-technical').value),presentation_score:Number($('#f-presentation').value),documentation_score:Number($('#f-documentation').value),comments:$('#f-comments').value,recommendation:$('#f-recommendation').value,defense_result:$('#f-defense-result').value})});const message=saved.finalizationStatus==='Finalized'?'Evaluation saved. All required evaluators agree, so the final defense result has been recorded.':saved.finalizationStatus==='Awaiting Coordinator'?'All required evaluations are in, but the decisions differ. The Coordinator must review and record the final result.':`Evaluation saved. ${saved.decisionCount}/${saved.expected} evaluator decisions are recorded.`;toast(message);}
    if(type==='feedback'){await api('/api/feedback',{method:'POST',body:JSON.stringify({project_id:Number($('#f-project').value),feedback:$('#f-feedback').value})});toast('Feedback recorded.');}
    $('#modal')?.remove();renderView(state.view);
  }catch(e){toast(e.message)}
}
function openUserEdit(id){
  if(state.role!=='coordinator') return;
  api('/api/users?_='+Date.now()).then(d=>{
    const u=d.users.find(x=>Number(x.id)===Number(id));
    if(!u)return toast('User not found.');
    const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='userEditModal';
    wrap.innerHTML=`<div class="modal profile-modal"><div class="modal-head"><div><p class="micro">ADMINISTRATION</p><h3>Edit user</h3></div><button class="modal-close" data-close-user-edit>×</button></div>
      <form id="userEditForm" class="modal-form profile-edit-form">
        <div class="profile-form-scroll">
          <div class="profile-summary full role-summary-${u.role}"><div class="profile-large-avatar role-avatar-${u.role} ${u.profile_image?'profile-preview-trigger':''}"${u.profile_image?` role="button" tabindex="0" data-profile-preview="${esc(`/api/users/${u.id}/profile-image?v=${Date.now()}`)}" data-profile-preview-alt="${esc(u.full_name)} profile picture" aria-label="View ${esc(u.full_name)} profile picture"`:''}>${u.profile_image?`<img src="/api/users/${u.id}/profile-image?v=${Date.now()}" alt="${esc(u.full_name)} profile picture" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="avatar-fallback" style="display:none">${esc(initials(u.full_name))}</span>`:esc(initials(u.full_name))}</div><div><b>${esc(roleLabel(u.role))}</b><span>Coordinator-managed account</span></div></div>
          <label>Full name<input id="ue-name" value="${esc(u.full_name)}" required></label>
          <label>Email address<input id="ue-email" type="email" value="${esc(u.email)}" required></label>
          <label>Role<select id="ue-role"><option value="student">Student</option><option value="adviser">Adviser</option><option value="panel_member">Panel Member</option><option value="coordinator">Coordinator / Administrator</option></select></label>
          <div class="password-divider full"><span>Optional password reset</span></div>
          <label class="full">New password<input id="ue-password" type="password" autocomplete="new-password" placeholder="Leave blank to keep current password"></label>
        </div>
        <div class="modal-actions"><button type="button" class="btn" data-close-user-edit>Cancel</button><button type="submit" class="btn primary">Save user</button></div>
      </form></div>`;
    document.body.appendChild(wrap);
    if($('#ue-role')) $('#ue-role').value=u.role;
    $('#userEditForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/users/'+u.id,{method:'PATCH',body:JSON.stringify({full_name:$('#ue-name').value,email:$('#ue-email').value,password:$('#ue-password').value,role:$('#ue-role').value})});wrap.remove();toast('User account updated.');renderView('users')}catch(err){toast(err.message)}};
  }).catch(err=>toast(err.message));
}

function openProfile(){
  const u=state.user;
  const coordinator=state.role==='coordinator';
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='profileModal';
  wrap.innerHTML=`<div class="modal profile-modal"><div class="modal-head"><div><p class="micro">ACCOUNT</p><h3>My profile</h3></div><button class="modal-close" data-close-profile>×</button></div>
    <form id="profileForm" class="modal-form profile-edit-form">
      <div class="profile-form-scroll">
        <div class="profile-summary full role-summary-${u.role}"><div class="profile-large-avatar role-avatar-${u.role} ${u.profile_image?'profile-preview-trigger':''}" id="profileAvatarPreview"${u.profile_image?` role="button" tabindex="0" data-profile-preview="${esc(u.profile_image)}" data-profile-preview-alt="Profile picture" aria-label="View profile picture"`:''}>${u.profile_image?`<img src="${esc(u.profile_image)}" alt="Profile picture"><span class="avatar-fallback" style="display:none">${esc(initials(u.full_name))}</span>`:esc(initials(u.full_name))}</div><div><b>${esc(roleLabel(u.role))}</b><span>${coordinator?'Coordinator accounts can update their own identity details.':'Name and email are managed by the Coordinator / Administrator.'}</span></div></div>
        <label class="full">Profile picture
          <div class="profile-upload-row">
            <input id="p-image" type="file" accept="image/png,image/jpeg,image/webp">
            ${u.profile_image?'<button type="button" class="btn danger-outline" id="remove-profile-image">Remove picture</button>':''}
          </div>
          <small class="field-note">PNG, JPG, or WebP. Maximum 600 KB.</small>
        </label>
        <label>Full name<input id="p-name" value="${esc(u.full_name)}" ${coordinator?'':'readonly'} required></label>
        <label>Email address<input id="p-email" type="email" value="${esc(u.email)}" ${coordinator?'':'readonly'} required></label>
        <div class="password-divider full"><span>Password</span></div>
        <label>Current password<input id="p-current" type="password" autocomplete="current-password" placeholder="Required only to change password"></label>
        <label>New password<input id="p-new" type="password" autocomplete="new-password" placeholder="Leave blank to keep current"></label>
        <label class="full">Confirm new password<input id="p-confirm" type="password" autocomplete="new-password" placeholder="Re-enter the new password"></label>
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-close-profile>Cancel</button><button type="submit" class="btn primary">Save changes</button></div>
    </form></div>`;
  document.body.appendChild(wrap);
  let removeProfileImage=false;
  $('#p-image').onchange=()=>{
    const file=$('#p-image').files?.[0]; if(!file)return;
    removeProfileImage=false;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('Use a PNG, JPG, or WebP image.');$('#p-image').value='';return;}
    if(file.size>600*1024){toast('Profile image must be 600 KB or smaller.');$('#p-image').value='';return;}
    const reader=new FileReader(); reader.onload=()=>$('#profileAvatarPreview').innerHTML=`<img src="${reader.result}" alt="Profile picture">`; reader.readAsDataURL(file);
  };
  $('#remove-profile-image')?.addEventListener('click',()=>{
    removeProfileImage=true;
    $('#p-image').value='';
    $('#profileAvatarPreview').textContent=initials(u.full_name);
    toast('Profile picture will be removed when you save.');
  });
  $('#profileForm').onsubmit=async (e)=>{
    e.preventDefault();
    const submit=e.submitter||$('#profileForm button[type=submit]');
    const newPass=$('#p-new').value.trim(), confirm=$('#p-confirm').value.trim();
    if(newPass!==confirm){toast('New passwords do not match.');return;}
    if(coordinator && (!$('#p-name').value.trim() || !$('#p-email').value.trim())){toast('Name and email are required.');return;}
    try{
      if(submit){submit.disabled=true;submit.textContent='Saving…';}
      const payload={current_password:$('#p-current').value,new_password:newPass};
      if(coordinator){payload.full_name=$('#p-name').value.trim();payload.email=$('#p-email').value.trim();}
      const file=$('#p-image').files?.[0];
      if(removeProfileImage) payload.profile_image=null;
      else if(file){ payload.profile_image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Unable to read the selected profile image.'));reader.readAsDataURL(file);}); }
      const d=await api('/api/profile',{method:'PATCH',body:JSON.stringify(payload)});
      if(!d?.user) throw new Error('The server did not return the updated account.');
      state.user=d.user;
      showApp();
      wrap.remove();
      toast('Profile updated successfully.');
    }catch(err){
      if(submit){submit.disabled=false;submit.textContent='Save changes';}
      toast(err?.message||'Unable to save profile.');
    }
  };
}
async function openResubmitRequest(id){const d=await api('/api/defense-requests');const r=d.requests.find(x=>Number(x.id)===Number(id));if(!r)return toast('Request not found.');const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>Revise & resubmit request</h3><button class="modal-close" data-close-modal>×</button></div><div class="modal-form"><div class="full notice"><b>${esc(r.title)}</b><br>${esc(r.review_feedback||'')}</div><label>Preferred date (MM/DD/YYYY)${dateInputMarkup('rr-date',r.preferred_date)}</label><label>Preferred time<input id="rr-time" type="time" value="${String(r.preferred_time).slice(0,5)}"></label><label class="full">Reason / revisions<textarea id="rr-reason">${esc(r.reason||'')}</textarea></label><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="rr-send">Resubmit request</button></div></div></div>`;document.body.appendChild(wrap);constrainFutureDateTime($('#rr-date'),$('#rr-time'));$('#rr-send').onclick=async()=>{try{const date=readDateInput($('#rr-date'));const pastError=futureDefenseStartError(date,$('#rr-time').value);if(pastError)throw new Error(pastError);await api('/api/defense-requests/'+id+'/resubmit',{method:'PATCH',body:JSON.stringify({preferred_date:date,preferred_time:$('#rr-time').value,reason:$('#rr-reason').value})});wrap.remove();toast('Defense request resubmitted.');renderView('requests')}catch(e){toast(e.message)}};}
async function openScheduleForRequest(requestId){
  const d=await api('/api/defense-requests');
  const reqr=(d.requests||[]).find(r=>Number(r.id)===Number(requestId));
  if(!reqr)return toast('Defense request not found.');
  if(reqr.status!=='Approved')return toast('Only requests marked ready for scheduling can be scheduled manually.');
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';
  wrap.innerHTML=`<div class="modal"><div class="modal-head"><div><p class="micro">READY FOR SCHEDULING</p><h3>Create defense schedule</h3></div><button class="modal-close" data-close-modal>×</button></div><div class="modal-form"><div class="full notice"><b>${esc(reqr.title)}</b><br>${esc(reqr.defense_type)} · Student preferred ${dateFmt(reqr.preferred_date)} · ${timeFmt(reqr.preferred_time)}</div><label class="full">Project<input id="rq-project" value="${esc(reqr.title)}" readonly></label><label>Defense type<select id="rq-type"><option>Proposal Defense</option><option>Final Defense</option></select></label><label>Defense date (MM/DD/YYYY)${dateInputMarkup('rq-date',reqr.preferred_date)}</label><label>Start time<input id="rq-start" type="time" value="${String(reqr.preferred_time).slice(0,5)}"></label><label>End time<input id="rq-end" type="time"></label><label>Room<select id="rq-room" required><option value="">Select room</option></select></label><label class="full">Notes<textarea id="rq-notes" placeholder="Optional scheduling notes"></textarea></label><div class="full notice"><b>Coordinator-controlled schedule</b>You choose the final defense date, time, and room here. The student’s preferred date/time is only the starting value.</div><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveRequestSchedule">Create schedule</button></div></div></div>`;
  document.body.appendChild(wrap);
  $('#rq-type').value=reqr.defense_type;
  constrainFutureDateTime($('#rq-date'),$('#rq-start'));
  const defaultEnd=()=>{const raw=$('#rq-start')?.value||'';if(!raw)return;const [h,m]=raw.split(':').map(Number);const total=h*60+m+120;if(total>=1440){$('#rq-end').value='23:59';return;}$('#rq-end').value=`${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`};
  defaultEnd();
  const refreshRooms=async()=>{const date=optionalDateInputIso($('#rq-date')),start=$('#rq-start').value,end=$('#rq-end').value;const r=await api(`/api/rooms?date=${encodeURIComponent(date)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);const rooms=r.rooms||[];$('#rq-room').innerHTML='<option value="">Select room</option>'+rooms.filter(x=>x.is_available).map(x=>`<option value="${x.id}" ${x.occupied?'disabled':''}>${esc(x.name)} · ${esc(x.location)} · Capacity: ${Number(x.capacity)||'—'}${x.occupied?' · Occupied':''}</option>`).join('');};
  ['#rq-date','#rq-start','#rq-end'].forEach(sel=>$(sel)?.addEventListener('change',()=>{if(sel==='#rq-start')defaultEnd();refreshRooms().catch(e=>toast(e.message))}));$('#rq-date')?.addEventListener('blur',()=>refreshRooms().catch(e=>toast(e.message)));
  await refreshRooms();
  $('#saveRequestSchedule').onclick=async()=>{try{const date=readDateInput($('#rq-date')),start=$('#rq-start').value,end=$('#rq-end').value;if(!date||!start||!end)throw new Error('Enter the defense date, start time, and end time.');const pastError=futureDefenseStartError(date,start);if(pastError)throw new Error(pastError);if(!$('#rq-room').value)throw new Error('Select a room before creating the defense schedule.');await api('/api/schedules',{method:'POST',body:JSON.stringify({project_id:Number(reqr.project_id),request_id:Number(reqr.id),defense_type:$('#rq-type').value,defense_date:date,start_time:start,end_time:end,room_id:Number($('#rq-room').value)||null,notes:$('#rq-notes').value})});wrap.remove();toast('Defense schedule created by the Coordinator.');renderView('schedules')}catch(e){toast(e.message)}};
}

function openClarificationResolve(id){const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>Resolve clarification</h3><button class="modal-close" data-close-modal>×</button></div><div class="modal-form"><label class="full">Response<textarea id="cr-note" placeholder="Provide a clear response to the student's question."></textarea></label><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="cr-save">Mark resolved</button></div></div></div>`;document.body.appendChild(wrap);$('#cr-save').onclick=async()=>{try{await api('/api/result-clarifications/'+id,{method:'PATCH',body:JSON.stringify({resolution_note:$('#cr-note').value})});wrap.remove();toast('Clarification resolved.');renderView('projects')}catch(e){toast(e.message)}};}
function openReviewModal(id, approving){
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='reviewModal';
  const returnOptions=['Please revise and resubmit','Missing or incomplete requirements','Preferred date/time needs adjustment','Additional adviser/coordinator review required','Other'];
  wrap.innerHTML=`<div class="modal"><div class="modal-head"><div><p class="micro">DEFENSE REQUEST</p><h3>${approving?'Approve request':'Return request'}</h3></div><button class="modal-close" data-close-review>×</button></div><div class="modal-form">
  ${approving?`<label class="full">Approval action<select id="review-action"><option value="ready">Approved — ready for scheduling</option><option value="proceed">Approved — proceed to defense</option></select></label><label class="full">Feedback / note<textarea id="review-feedback-text" placeholder="Write the coordinator's feedback or note for the student."></textarea></label>`:`<label class="full">Feedback<textarea id="review-feedback-text" placeholder="Write the reason or feedback for returning this request."></textarea></label>`}
  <div class="full notice"><b>${approving?'Coordinator scheduling control':'Request returned'}</b>${approving?'Choose “ready for scheduling” to leave date/time selection to the Coordinator. Choose “proceed to defense” only when you want the system to automatically create the defense schedule from the student’s preferred date and time. Room and panel assignment remain Coordinator-controlled.':'Returning the request removes it from the review queue and sends the selected feedback back to the student.'}</div>
  <div class="modal-actions"><button class="btn" data-close-review>Cancel</button><button class="btn primary" id="reviewSubmit">${approving?'Approve':'Return Request'}</button></div></div></div>`;
  document.body.appendChild(wrap);
  const feedbackEl=$('#review-feedback-text');
  $('#reviewSubmit').onclick=async()=>{
    try{
      const action=approving?$('#review-action').value:null;
      const feedback=feedbackEl?.value.trim()||'';
      if(!approving && !feedback)throw new Error('Please enter feedback when returning the request.');
      const result=await api(`/api/defense-requests/${id}/review`,{method:'PATCH',body:JSON.stringify({status:approving?'Approved':'Returned',feedback,schedule_now:approving&&action==='proceed'})});
      wrap.remove();
      toast(approving?(result.scheduledAutomatically?'Request approved and automatically scheduled.':'Request approved and marked ready for Coordinator scheduling.'):'Request returned with feedback.');
      renderView(state.view);
    }catch(err){toast(err.message)}
  };
}

function confirmModal(title,text,yesText,action){const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modalConfirm';wrap.innerHTML=`<div class="modal"><div class="confirm-box"><div class="confirm-icon">✓</div><h4>${esc(title)}</h4><p>${esc(text)}</p><div class="modal-actions"><button class="btn" data-close-confirm>Cancel</button><button class="btn primary" data-confirm-action="${action}">${esc(yesText)}</button></div></div></div>`;document.body.appendChild(wrap)}

async function showReport(kind){try{const d=await api('/api/reports/'+kind);const rows=d.rows||[];const names={"defense-schedule":'Defense Schedule Report',"panel-assignment":'Panel Assignment Report',"student-status":'Student Status Report',evaluation:'Evaluation Report'};const keys=rows.length?Object.keys(rows[0]):[];$('#reportResult').innerHTML=`<div class="panel-head"><div><h3>${names[kind]||'Report'}</h3><span>${rows.length} record${rows.length===1?'':'s'}</span></div><button class="btn" data-report-export="${kind}">Export CSV</button></div><div class="panel-body table-wrap"><table class="data-table"><thead><tr>${keys.map(k=>`<th>${esc(k.replaceAll('_',' '))}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${keys.map(k=>`<td>${esc(r[k]??'—')}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${Math.max(1,keys.length)}"><div class="empty">No data available.</div></td></tr>`}</tbody></table></div>`;}catch(e){toast(e.message)}}
function exportRows(rows,filename){if(!rows.length){toast('No report data to export.');return;}const keys=Object.keys(rows[0]);const csv=[keys,...rows.map(r=>keys.map(k=>r[k]??''))].map(row=>row.map(x=>`"${String(x).replaceAll('\"','\"\"')}"`).join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=filename;a.click();URL.revokeObjectURL(a.href)}
async function exportSummary(){const kinds=['defense-schedule','panel-assignment','student-status','evaluation'];for(const k of kinds){const d=await api('/api/reports/'+k);exportRows(d.rows||[],`report-${k}.csv`)}toast('Reports exported.')}

// Role selection and login flow
const ROLE_ACCESS = {
  student: { purpose:'STUDENT ACCESS', title:'MANAGE YOUR DEFENSE', tagline:'Submit defense requests, view your schedule, and check your recorded result.' },
  adviser: { purpose:'ADVISER ACCESS', title:'MONITOR YOUR PROJECT', tagline:'View assigned students, track project status, and provide evaluation/comments when assigned.' },
  panel_member: { purpose:'PANEL MEMBER ACCESS', title:'EVALUATE ASSIGNED DEFENSES', tagline:'View only assigned defenses, submit evaluations, and add comments or recommendations.' },
  coordinator: { purpose:'COORDINATOR ACCESS', title:'MANAGE DEFENSE OPERATIONS', tagline:'Manage users, projects, schedules, rooms, panel assignments, conflicts, and reports.' }
};
function applyLoginRoleCopy(role){
  const copy=ROLE_ACCESS[role]||ROLE_ACCESS.student;
  $('#loginRolePurpose').textContent=copy.purpose;
  $('#loginAccessTitle').textContent=copy.title;
  $('#loginAccessTagline').textContent=copy.tagline;
}
$$('.hero-role').forEach(btn=>btn.addEventListener('click',()=>{state.role=btn.dataset.role;applyRoleTheme(state.role);applyLoginRoleCopy(state.role);$$('.hero-role').forEach(x=>x.classList.remove('selected'));btn.classList.add('selected');$('#roleStep').classList.remove('active');$('#loginStep').classList.add('active');$('#loginRole').value=state.role;$('#selectedRole').textContent=roleLabel(state.role)}));
$('#changeRole').addEventListener('click',()=>{$('#loginStep').classList.remove('active');$('#roleStep').classList.add('active')});
$('#togglePassword').addEventListener('click',()=>{const p=$('#password');p.type=p.type==='password'?'text':'password';$('#togglePassword').textContent=p.type==='password'?'Show':'Hide'});
$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const submit=$('#loginForm button[type=submit]');
  const originalText=submit?.innerHTML;
  if(submit){submit.disabled=true;submit.textContent='SIGNING IN…';}
  try{
    const d=await api('/api/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value,role:$('#loginRole').value})});
    // Confirm the server persisted the session before switching away from login.
    const session=await api('/api/session');
    if(!session.user)throw new Error('Your credentials were accepted, but the sign-in session was not saved. Check that cookies are enabled, then try again.');
    state.user=session.user;
    state.role=session.user.role;
    csrfToken=d.csrfToken||csrfToken;
    showApp();
    toast(`Welcome, ${state.user.full_name.split(' ')[0]}.`);
  }catch(err){toast(err.message||'Unable to sign in. Please try again.');}
  finally{if(submit){submit.disabled=false;submit.innerHTML=originalText||'SIGN IN';}}
});

const heroMenuToggle=$('#heroMenuToggle'), heroMobileMenu=$('#heroMobileMenu');
function setHeroMenu(open){if(!heroMenuToggle||!heroMobileMenu)return;heroMenuToggle.classList.toggle('is-open',open);heroMenuToggle.setAttribute('aria-expanded',String(open));heroMenuToggle.setAttribute('aria-label',open?'Close menu':'Open menu');heroMobileMenu.classList.toggle('is-open',open);heroMobileMenu.setAttribute('aria-hidden',String(!open));if(open){heroMobileMenu.removeAttribute('inert');document.body.classList.add('menu-open');}else{heroMobileMenu.setAttribute('inert','');document.body.classList.remove('menu-open');}}
heroMenuToggle?.addEventListener('click',()=>setHeroMenu(!heroMenuToggle.classList.contains('is-open')));
heroMobileMenu?.addEventListener('click',e=>{if(e.target===heroMobileMenu)setHeroMenu(false); if(e.target.closest('a'))setHeroMenu(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&heroMenuToggle?.classList.contains('is-open')){setHeroMenu(false);heroMenuToggle.focus();}});
window.addEventListener('resize',()=>{if(window.innerWidth>900)setHeroMenu(false);});

// App actions
document.addEventListener('click',async e=>{
  const preview=e.target.closest('[data-profile-preview]');
  if(preview){
    e.preventDefault();
    e.stopPropagation();
    openImagePreview(preview.dataset.profilePreview,preview.dataset.profilePreviewAlt||'Profile picture');
    return;
  }
  if(e.target.closest('[data-close-image-preview]') || e.target.id==='imagePreviewModal'){
    e.preventDefault();
    $('#imagePreviewModal')?.remove();
    return;
  }
  const view=e.target.closest('[data-view]')?.dataset.view;if(view){if(window.innerWidth<=1080){$('#sidebar').classList.remove('open');$('#scrim').classList.remove('show')}return renderView(view)}
  if(e.target.closest('[data-modal]'))return openModal(e.target.closest('[data-modal]').dataset.modal);
  if(e.target.closest('[data-close-modal]'))return $('#modal')?.remove();
  if(e.target.closest('[data-close-confirm]'))return $('#modalConfirm')?.remove();
  if(e.target.closest('[data-close-profile]'))return $('#profileModal')?.remove();
  if(e.target.closest('[data-close-review]'))return $('#reviewModal')?.remove();
  if(e.target.closest('[data-close-user-edit]'))return $('#userEditModal')?.remove();
  const scheduleEdit=e.target.closest('[data-schedule-edit]');if(scheduleEdit){openScheduleEdit(scheduleEdit.dataset.scheduleEdit);return;}
  const panelDelete=e.target.closest('[data-panel-delete]');if(panelDelete){confirmModal('Remove panel assignment?','The person will be unassigned from this defense.','Remove',`panelDelete:${panelDelete.dataset.panelDelete}`);return;}
  const roomEdit=e.target.closest('[data-room-edit]');if(roomEdit){openRoomEdit(roomEdit.dataset.roomEdit);return;}
  const roomDelete=e.target.closest('[data-room-delete]');if(roomDelete){confirmModal('Delete this room?','Rooms assigned to active defenses cannot be deleted.','Delete',`roomDelete:${roomDelete.dataset.roomDelete}`);return;}
  const reqResubmit=e.target.closest('[data-resubmit-request]');if(reqResubmit){openResubmitRequest(Number(reqResubmit.dataset.resubmitRequest));return;}
  const feedbackResubmit=e.target.closest('[data-feedback-resubmit]');if(feedbackResubmit){api(`/api/feedback/${feedbackResubmit.dataset.feedbackResubmit}/student-response`,{method:'PATCH'}).then(()=>{toast('Revision marked as resubmitted.');renderView('projects')}).catch(err=>toast(err.message));return;}
  const finalizeResult=e.target.closest('[data-finalize-result]');if(finalizeResult){openFinalizeResultModal(Number(finalizeResult.dataset.finalizeResult));return;}
  if(e.target.closest('[data-close-final-result]')){e.target.closest('#finalResultModal')?.remove();return;}
  const report=e.target.closest('[data-report]');if(report){showReport(report.dataset.report);return;}
  const reportExport=e.target.closest('[data-report-export]');if(reportExport){api('/api/reports/'+reportExport.dataset.reportExport).then(d=>exportRows(d.rows||[],`report-${reportExport.dataset.reportExport}.csv`)).catch(err=>toast(err.message));return;}
  const projectDelete=e.target.closest('[data-project-delete]');if(projectDelete){confirmModal('Remove this project?','This permanently removes the project and its linked defense requests, schedules, panel assignments, evaluations, and feedback.','Remove project',`deleteProject:${projectDelete.dataset.projectDelete}`);return;}
  const editUser=e.target.closest('[data-user-edit]');if(editUser){openUserEdit(editUser.dataset.userEdit);return}
  const deleteUser=e.target.closest('[data-user-delete]');if(deleteUser){confirmModal('Delete this account?','This permanently removes the user account and related assignments/evaluations. This action cannot be undone.','Delete',`deleteUser:${deleteUser.dataset.userDelete}`);return}
  if(e.target.closest('[data-submit-modal]'))return submitModal(e.target.closest('[data-submit-modal]').dataset.submitModal);
  if(e.target.closest('[data-action="logout"]')){await api('/api/logout',{method:'POST'});location.reload();return}
  const scheduleRequest=e.target.closest('[data-schedule-request]');if(scheduleRequest){openScheduleForRequest(Number(scheduleRequest.dataset.scheduleRequest));return}
  const review=e.target.closest('[data-review]');if(review){openReviewModal(Number(review.dataset.review),review.dataset.reviewStatus==='approve');return}
  const proceed=e.target.closest('[data-proceed]');if(proceed){confirmModal('Proceed with defense?','Confirm that you will proceed with the assigned defense at its scheduled time.','Proceed',`proceed:${proceed.dataset.proceed}`);return}
  const panelOutcome=e.target.closest('[data-panel-outcome]');if(panelOutcome){const outcome=panelOutcome.dataset.outcome;const conducted=outcome==='Conducted';confirmModal(conducted?'Confirm defense conducted?':'Report defense not conducted?',conducted?'Confirm that this defense actually took place. This will unlock the evaluation form.':'Confirm that this defense did not take place. The coordinator will need to review and arrange the next step.',conducted?'Confirm Conducted':'Report Not Conducted',`outcome:${panelOutcome.dataset.panelOutcome}:${conducted?'Conducted':'NotConducted'}`);return}
  const resch=e.target.closest('[data-reschedule]');if(resch){openReschedule(resch.dataset.reschedule);return}
  const cancel=e.target.closest('[data-cancel]');if(cancel){confirmModal('Cancel this schedule?','The schedule will be marked cancelled.','Cancel schedule',`cancel:${cancel.dataset.cancel}`);return}
  const user=e.target.closest('[data-user-toggle]');if(user){confirmModal(user.dataset.active==='true'?'Deactivate account?':'Activate account?','The account status will change immediately.','Confirm',`user:${user.dataset.userToggle}:${user.dataset.active!=='true'}`);return}
  const rs=e.target.closest('[data-resched-review]');if(rs){api(`/api/reschedule-requests/${rs.dataset.reschedReview}`,{method:'PATCH',body:JSON.stringify({status:rs.dataset.status})}).then(()=>{toast('Reschedule request updated.');renderView('schedules')}).catch(err=>toast(err.message));return}
  const fsat=e.target.closest('[data-feedback-satisfied]');if(fsat){api(`/api/feedback/${fsat.dataset.feedbackSatisfied}/satisfaction`,{method:'PATCH',body:JSON.stringify({status:'Satisfied'})}).then(()=>{toast('Feedback marked satisfied.');renderView('projects')}).catch(err=>toast(err.message));return}
  const clarify=e.target.closest('[data-clarify]');if(clarify){openClarify(clarify.dataset.clarify);return}
  if(e.target.closest('[data-export]'))return exportSummary();
  if(e.target.closest('[data-confirm-action]')){
    const action=e.target.closest('[data-confirm-action]').dataset.confirmAction;$('#modalConfirm')?.remove();
    try{
      const [kind,a,b]=action.split(':');
      if(kind==='proceed'){await api(`/api/schedules/${a}/proceed`,{method:'POST'});toast('Defense marked to proceed.');await renderView('schedules');}
      if(kind==='outcome'){const outcome=b==='Conducted'?'Conducted':'Not Conducted';await api(`/api/schedules/${a}/outcome`,{method:'POST',body:JSON.stringify({outcome})});toast(outcome==='Conducted'?'Defense confirmed as conducted. Evaluation is now available.':'Defense reported as not conducted. The coordinator can review the report.');await renderView('schedules');}
      if(kind==='cancel'){await api(`/api/schedules/${a}/cancel`,{method:'PATCH'});toast('Schedule cancelled.');renderView('schedules')}
      if(kind==='user'){await api(`/api/users/${a}/status`,{method:'PATCH',body:JSON.stringify({is_active:b==='true'})});toast('Account status updated.');renderView('users')}
      if(kind==='deleteUser'){await api(`/api/users/${a}`,{method:'DELETE'});toast('User account deleted.');renderView('users')}
      if(kind==='deleteProject'){await api(`/api/projects/${a}`,{method:'DELETE'});toast('Project removed.');renderView('projects')}
      if(kind==='panelDelete'){await api(`/api/panels/${a}`,{method:'DELETE'});toast('Panel assignment removed.');renderView('panels')}
      if(kind==='roomDelete'){await api(`/api/rooms/${a}`,{method:'DELETE'});toast('Room deleted.');renderView('rooms')}
    }catch(err){toast(err.message)}
  }
});
document.addEventListener('keydown',e=>{
  const preview=e.target.closest?.('[data-profile-preview]');
  if(preview && (e.key==='Enter'||e.key===' ')){
    e.preventDefault();
    e.stopPropagation();
    openImagePreview(preview.dataset.profilePreview,preview.dataset.profilePreviewAlt||'Profile picture');
    return;
  }
  if(e.key==='Escape') $('#imagePreviewModal')?.remove();
});

document.addEventListener('change',async e=>{
  const panelRole=e.target.closest('#f-panel-role');if(panelRole){const scheduleId=Number($('#f-schedule')?.value);if(scheduleId){const [sd,opts]=await Promise.all([api('/api/schedules'),api('/api/panel-options')]);const schedule=(sd.schedules||[]).find(x=>Number(x.id)===scheduleId);renderPanelMemberOptions(schedule,opts);}}
  const ps=e.target.closest('[data-project-status]');if(ps){try{await api(`/api/projects/${ps.dataset.projectStatus}/status`,{method:'PATCH',body:JSON.stringify({status:ps.value})});toast('Project status updated.');renderView('projects')}catch(err){toast(err.message)}}
  const room=e.target.closest('[data-room]');if(room){try{await api(`/api/rooms/${room.dataset.room}`,{method:'PATCH',body:JSON.stringify({is_available:room.checked})});toast('Room availability updated.')}catch(err){toast(err.message)}}
  if(e.target.matches('#f-schedule-date,#f-schedule-start,#f-schedule-end')){refreshScheduleRooms().catch(err=>toast(err.message));}
  const week=e.target.closest('[data-week-status]');if(week){const progress=week.value==='Completed'?100:week.value==='In Progress'?50:week.value==='At Risk'?25:0;try{await api(`/api/weekly/${week.dataset.weekStatus}`,{method:'PATCH',body:JSON.stringify({status:week.value,progress})});toast('Weekly tracker updated.');renderView('management')}catch(err){toast(err.message)}}
});
async function openRoomEdit(id){const d=await api('/api/rooms');const r=d.rooms.find(x=>Number(x.id)===Number(id));if(!r)return toast('Room not found.');const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modal';wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>Edit room</h3><button class="modal-close" data-close-modal>×</button></div><div class="modal-form"><label>Room name<input id="re-name" value="${esc(r.name)}" required></label><label>Capacity (people)<input id="re-capacity" type="number" min="1" max="10000" step="1" value="${Number(r.capacity)||30}" required></label><label class="full">Location<input id="re-location" value="${esc(r.location)}" required></label><div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" id="saveRoomEdit">Save</button></div></div></div>`;document.body.appendChild(wrap);$('#saveRoomEdit').onclick=async()=>{try{await api('/api/rooms/'+id,{method:'PATCH',body:JSON.stringify({name:$('#re-name').value,location:$('#re-location').value,capacity:Number($('#re-capacity').value)})});wrap.remove();toast('Room updated.');renderView('rooms')}catch(e){toast(e.message)}};}
async function openReschedule(scheduleId){const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modalReschedule';wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>Request reschedule</h3><button class="modal-close" data-close-reschedule>×</button></div><div class="modal-form"><label>Preferred date (MM/DD/YYYY)${dateInputMarkup('r-date')}</label><label>Preferred time<input id="r-time" type="time"></label><label class="full">Reason<textarea id="r-reason" placeholder="Explain why the defense cannot proceed at the scheduled time."></textarea></label><div class="modal-actions"><button class="btn" data-close-reschedule>Cancel</button><button class="btn primary" id="rescheduleSend">Submit request</button></div></div></div>`;document.body.appendChild(wrap);constrainFutureDateTime($('#r-date'),$('#r-time'));$('#rescheduleSend').onclick=async()=>{try{const date=readDateInput($('#r-date'));const pastError=futureDefenseStartError(date,$('#r-time').value);if(pastError)throw new Error(pastError);await api('/api/reschedule-requests',{method:'POST',body:JSON.stringify({schedule_id:Number(scheduleId),preferred_date:date,preferred_time:$('#r-time').value,reason:$('#r-reason').value})});toast('Reschedule request submitted.');wrap.remove();renderView('schedules')}catch(err){toast(err.message)}}}
function openClarify(scheduleId){const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.id='modalClarify';wrap.innerHTML=`<div class="modal"><div class="modal-head"><h3>Result clarification</h3><button class="modal-close" data-close-clarify>×</button></div><div class="modal-form"><label class="full">Message<textarea id="c-message" placeholder="Describe what you would like clarified about the recorded result."></textarea></label><div class="modal-actions"><button class="btn" data-close-clarify>Cancel</button><button class="btn primary" id="clarifySend">Send to adviser</button></div></div></div>`;document.body.appendChild(wrap);$('#clarifySend').onclick=async()=>{try{await api('/api/result-clarifications',{method:'POST',body:JSON.stringify({schedule_id:Number(scheduleId),message:$('#c-message').value})});toast('Clarification request sent.');wrap.remove()}catch(err){toast(err.message)}}}
function applyLightTheme(){
  // Clear any old persisted dark-mode state from previous versions.
  document.body.classList.remove('dark-mode');
  try { localStorage.removeItem('defense-theme'); } catch { /* storage may be unavailable */ }
}

applyLightTheme();

$('#openSidebar').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#scrim').classList.add('show')});$('#closeSidebar').addEventListener('click',()=>{$('#sidebar').classList.remove('open');$('#scrim').classList.remove('show')});$('#scrim').addEventListener('click',()=>{$('#sidebar').classList.remove('open');$('#scrim').classList.remove('show')});

(async function bootstrap(){try{const c=await fetch('/api/csrf');const cd=await c.json().catch(()=>({}));csrfToken=cd.token||'';const s=await api('/api/session');if(s.user){state.user=s.user;state.role=s.user.role;showApp()}}catch{}})();

// Profile picture clickability fix v7
