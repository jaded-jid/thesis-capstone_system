import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET of at least 32 characters is required in production.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false
});
const PgSession = connectPgSimple(session);
const q = (text, params = []) => pool.query(text, params);

const ROLE_LABELS = {
  coordinator: 'Coordinator / Administrator',
  student: 'Student',
  adviser: 'Adviser',
  panel_member: 'Panel Member'
};
const ALLOWED_ROLES = Object.keys(ROLE_LABELS);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: true, legacyHeaders: false }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many unsuccessful sign-in attempts. Please wait 15 minutes before trying again.' } });
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-session-secret-change-me-please',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(requireCsrf);

const publicRoot = path.join(__dirname, 'public');
app.use(express.static(publicRoot, { maxAge: isProd ? '1h' : 0 }));

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}
function cleanEmail(value) {
  return cleanText(value, 180).toLowerCase();
}
function validTime(value) {
  const v = cleanText(value, 20);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
}
function validDate(value) {
  const v = cleanText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y,m,d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d;
}
function validPositiveInt(value) { return Number.isInteger(Number(value)) && Number(value) > 0; }
function normalizeDate(value) { return cleanText(value,20).slice(0,10); }
function timeMinutes(value) { const m=String(value||'').match(/^(\d{2}):(\d{2})/); return m ? Number(m[1])*60+Number(m[2]) : null; }
function validRole(role) {
  return ALLOWED_ROLES.includes(role);
}
function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}
function ensureCsrf(req) { if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex'); return req.session.csrfToken; }
function requireCsrf(req,res,next){ if (['GET','HEAD','OPTIONS'].includes(req.method)) return next(); const token=String(req.get('X-CSRF-Token')||''); if(!token || token!==req.session.csrfToken) return res.status(403).json({error:'Invalid security token. Refresh the page and try again.'}); next(); }
async function audit(userId, action, entityType, entityId, details={}) { try { await q('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,action,entityType,entityId,details]); } catch (e) { console.error('Audit log failed:', e.message); } }
function serializeUser(u) {
  return { id: u.id, full_name: u.full_name, email: u.email, role: u.role, role_label: ROLE_LABELS[u.role], is_active: u.is_active, profile_image: u.profile_image || null };
}

// Keep defense-request status synchronized with the linked defense schedule.
// A completed defense must always have a Completed defense request. This is
// intentionally idempotent so it is safe to run whenever requests are read.
async function syncCompletedDefenseRequests() {
  // 1) Explicitly linked completed schedules always complete their request.
  await q(`
    UPDATE defense_requests dr
    SET status='Completed', review_feedback='Defense completed.', updated_at=NOW()
    WHERE (dr.status <> 'Completed' OR COALESCE(dr.review_feedback,'') <> 'Defense completed.')
      AND EXISTS (
        SELECT 1 FROM schedules s
        WHERE s.request_id = dr.id
          AND s.status = 'Completed'
      )
  `);

  // 2) Repair older/manual completed schedules that were created without a request_id.
  // Because only one active request is allowed per project, matching by project and
  // defense type is safe. Prefer the exact requested date/time when available.
  await q(`
    WITH candidates AS (
      SELECT
        s.id AS schedule_id,
        dr.id AS request_id,
        ROW_NUMBER() OVER (
          PARTITION BY s.id
          ORDER BY
            CASE WHEN dr.preferred_date = s.defense_date
                      AND dr.preferred_time::time = s.start_time THEN 0 ELSE 1 END,
            dr.created_at DESC,
            dr.id DESC
        ) AS rn
      FROM schedules s
      JOIN defense_requests dr
        ON dr.project_id = s.project_id
       AND dr.defense_type = s.defense_type
       AND dr.status IN ('Approved','Scheduled')
      WHERE s.status='Completed'
        AND s.request_id IS NULL
    )
    UPDATE defense_requests dr
    SET status='Completed', review_feedback='Defense completed.', updated_at=NOW()
    FROM candidates c
    WHERE c.rn=1 AND dr.id=c.request_id
  `);

  // 3) When a manual schedule is linked by matching project/type/date/time, persist
  // the relationship so future status changes are unambiguous.
  await q(`
    WITH candidates AS (
      SELECT
        s.id AS schedule_id,
        dr.id AS request_id,
        ROW_NUMBER() OVER (
          PARTITION BY s.id
          ORDER BY
            CASE WHEN dr.preferred_date = s.defense_date
                      AND dr.preferred_time::time = s.start_time THEN 0 ELSE 1 END,
            dr.created_at DESC,
            dr.id DESC
        ) AS rn
      FROM schedules s
      JOIN defense_requests dr
        ON dr.project_id = s.project_id
       AND dr.defense_type = s.defense_type
       AND dr.status IN ('Approved','Scheduled','Completed')
      WHERE s.request_id IS NULL
    )
    UPDATE schedules s
    SET request_id=c.request_id
    FROM candidates c
    WHERE c.rn=1 AND s.id=c.schedule_id
  `);

  // 4) A completed schedule is the source of truth for its request status.
  await q(`
    UPDATE defense_requests dr
    SET status='Completed', review_feedback='Defense completed.', updated_at=NOW()
    WHERE (dr.status <> 'Completed' OR COALESCE(dr.review_feedback,'') <> 'Defense completed.')
      AND EXISTS (
        SELECT 1 FROM schedules s
        WHERE s.request_id=dr.id AND s.status='Completed'
      )
  `);
}

async function ensureColumns() {
  await q(`ALTER TABLE defense_requests ADD COLUMN IF NOT EXISTS review_feedback TEXT`);
  await q(`ALTER TABLE defense_requests DROP CONSTRAINT IF EXISTS defense_requests_status_check`);
  await q(`ALTER TABLE defense_requests ADD CONSTRAINT defense_requests_status_check CHECK (status IN ('Pending','Approved','Returned','Rejected','Scheduled','Completed'))`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS defense_result TEXT`);
  await q(`ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_defense_result_check`);
  await q(`ALTER TABLE schedules ADD CONSTRAINT schedules_defense_result_check CHECK (defense_result IS NULL OR defense_result IN ('Passed','Failed','For Revision','Re-defense Required'))`);
  await q(`ALTER TABLE projects ALTER COLUMN code DROP NOT NULL`);
  await q(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_code_key`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_proceedance TEXT NOT NULL DEFAULT 'Pending'`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_proceeded_at TIMESTAMPTZ`);
  await q(`ALTER TABLE rooms DROP COLUMN IF EXISTS capacity`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS panel_availability TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT`);
  await q(`ALTER TABLE result_clarifications ADD COLUMN IF NOT EXISTS resolution_note TEXT`);
  await q(`WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY project_id ORDER BY created_at,id) rn FROM defense_requests WHERE status IN ('Pending','Approved','Scheduled')) UPDATE defense_requests d SET status='Returned',review_feedback='Superseded duplicate request.',updated_at=NOW() FROM ranked r WHERE d.id=r.id AND r.rn>1`);
  await q(`WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY request_id ORDER BY created_at,id) rn FROM schedules WHERE request_id IS NOT NULL AND status<>'Cancelled') UPDATE schedules s SET status='Cancelled' FROM ranked r WHERE s.id=r.id AND r.rn>1`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS defense_requests_active_project_uq ON defense_requests(project_id) WHERE status IN ('Pending','Approved','Scheduled')`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS schedules_request_active_uq ON schedules(request_id) WHERE request_id IS NOT NULL AND status <> 'Cancelled'`);
  await q(`CREATE INDEX IF NOT EXISTS project_members_student_idx ON project_members(student_id)`);
  await q(`CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type,entity_id)`);
  await q(`INSERT INTO project_members(project_id,student_id) SELECT p.id, x.student_id FROM projects p CROSS JOIN LATERAL unnest(COALESCE(p.student_ids, ARRAY[]::integer[])) AS x(student_id) JOIN users u ON u.id=x.student_id AND u.role='student' WHERE NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=x.student_id) ON CONFLICT DO NOTHING`);
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await q(schema);
  await ensureColumns();

  const adminName = cleanText(process.env.ADMIN_NAME || 'Coordinator', 120);
  const adminEmail = cleanEmail(process.env.ADMIN_EMAIL || 'admin@example.com');
  const adminPassword = String(process.env.ADMIN_PASSWORD || 'ChangeThisPasswordImmediately');
  const adminExists = await q('SELECT id FROM users WHERE lower(email)=lower($1)', [adminEmail]);
  if (!adminExists.rowCount) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await q('INSERT INTO users (full_name,email,password_hash,role) VALUES ($1,$2,$3,\'coordinator\')', [adminName, adminEmail, hash]);
  }

  if (process.env.SEED_DEMO_USERS === 'true') {
    const demos = [
      ['Alyssa M. Santos', 'student1@example.com', 'Student@2026!', 'student'],
      ['Prof. Daniel Cruz', 'adviser1@example.com', 'Adviser@2026!', 'adviser'],
      ['Engr. Maria Reyes', 'panel1@example.com', 'Panel@2026!', 'panel_member']
    ];
    for (const [name, email, password, role] of demos) {
      const exists = await q('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
      if (!exists.rowCount) {
        const hash = await bcrypt.hash(password, 12);
        await q('INSERT INTO users (full_name,email,password_hash,role) VALUES ($1,$2,$3,$4)', [name,email,hash,role]);
      }
    }
  }

  const rooms = [
    ['Room 301', 'Main Building · 3rd Floor', true],
    ['Innovation Lab', 'IT Building · Lab Wing', true],
    ['Conference Room A', 'Administration Building', true]
  ];
  for (const room of rooms) await q('INSERT INTO rooms (name,location,is_available) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING', room);

  const wbs = [
    ['1.0','Requirements gathering, problem analysis, project planning','Aug 12 – Aug 26',true,'Completed'],
    ['1.1','Prepare Project Proposal (problem statement, objectives, scope & limitations)','Aug 12 – Aug 14',false,'Completed'],
    ['1.2','Develop Project Charter and Stakeholder List','Aug 15 – Aug 17',false,'Completed'],
    ['1.3','Prepare WBS, Gantt Chart, Risk Register, Budget Plan','Aug 18 – Aug 20',false,'Completed'],
    ['1.4','Monitor progress and update weekly tracker','Aug 12 – Nov 4',false,'In Progress'],
    ['1.5','Gather requirements from adviser/coordinator','Aug 18 – Aug 21',false,'Completed'],
    ['1.6','Analyze current manual process and problems','Aug 21 – Aug 24',false,'Completed'],
    ['1.7','Finalize System Requirements Specification','Aug 25 – Aug 26',false,'Completed'],
    ['2.0','System design, ERD, database, UI design','Aug 27 – Sep 9',true,'Completed'],
    ['2.1','Design Entity-Relationship Diagram (ERD) and database','Aug 27 – Sep 2',false,'Completed'],
    ['2.2','Design user interface (UI) mockups','Sep 1 – Sep 7',false,'Completed'],
    ['2.3','Design overall system architecture and flow','Sep 4 – Sep 9',false,'Completed'],
    ['3.0','User and project management development','Sep 10 – Sep 23',true,'Planned'],
    ['3.1','Develop User Management module','Sep 10 – Sep 16',false,'Planned'],
    ['3.2','Develop Project Management module','Sep 17 – Sep 23',false,'Planned'],
    ['4.0','Defense request, scheduling, panel assignment','Sep 24 – Oct 7',true,'Planned'],
    ['4.1','Develop Defense Request module','Sep 24 – Sep 29',false,'Planned'],
    ['4.2','Develop Defense Scheduling module','Sep 30 – Oct 4',false,'Planned'],
    ['4.3','Develop Panel Assignment module','Oct 5 – Oct 7',false,'Planned'],
    ['5.0','Room management, conflict detection, evaluation','Oct 7 – Oct 21',true,'Planned'],
    ['5.1','Develop Room Management module','Oct 7 – Oct 12',false,'Planned'],
    ['5.2','Develop Conflict Detection module','Oct 13 – Oct 16',false,'Planned'],
    ['5.3','Develop Evaluation and Reports module','Oct 17 – Oct 21',false,'Planned'],
    ['6.0','Testing, debugging, user acceptance testing','Oct 22 – Oct 28',true,'Planned'],
    ['6.1','Conduct unit testing per module','Oct 22 – Oct 24',false,'Planned'],
    ['6.2','Conduct integration testing','Oct 24 – Oct 26',false,'Planned'],
    ['6.3','Conduct User Acceptance Testing (UAT)','Oct 26 – Oct 27',false,'Planned'],
    ['6.4','Debug and fix issues found during testing','Oct 27 – Oct 28',false,'Planned'],
    ['7.0','Documentation, presentation, final revisions','Oct 29 – Nov 4',true,'Planned'],
    ['7.1','Prepare Testing Documentation','Oct 29 – Oct 30',false,'Planned'],
    ['7.2','Prepare User Manual','Oct 30 – Nov 1',false,'Planned'],
    ['7.3','Compile Final Project Documentation','Nov 1 – Nov 2',false,'Planned'],
    ['7.4','Apply final revisions based on feedback','Nov 3',false,'Planned'],
    ['7.5','Prepare and deliver final presentation/defense','Nov 4',false,'Planned']
  ];
  for (const w of wbs) {
    const existing = await q('SELECT id FROM wbs_items WHERE code=$1', [w[0]]);
    if (!existing.rowCount) {
      await q('INSERT INTO wbs_items(code,item,target_dates,phase,status) VALUES($1,$2,$3,$4,$5)', w);
    } else {
      await q('UPDATE wbs_items SET item=$2,target_dates=$3,phase=$4 WHERE id=$1', [existing.rows[0].id, w[1], w[2], w[3]]);
    }
  }

  const gantt = [
    ['Requirements gathering, problem analysis, project planning',1,2,'Completed'],
    ['System design, ERD, database, UI design',3,4,'Completed'],
    ['User and project management development',5,6,'Planned'],
    ['Defense request, scheduling, panel assignment',7,8,'Planned'],
    ['Room management, conflict detection, evaluation',9,10,'Planned'],
    ['Testing, debugging, user acceptance testing',11,11,'Planned'],
    ['Documentation, presentation, final revisions',12,12,'Planned']
  ];
  for (const g of gantt) {
    const existing = await q('SELECT id FROM gantt_items WHERE activity=$1', [g[0]]);
    if (!existing.rowCount) await q('INSERT INTO gantt_items(activity,week_start,week_end,status) VALUES($1,$2,$3,$4)',g);
    else await q('UPDATE gantt_items SET week_start=$2,week_end=$3 WHERE id=$1',[existing.rows[0].id,g[1],g[2]]);
  }

  const budgets = [
    ['Internet / Data','Connectivity for development, testing, and coordination','3 mos',1500,4500],
    ['Software / Tools','Development tools and libraries','3 mos',12000,36000],
    ['Printing & Materials','Printing of proposal, manuals, and final documentation','—',5000,5000],
    ['Documentation','Technical Writer','3 mos',15000,45000],
    ['Transportation','Meetings with adviser, panel, and testing coordination','—',1200,1200],
    ['Buffer','Miscellaneous and unforeseen expenses','3 mos',5000,15000],
    ['Developer','Developer’s salary (2)','3 mos',62000,186000]
  ];
  const budgetCount = await q('SELECT COUNT(*)::int AS count FROM budgets');
  if (Number(budgetCount.rows[0].count) === 0) for (const b of budgets) await q('INSERT INTO budgets(category,description,quantity,unit_cost,total) VALUES($1,$2,$3,$4,$5)',b);

  const risks = [
    ['R1','Conflict-detection logic fails to catch a scheduling clash (student, adviser, panel, room, date/time)','Technical','Medium','High','High','Test conflict-detection rules thoroughly with overlapping test cases before UAT','Developer'],
    ['R2','Scope creep — team adds extra features before the 8 core features are complete','Project Mgmt','Medium','Medium','Medium','Follow scope limitations strictly; log extra feature ideas for after core completion','Team Lead'],
    ['R3','Requirements from adviser/coordinator are unclear or change mid-project','Project Mgmt','Medium','High','High','Hold requirements sign-off meeting in Weeks 1–2; document approved scope','Project Team'],
    ['R4','Team member unavailable during a critical week','Resource','Medium','Medium','Medium','Cross-train members on modules; keep 1–2 days buffer per phase','Team Lead'],
    ['R5','Database/ERD design flaw discovered after development has started','Technical','Low','High','Medium','Review ERD with adviser before Week 5 development start','Developer'],
    ['R6','Core modules take longer to build than the 2-week windows allow','Schedule','Medium','High','High','Prioritize the 8 required features only; use Week 11 buffer if needed','Project Team'],
    ['R7','Loss of source code or documents during development','Technical','Low','High','Medium','Use version control (Git) and regular cloud backups','Developer'],
    ['R8','UAT reveals major usability problems close to the deadline','Quality','Medium','Medium','Medium','Conduct informal usability checks with real users before Week 11','Project Team'],
    ['R9','Actual costs exceed the estimated budget','Financial','Low','Medium','Low','Favor free/open-source tools; keep buffer allocation untouched unless needed','Project Team'],
    ['R10','Documentation is rushed because it is left until Week 12','Schedule','Medium','Medium','Medium','Draft each document incrementally as its related phase is completed','Project Team'],
    ['R11','Room double-booking still occurs due to a logic gap','Technical','Low','High','Medium','Add unique constraint checks at the database level, not just the UI','Developer'],
    ['R12','Panel members are unavailable on the scheduled defense date','Operational','Medium','Medium','Medium','Build in a panel-availability field before allowing scheduling','Coordinator']
  ];
  const riskCount = await q('SELECT COUNT(*)::int AS count FROM risks');
  if (Number(riskCount.rows[0].count) === 0) for (const r of risks) await q('INSERT INTO risks(id,description,category,likelihood,impact,risk_level,mitigation,owner) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',r);

  const weekly = [
    [1,'Requirements & problem analysis','Initial requirements, stakeholders, project charter draft','Completed',100],
    [2,'Project planning','Proposal, WBS, Gantt, budget, risk register','Completed',100],
    [3,'System analysis','Requirements, use cases, process definitions','Completed',100],
    [4,'System design','ERD, database schema, UI design, architecture','Completed',100],
    [5,'User management','Login, roles, registration, account management','Not started',0],
    [6,'Project management','Thesis/capstone records, students, adviser, status','Not started',0],
    [7,'Defense requests','Proposal/final request form and coordinator review','Not started',0],
    [8,'Scheduling & panel assignment','Schedules, panels, adviser assignment, upcoming defenses','Not started',0],
    [9,'Room management & conflict detection','Room availability and conflict validation','Not started',0],
    [10,'Evaluation & reports','Scores, results, comments, basic reports','Not started',0],
    [11,'Testing & UAT','Test evidence, bug fixes, UAT sign-off','Not started',0],
    [12,'Documentation & presentation','User manual, final documentation, demo, submission','Not started',0]
  ];
  for (const w of weekly) await q(`INSERT INTO weekly_tracker(week,focus,expected_output,status,progress) VALUES($1,$2,$3,$4,$5) ON CONFLICT(week) DO NOTHING`,w);
}

app.get('/api/health', async (_req,res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); } catch { res.status(500).json({ ok:false }); }
});

app.get('/api/session', (req,res) => res.json({ user: req.session.user || null }));

app.get('/api/csrf', (req,res)=>res.json({token:ensureCsrf(req)}));

app.post('/api/login', loginLimiter, async (req,res) => {
  try {
    const email = cleanEmail(req.body.email);
    const role = cleanText(req.body.role, 40);
    const password = String(req.body.password || '');
    if (!email || !password || !validRole(role)) return res.status(400).json({ error: 'Select your role and enter your account credentials.' });
    const r = await q('SELECT id,full_name,email,password_hash,role,is_active FROM users WHERE lower(email)=lower($1)', [email]);
    if (!r.rowCount) return res.status(401).json({ error: 'Invalid account credentials.' });
    const user = r.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact your Coordinator / Administrator.' });
    if (user.role !== role) return res.status(401).json({ error: 'The selected login role does not match this account.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid account credentials.' });
    const safeUser = serializeUser(user);
    await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
    req.session.user = safeUser;
    ensureCsrf(req);
    await audit(user.id,'login','user',user.id,{});
    res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to sign in.' }); }
});

app.post('/api/logout', (req,res) => req.session.destroy(() => res.json({ ok:true })));

app.get('/api/dashboard', auth, async (req,res) => {
  await syncCompletedDefenseRequests();
  const user = req.session.user;
  const params = [];
  let projectWhere = '';
  if (user.role === 'student') { params.push(user.id); projectWhere = 'WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)'; }
  if (user.role === 'adviser') { params.push(user.id); projectWhere = 'WHERE p.adviser_id=$1'; }
  if (user.role === 'panel_member') { params.push(user.id); projectWhere = 'WHERE EXISTS (SELECT 1 FROM panel_assignments pa JOIN schedules ss ON ss.id=pa.schedule_id WHERE ss.project_id=p.id AND pa.user_id=$1)'; }

  const projects = await q(`SELECT p.id,p.code,p.title,p.type,p.status,p.adviser_id,COALESCE(u.full_name,'Unassigned') adviser_name FROM projects p LEFT JOIN users u ON u.id=p.adviser_id ${projectWhere} ORDER BY p.created_at DESC`, params);
  let scheduleWhere = '', scheduleParams = [];
  if (user.role === 'student') { scheduleWhere='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)'; scheduleParams=[user.id]; }
  if (user.role === 'adviser') { scheduleWhere='WHERE p.adviser_id=$1'; scheduleParams=[user.id]; }
  if (user.role === 'panel_member') { scheduleWhere='WHERE EXISTS (SELECT 1 FROM panel_assignments pa WHERE pa.schedule_id=s.id AND pa.user_id=$1)'; scheduleParams=[user.id]; }
  const scheduleBaseWhere = scheduleWhere ? `${scheduleWhere} AND s.status <> 'Cancelled'` : "WHERE s.status <> 'Cancelled'";
  const schedules = await q(`SELECT s.id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.panel_proceedance,p.code,p.title,r.name room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN rooms r ON r.id=s.room_id ${scheduleBaseWhere} ORDER BY s.defense_date,s.start_time`, scheduleParams);

  let requestWhere = '', requestParams = [];
  if (user.role === 'student') { requestWhere='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)'; requestParams=[user.id]; }
  if (user.role === 'adviser') { requestWhere='WHERE p.adviser_id=$1'; requestParams=[user.id]; }
  const requests = await q(`SELECT dr.id,dr.project_id,dr.defense_type,to_char(dr.preferred_date,'YYYY-MM-DD') AS preferred_date,dr.preferred_time,dr.status,dr.review_feedback,p.code,p.title FROM defense_requests dr JOIN projects p ON p.id=dr.project_id ${requestWhere} ORDER BY dr.created_at DESC`, requestParams);

  const assigned = user.role === 'panel_member' ? await q(`SELECT COUNT(*)::int count FROM panel_assignments pa WHERE pa.user_id=$1`,[user.id]) : { rows:[{count:0}] };
  let evaluations={rows:[{count:0}]};
  if(user.role==='panel_member'||user.role==='adviser') evaluations=await q('SELECT COUNT(*)::int count FROM evaluations WHERE evaluator_id=$1',[user.id]);
  if(user.role==='student') evaluations=await q('SELECT COUNT(*)::int count FROM evaluations e JOIN schedules s ON s.id=e.schedule_id WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=s.project_id AND pm.student_id=$1)',[user.id]);
  const progressQ = user.role==='coordinator' ? await q('SELECT COALESCE(ROUND(AVG(progress)),0)::int progress FROM weekly_tracker') : {rows:[{progress:0}]};
  const availableRooms = (user.role === 'coordinator' || user.role === 'adviser') ? await q('SELECT COUNT(*)::int count FROM rooms WHERE is_available=true') : { rows:[{count:0}] };
  const activeUsers = user.role === 'coordinator' ? await q('SELECT COUNT(*)::int count FROM users WHERE is_active=true') : { rows:[{count:0}] };
  const pending = requests.rows.filter(r=>r.status==='Pending').length;
  const upcoming = schedules.rows.filter(s=>s.status==='Upcoming').length;

  res.json({ role:user.role, counts:{ projects:projects.rowCount, pending_requests:pending, upcoming, assigned_defenses:Number(assigned.rows[0].count), evaluations:Number(evaluations.rows[0].count), available_rooms:Number(availableRooms.rows[0].count), active_users:Number(activeUsers.rows[0].count), progress:Number(progressQ.rows[0].progress) }, projects:projects.rows, schedules:schedules.rows, requests:requests.rows });
});

// User management — Coordinator only. No public registration endpoint exists.
app.get('/api/users', auth, requireRole('coordinator'), async (_req,res) => {
  const r = await q('SELECT id,full_name,email,role,is_active,created_at,panel_availability,profile_image FROM users ORDER BY full_name');
  res.json({ users:r.rows });
});
app.get('/api/advisers', auth, requireRole('coordinator'), async (_req,res) => {
  const r = await q("SELECT id,full_name,email FROM users WHERE role='adviser' AND is_active=true ORDER BY full_name");
  res.json({ users:r.rows });
});
app.get('/api/students', auth, requireRole('coordinator'), async (_req,res) => {
  const r = await q("SELECT id,full_name,email FROM users WHERE role='student' AND is_active=true ORDER BY full_name");
  res.json({ users:r.rows });
});
app.post('/api/users', auth, requireRole('coordinator'), async (req,res) => {
  const name=cleanText(req.body.full_name,120), email=cleanEmail(req.body.email), password=String(req.body.password||''), role=cleanText(req.body.role,40), availability=cleanText(req.body.panel_availability,1000);
  if (!name || !email || password.length < 8 || !validRole(role)) return res.status(400).json({ error:'Provide a name, valid email, role, and password of at least 8 characters.' });
  const exists=await q('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
  if (exists.rowCount) return res.status(409).json({ error:'An account with this email already exists.' });
  const hash=await bcrypt.hash(password,12);
  const r=await q('INSERT INTO users(full_name,email,password_hash,role,panel_availability) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,email,role,is_active,created_at,panel_availability',[name,email,hash,role,availability||null]);
  await audit(req.session.user.id,'create','user',r.rows[0].id,{role});
  res.status(201).json({ user:r.rows[0] });
});
app.patch('/api/profile', auth, async (req,res) => {
  try {
    const id = req.session.user.id;
    const existing = await q('SELECT id,full_name,email,password_hash,role,is_active,panel_availability,profile_image FROM users WHERE id=$1',[id]);
    if (!existing.rowCount) return res.status(404).json({ error:'Account not found.' });
    const current = existing.rows[0];
    const isCoordinator = current.role==='coordinator';
    const name = isCoordinator ? cleanText(req.body.full_name,120) : current.full_name;
    const email = isCoordinator ? cleanEmail(req.body.email) : current.email;
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const profileImage = req.body.profile_image === undefined ? current.profile_image : (req.body.profile_image ? String(req.body.profile_image) : null);
    if (profileImage && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(profileImage) || profileImage.length > 850000)) return res.status(400).json({ error:'Profile image must be a PNG, JPG, or WebP image under 600 KB.' });
    if (!name || !email) return res.status(400).json({ error:'Name and email are required.' });
    if (isCoordinator) {
      const exists = await q('SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2',[email,id]);
      if (exists.rowCount) return res.status(409).json({ error:'That email address is already in use.' });
    }
    let hash = current.password_hash;
    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error:'New password must be at least 8 characters.' });
      if (!currentPassword) return res.status(400).json({ error:'Enter your current password before changing it.' });
      const valid = await bcrypt.compare(currentPassword, hash);
      if (!valid) return res.status(400).json({ error:'Current password is incorrect.' });
      hash = await bcrypt.hash(newPassword,12);
    }
    const r = await q('UPDATE users SET full_name=$1,email=$2,password_hash=$3,profile_image=$4,updated_at=NOW() WHERE id=$5 RETURNING id,full_name,email,role,is_active,profile_image',[name,email,hash,profileImage,id]);
    req.session.user = serializeUser(r.rows[0]);
    res.json({ user:req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error:'Unable to update profile.' }); }
});

app.patch('/api/users/:id', auth, requireRole('coordinator'), async (req,res) => {
  try {
    const id=Number(req.params.id);
    if (!Number.isInteger(id) || id<=0) return res.status(400).json({error:'Invalid user id.'});
    const target=await q('SELECT id,full_name,email,password_hash,role,is_active,panel_availability FROM users WHERE id=$1',[id]);
    if(!target.rowCount)return res.status(404).json({error:'User not found.'});
    const user=target.rows[0];
    const name=cleanText(req.body.full_name,120), email=cleanEmail(req.body.email), password=String(req.body.password||''), availability=cleanText(req.body.panel_availability,1000), role=cleanText(req.body.role,40);
    if(!name||!email||!validRole(role))return res.status(400).json({error:'Name and email are required.'});
    const exists=await q('SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2',[email,id]);
    if(exists.rowCount)return res.status(409).json({error:'That email address is already in use.'});
    let hash=user.password_hash;
    if(password){if(password.length<8)return res.status(400).json({error:'New password must be at least 8 characters.'});hash=await bcrypt.hash(password,12);}
    const r=await q('UPDATE users SET full_name=$1,email=$2,password_hash=$3,panel_availability=$4,role=$5,updated_at=NOW() WHERE id=$6 RETURNING id,full_name,email,role,is_active,created_at,panel_availability',[name,email,hash,availability||null,role,id]);
    await audit(req.session.user.id,'update','user',id,{});
    res.json({user:r.rows[0]});
  } catch(e){console.error(e);res.status(500).json({error:'Unable to update user account.'});}
});

app.delete('/api/users/:id', auth, requireRole('coordinator'), async (req,res)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid user id.'});
    if(id===req.session.user.id)return res.status(400).json({error:'Your own administrator account cannot be deleted.'});
    const roleCheck=await q('SELECT role FROM users WHERE id=$1',[id]); if(roleCheck.rowCount&&roleCheck.rows[0].role==='coordinator'){const activeAdmins=await q("SELECT COUNT(*)::int count FROM users WHERE role='coordinator' AND is_active=true");if(Number(activeAdmins.rows[0].count)<=1)return res.status(400).json({error:'At least one active Coordinator / Administrator account must remain.'});}
    const refs=await q(`SELECT (SELECT COUNT(*)::int FROM project_members WHERE student_id=$1) AS project_refs,(SELECT COUNT(*)::int FROM panel_assignments WHERE user_id=$1) AS panel_refs,(SELECT COUNT(*)::int FROM evaluations WHERE evaluator_id=$1) AS eval_refs,(SELECT COUNT(*)::int FROM reschedule_requests WHERE requested_by=$1) AS reschedule_refs,(SELECT COUNT(*)::int FROM result_clarifications WHERE student_id=$1) AS clarification_refs,(SELECT COUNT(*)::int FROM project_feedback WHERE adviser_id=$1) AS feedback_refs`,[id]);
    const totalRefs=Object.values(refs.rows[0]).reduce((a,v)=>a+Number(v||0),0);
    if(totalRefs>0){ const r=await q('UPDATE users SET is_active=false,updated_at=NOW() WHERE id=$1 RETURNING id,full_name,email,role,is_active',[id]); if(!r.rowCount)return res.status(404).json({error:'User not found.'}); await audit(req.session.user.id,'deactivate-instead-of-delete','user',id,{reason:'Historical records exist'}); return res.json({user:r.rows[0],softDeleted:true}); }
    const r=await q('DELETE FROM users WHERE id=$1 RETURNING id,full_name,email,role',[id]);
    if(!r.rowCount)return res.status(404).json({error:'User not found.'});
    await audit(req.session.user.id,'delete','user',id,{});
    res.json({user:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to delete user account.'});}
});

app.patch('/api/users/:id/status', auth, requireRole('coordinator'), async (req,res) => {
  const id=Number(req.params.id);
  if (id===req.session.user.id) return res.status(400).json({ error:'Your own administrator account cannot be deactivated here.' });
  if(req.body.is_active===false){const target=await q('SELECT role FROM users WHERE id=$1',[id]);if(target.rowCount&&target.rows[0].role==='coordinator'){const activeAdmins=await q("SELECT COUNT(*)::int count FROM users WHERE role='coordinator' AND is_active=true");if(Number(activeAdmins.rows[0].count)<=1)return res.status(400).json({error:'At least one active Coordinator / Administrator account must remain.'});}}
  const r=await q('UPDATE users SET is_active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,full_name,email,role,is_active',[!!req.body.is_active,id]);
  if (!r.rowCount) return res.status(404).json({ error:'User not found.' });
  res.json({ user:r.rows[0] });
});

// Projects — Coordinator manages records; other roles only see assigned records.
app.get('/api/projects', auth, async (req,res) => {
  const u=req.session.user; let where=''; let params=[];
  if (u.role==='student') { where='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)'; params=[u.id]; }
  if (u.role==='panel_member') { where='WHERE EXISTS (SELECT 1 FROM panel_assignments pa JOIN schedules ss ON ss.id=pa.schedule_id WHERE ss.project_id=p.id AND pa.user_id=$1)'; params=[u.id]; }
  const r=await q(`SELECT p.*,COALESCE(u.full_name,'Unassigned') adviser_name FROM projects p LEFT JOIN users u ON u.id=p.adviser_id ${where} ORDER BY p.created_at DESC`,params);
  const enriched = await Promise.all(r.rows.map(async p => ({ ...p, students:(await q('SELECT id,full_name,email FROM users WHERE id=ANY(COALESCE($1::int[], ARRAY[]::int[])) ORDER BY full_name',[p.student_ids])).rows }))); 
  res.json({ projects:enriched });
});

// Student-specific project list used by the defense request workflow.
// It intentionally returns only active projects where the signed-in student is a member.
app.get('/api/my-projects', auth, requireRole('student'), async (req,res) => {
  const r = await q(`SELECT p.id,p.title,p.type,p.status,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name,
                            COALESCE(array_length(p.student_ids,1),0)::int AS member_count
                     FROM projects p
                     LEFT JOIN users a ON a.id=p.adviser_id
                     WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)
                     ORDER BY p.created_at DESC`, [req.session.user.id]);
  res.json({ projects:r.rows });
});
app.post('/api/projects', auth, requireRole('coordinator'), async (req,res) => {
  const title=cleanText(req.body.title,240), type=req.body.type==='Capstone'?'Capstone':'Thesis';
  const adviserId=Number(req.body.adviser_id)||null; const studentIds=Array.isArray(req.body.student_ids)?[...new Set(req.body.student_ids.map(Number).filter(Boolean))]:[];
  if (!title) return res.status(400).json({ error:'Project title is required.' });
  if (studentIds.length < 1 || studentIds.length > 3) return res.status(400).json({ error:'Select 1 to 3 students for a project.' });
  const adviser=await q("SELECT id FROM users WHERE id=$1 AND role='adviser' AND is_active=true",[adviserId]);
  if (!adviser.rowCount) return res.status(400).json({ error:'Please select an active adviser.' });
  const students=await q("SELECT id FROM users WHERE id=ANY($1::int[]) AND role='student' AND is_active=true",[studentIds]);
  if (students.rowCount !== studentIds.length) return res.status(400).json({ error:'All selected students must be active student accounts.' });
  const result=await q('INSERT INTO projects(title,type,student_ids,adviser_id) VALUES($1,$2,$3,$4) RETURNING *',[title,type,studentIds,adviserId]);
  for (const sid of studentIds) await q('INSERT INTO project_members(project_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[result.rows[0].id,sid]);
  await audit(req.session.user.id,'create','project',result.rows[0].id,{student_ids:studentIds,adviser_id:adviserId});
  res.status(201).json({ project:result.rows[0] });
});
app.delete('/api/projects/:id', auth, requireRole('coordinator'), async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isInteger(id) || id<=0) return res.status(400).json({error:'Invalid project ID.'});
  const project=await q('SELECT id,title FROM projects WHERE id=$1',[id]);
  if(!project.rowCount) return res.status(404).json({error:'Project not found.'});
  try{
    await q('DELETE FROM projects WHERE id=$1',[id]);
    await audit(req.session.user.id,'delete','project',id,{title:project.rows[0].title});
    res.json({project:project.rows[0]});
  }catch(e){
    console.error('Project deletion failed:',e);
    res.status(409).json({error:'Unable to remove this project. It may be referenced by protected records.'});
  }
});
app.patch('/api/projects/:id/status', auth, requireRole('coordinator'), async (req,res) => {
  const statuses=['Planning','Requirements','Design','Development','Testing','Completed'];
  if (!statuses.includes(req.body.status)) return res.status(400).json({ error:'Invalid project status.' });
  const r=await q('UPDATE projects SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *',[req.body.status,Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error:'Project not found.' });
  res.json({ project:r.rows[0] });
});

// Defense requests — strictly follow student -> adviser/coordinator review.
app.get('/api/defense-requests', auth, requireRole('student','coordinator'), async (req,res) => {
  await syncCompletedDefenseRequests();
  const u=req.session.user; let where=''; let params=[];
  if (u.role==='student') { where='WHERE $1=ANY(p.student_ids)'; params=[u.id]; }
  const r=await q(`SELECT dr.*,p.code,p.title,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name FROM defense_requests dr JOIN projects p ON p.id=dr.project_id LEFT JOIN users a ON a.id=p.adviser_id ${where} ORDER BY dr.created_at DESC`,params);
  res.json({ requests:r.rows });
});
app.post('/api/defense-requests', auth, requireRole('student'), async (req,res) => {
  const projectId=Number(req.body.project_id), type=req.body.defense_type==='Final Defense'?'Final Defense':'Proposal Defense';
  const date=cleanText(req.body.preferred_date,20), time=cleanText(req.body.preferred_time,20), reason=cleanText(req.body.reason,800);
  if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error:'Select an assigned project.' });
  if (!validDate(date) || !validTime(time)) return res.status(400).json({ error:'Enter a valid preferred date and time.' });
  const owns=await q(`SELECT p.id,p.title,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name
                       FROM projects p LEFT JOIN users a ON a.id=p.adviser_id
                       WHERE p.id=$1 AND $2=ANY(COALESCE(p.student_ids, ARRAY[]::integer[]))`,[projectId,req.session.user.id]);
  if (!owns.rowCount) return res.status(403).json({ error:'You can only submit a request for a project assigned to you.' });
  const duplicate=await q(`SELECT id FROM defense_requests WHERE project_id=$1 AND status IN ('Pending','Approved','Scheduled')`,[projectId]);
  if (duplicate.rowCount) return res.status(409).json({ error:'This project already has an active defense request.' });
  const r=await q('INSERT INTO defense_requests(project_id,defense_type,preferred_date,preferred_time,reason,submitted_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[projectId,type,date,time,reason,req.session.user.id]);
  res.status(201).json({ request:r.rows[0], project:owns.rows[0] });
});
function addMinutesToTime(hhmm, minutes=120) {
  const base=timeMinutes(hhmm); if(base===null) return null; const total=base+minutes; if(total>=24*60) return null; const h=Math.floor(total/60), min=total%60; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
async function withTransaction(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release();}}
async function scheduleConflictsWithClient(client,{projectId,date,start,end,roomId,excludeId=null}){
 const args=[projectId,date,start,end,roomId||null]; if(excludeId)args.push(excludeId); const extra=excludeId?' AND s.id<>$6':'';
 const sql=`SELECT DISTINCT s.id,s.project_id,s.room_id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time
 FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.status<>'Cancelled' AND s.defense_date=$2 AND s.start_time < $4 AND s.end_time > $3 ${extra}
 AND (s.project_id=$1 OR ($5::int IS NOT NULL AND s.room_id=$5) OR p.adviser_id=(SELECT adviser_id FROM projects WHERE id=$1) OR p.student_ids && COALESCE((SELECT student_ids FROM projects WHERE id=$1), ARRAY[]::integer[]) OR EXISTS (SELECT 1 FROM panel_assignments pa1 WHERE pa1.schedule_id=s.id AND EXISTS (SELECT 1 FROM panel_assignments pa2 WHERE pa2.schedule_id IN (SELECT id FROM schedules WHERE project_id=$1) AND pa2.user_id=pa1.user_id)))`;
 return (await client.query(sql,args)).rows;
}
async function createAutomaticScheduleForRequest(requestId) {
 return withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock($1)',[Number(requestId)]);
  const result=await client.query(`SELECT dr.*,p.title,p.type,p.adviser_id,p.student_ids FROM defense_requests dr JOIN projects p ON p.id=dr.project_id WHERE dr.id=$1`,[requestId]);
  if(!result.rowCount) throw new Error('Defense request not found.'); const dr=result.rows[0];
  const start=String(dr.preferred_time).slice(0,5), duration=Math.max(30,Number(process.env.DEFAULT_DEFENSE_DURATION_MINUTES||120)), end=addMinutesToTime(start,duration);
  if(!end) throw new Error('The preferred time plus the default defense duration goes past midnight. Choose an earlier time.');
  if(!validDate(String(dr.preferred_date).slice(0,10))||!validTime(start)) throw new Error('The requested date or time is invalid.');
  const conflicts=await scheduleConflictsWithClient(client,{projectId:dr.project_id,date:String(dr.preferred_date).slice(0,10),start,end,roomId:null});
  if(conflicts.length){const error=new Error('The preferred date and time conflicts with another defense, student, adviser, panel, or room schedule. Resolve the conflict before approving this request.');error.code='SCHEDULE_CONFLICT';throw error;}
  const existing=await client.query("SELECT id FROM schedules WHERE request_id=$1 AND status<>'Cancelled' LIMIT 1",[requestId]); if(existing.rowCount) return existing.rows[0];
  const schedule=await client.query(`INSERT INTO schedules(project_id,request_id,defense_type,defense_date,start_time,end_time,room_id,notes) VALUES($1,$2,$3,$4,$5,$6,NULL,$7) RETURNING *`,[dr.project_id,requestId,dr.defense_type,String(dr.preferred_date).slice(0,10),start,end,'Automatically scheduled from the approved student request. Room and panel assignment pending.']);
  await client.query("UPDATE defense_requests SET status='Scheduled',updated_at=NOW() WHERE id=$1",[requestId]);
  return schedule.rows[0];
 });
}

app.patch('/api/defense-requests/:id/review', auth, requireRole('coordinator'), async (req,res) => {
  const id=Number(req.params.id); const status=String(req.body.status||''); const feedback=cleanText(req.body.feedback,1200);
  if (!['Approved','Returned'].includes(status)) return res.status(400).json({ error:'Choose Approve or Return with Feedback.' });
  if (!feedback) return res.status(400).json({ error:'Choose or enter feedback before submitting the decision.' });
  const request=await q(`SELECT dr.*,p.adviser_id FROM defense_requests dr JOIN projects p ON p.id=dr.project_id WHERE dr.id=$1`,[id]);
  if (!request.rowCount) return res.status(404).json({error:'Request not found.'});
  if (request.rows[0].status !== 'Pending') return res.status(409).json({error:'This defense request has already been reviewed.'});
  if (req.session.user.role==='adviser' && request.rows[0].adviser_id!==req.session.user.id) return res.status(403).json({error:'You can only review requests for your assigned projects.'});
  if (status==='Approved') {
    try {
      const schedule = await createAutomaticScheduleForRequest(id);
      const r=await q("UPDATE defense_requests SET status='Scheduled',review_feedback=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[feedback,id]);
      await audit(req.session.user.id,'approve','defense_request',id,{feedback,schedule_id:schedule.id});
      return res.json({ request:r.rows[0], schedule, scheduledAutomatically:true });
    } catch (e) {
      if (e.code==='SCHEDULE_CONFLICT') return res.status(409).json({error:e.message});
      throw e;
    }
  }
  const r=await q("UPDATE defense_requests SET status='Returned',review_feedback=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[feedback,id]);
  await audit(req.session.user.id,'return','defense_request',id,{feedback});
  res.json({ request:r.rows[0], scheduledAutomatically:false });
});

// Rooms — capacity is intentionally not part of the system.
app.patch('/api/defense-requests/:id/resubmit', auth, requireRole('student'), async(req,res)=>{
 const id=Number(req.params.id), date=normalizeDate(req.body.preferred_date), time=cleanText(req.body.preferred_time,20), reason=cleanText(req.body.reason,800);
 if(!validDate(date)||!validTime(time))return res.status(400).json({error:'Enter a valid preferred date and time.'});
 const own=await q(`SELECT dr.id,p.student_ids FROM defense_requests dr JOIN projects p ON p.id=dr.project_id WHERE dr.id=$1 AND $2=ANY(p.student_ids)`,[id,req.session.user.id]);
 if(!own.rowCount)return res.status(403).json({error:'You can only revise a request for your own project.'});
 const r=await q("UPDATE defense_requests SET preferred_date=$1,preferred_time=$2,reason=$3,status='Pending',review_feedback=NULL,updated_at=NOW() WHERE id=$4 AND status='Returned' RETURNING *",[date,time,reason,id]);
 if(!r.rowCount)return res.status(409).json({error:'This request is not available for resubmission.'});
 await audit(req.session.user.id,'resubmit','defense_request',id,{}); res.json({request:r.rows[0]});
});

app.get('/api/rooms', auth, requireRole('coordinator'), async (req,res)=>{
  const date=normalizeDate(req.query.date||'');
  const start=cleanText(req.query.start||'',20);
  const end=cleanText(req.query.end||'',20);
  const excludeId=Number(req.query.exclude_id)||null;
  const hasSlot=validDate(date)&&validTime(start)&&validTime(end)&&timeMinutes(start)<timeMinutes(end);
  let rooms=(await q('SELECT id,name,location,is_available FROM rooms ORDER BY name')).rows;
  if(hasSlot){
    const args=[date,start,end];
    let extra='';
    if(excludeId){args.push(excludeId);extra=' AND s.id<>$4';}
    const occupied=await q(`SELECT DISTINCT room_id FROM schedules s WHERE room_id IS NOT NULL AND status<>\'Cancelled\' AND defense_date=$1 AND start_time < $3 AND end_time > $2 ${extra}` ,args);
    const occupiedIds=new Set(occupied.rows.map(r=>Number(r.room_id)));
    rooms=rooms.map(r=>({...r,occupied:occupiedIds.has(Number(r.id))}));
  } else {
    rooms=rooms.map(r=>({...r,occupied:false}));
  }
  res.json({rooms});
});
app.post('/api/rooms', auth, requireRole('coordinator'), async(req,res)=>{
  const name=cleanText(req.body.name,100), location=cleanText(req.body.location,160);
  if(!name||!location)return res.status(400).json({error:'Room name and location are required.'});
  try { const r=await q('INSERT INTO rooms(name,location,is_available) VALUES($1,$2,true) RETURNING *',[name,location]); res.status(201).json({room:r.rows[0]}); }
  catch { res.status(409).json({error:'A room with this name already exists.'}); }
});
app.patch('/api/rooms/:id', auth, requireRole('coordinator'), async(req,res)=>{ const id=Number(req.params.id); const name=cleanText(req.body.name,100), location=cleanText(req.body.location,160); const hasName=Object.prototype.hasOwnProperty.call(req.body,'name'); const hasLocation=Object.prototype.hasOwnProperty.call(req.body,'location'); const hasAvail=Object.prototype.hasOwnProperty.call(req.body,'is_available'); try{ const r=await q(`UPDATE rooms SET name=CASE WHEN $1 THEN $2 ELSE name END, location=CASE WHEN $3 THEN $4 ELSE location END, is_available=CASE WHEN $5 THEN $6 ELSE is_available END WHERE id=$7 RETURNING *`,[hasName,name,hasLocation,location,hasAvail,!!req.body.is_available,id]); if(!r.rowCount)return res.status(404).json({error:'Room not found.'}); await audit(req.session.user.id,'update','room',id,{});res.json({room:r.rows[0]}); }catch(e){res.status(409).json({error:'Unable to update room. The room name may already exist or the room is still in use.'});} });
app.delete('/api/rooms/:id', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id);const used=await q("SELECT COUNT(*)::int count FROM schedules WHERE room_id=$1 AND status<>'Cancelled'",[id]);if(Number(used.rows[0].count)>0)return res.status(409).json({error:'This room is assigned to an active defense. Mark it unavailable instead of deleting it.'});const r=await q('DELETE FROM rooms WHERE id=$1 RETURNING id,name',[id]);if(!r.rowCount)return res.status(404).json({error:'Room not found.'});await audit(req.session.user.id,'delete','room',id,{});res.json({room:r.rows[0]});});

async function scheduleConflicts({projectId,date,start,end,roomId,excludeId=null}) {
  const args=[projectId,date,start,end,roomId||null]; const extra=excludeId?' AND s.id<>$6':''; if(excludeId)args.push(excludeId);
  const sql=`SELECT DISTINCT s.id,s.project_id,s.room_id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time
    FROM schedules s
    JOIN projects p ON p.id=s.project_id
    WHERE s.status<>'Cancelled'
      AND s.defense_date=$2
      AND s.start_time < $4
      AND s.end_time > $3
      ${extra}
      AND (
        s.project_id=$1 OR
        ($5::int IS NOT NULL AND s.room_id=$5) OR
        p.adviser_id=(SELECT adviser_id FROM projects WHERE id=$1) OR
        p.student_ids && COALESCE((SELECT student_ids FROM projects WHERE id=$1), ARRAY[]::integer[]) OR
        EXISTS (
          SELECT 1 FROM panel_assignments pa1 WHERE pa1.schedule_id=s.id AND pa1.user_id IN (
            SELECT pa2.user_id FROM panel_assignments pa2 WHERE pa2.schedule_id IN (SELECT id FROM schedules WHERE project_id=$1)
          )
        )
      )`;
  return (await q(sql,args)).rows;
}

app.get('/api/schedules', auth, async(req,res)=>{
 const u=req.session.user; let where='';let params=[]; if(u.role==='student'){where='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)';params=[u.id];} if(u.role==='adviser'){where='WHERE p.adviser_id=$1';params=[u.id];} if(u.role==='panel_member'){where="WHERE EXISTS (SELECT 1 FROM panel_assignments pa WHERE pa.schedule_id=s.id AND pa.user_id=$1) AND s.status NOT IN ('Cancelled')";params=[u.id];}
 const r=await q(`SELECT s.id,s.project_id,s.request_id,s.defense_type,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.room_id,s.status,s.defense_result,s.panel_proceedance,s.panel_proceeded_at,s.notes,s.created_at,p.title,p.type,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name,r.name room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN rooms r ON r.id=s.room_id ${where} ORDER BY s.defense_date,s.start_time`,params);
 res.json({schedules:r.rows});
});
async function saveSchedule(payload, userId, excludeId=null){
 const projectId=Number(payload.project_id),requestId=Number(payload.request_id)||null,date=normalizeDate(payload.defense_date),start=cleanText(payload.start_time,20),end=cleanText(payload.end_time,20),roomId=Number(payload.room_id)||null,type=payload.defense_type==='Final Defense'?'Final Defense':'Proposal Defense',notes=cleanText(payload.notes,1000);
 if(!validPositiveInt(projectId)||!validDate(date)||!validTime(start)||!validTime(end))throw Object.assign(new Error('Project, date, start time, and end time are required in a valid format.'),{status:400});
 if(timeMinutes(start)>=timeMinutes(end))throw Object.assign(new Error('End time must be after start time.'),{status:400});
 return withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock($1)',[projectId]);
  const project=await client.query('SELECT id FROM projects WHERE id=$1',[projectId]); if(!project.rowCount)throw Object.assign(new Error('Project not found.'),{status:404});
  if(requestId){const reqr=await client.query('SELECT id,project_id,status FROM defense_requests WHERE id=$1',[requestId]);if(!reqr.rowCount||reqr.rows[0].project_id!==projectId)throw Object.assign(new Error('Selected defense request does not belong to this project.'),{status:400});}
  if(roomId){const room=await client.query('SELECT is_available FROM rooms WHERE id=$1',[roomId]);if(!room.rowCount||!room.rows[0].is_available)throw Object.assign(new Error('Selected room is not available.'),{status:400});}
  let resolvedRequestId=requestId;
  if(!resolvedRequestId){
    const match=await client.query(`SELECT id FROM defense_requests WHERE project_id=$1 AND defense_type=$2 AND status IN ('Approved','Scheduled') ORDER BY CASE WHEN preferred_date=$3 AND preferred_time::time=$4 THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`,[projectId,type,date,start]);
    if(match.rowCount) resolvedRequestId=Number(match.rows[0].id);
  }
  const conflicts=await scheduleConflictsWithClient(client,{projectId,date,start,end,roomId,excludeId}); if(conflicts.length)throw Object.assign(new Error('Conflict detected. Review the student, adviser, panel, room, date/time, or existing schedule before continuing.'),{status:409,conflicts});
  let r; if(excludeId){r=await client.query(`UPDATE schedules SET project_id=$1,request_id=$2,defense_type=$3,defense_date=$4,start_time=$5,end_time=$6,room_id=$7,notes=$8 WHERE id=$9 RETURNING *`,[projectId,resolvedRequestId,type,date,start,end,roomId,notes,excludeId]);if(!r.rowCount)throw Object.assign(new Error('Schedule not found.'),{status:404});} else {r=await client.query(`INSERT INTO schedules(project_id,request_id,defense_type,defense_date,start_time,end_time,room_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[projectId,resolvedRequestId,type,date,start,end,roomId,notes]);}
  if(resolvedRequestId)await client.query("UPDATE defense_requests SET status='Scheduled',updated_at=NOW() WHERE id=$1 AND status <> 'Completed'",[resolvedRequestId]); return r.rows[0];
 });
}
app.post('/api/schedules', auth, requireRole('coordinator'), async(req,res)=>{try{const schedule=await saveSchedule(req.body,req.session.user.id);await audit(req.session.user.id,'create','schedule',schedule.id,{project_id:schedule.project_id});res.status(201).json({schedule});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to save defense schedule.',...(e.conflicts?{conflicts:e.conflicts}:{})});}});
app.patch('/api/schedules/:id', auth, requireRole('coordinator'), async(req,res)=>{try{const current=await q('SELECT * FROM schedules WHERE id=$1',[Number(req.params.id)]);if(!current.rowCount)return res.status(404).json({error:'Schedule not found.'});if(current.rows[0].status!=='Upcoming')return res.status(409).json({error:'Only upcoming defense schedules can be edited.'});const payload={...current.rows[0],...req.body,defense_date:normalizeDate(req.body.defense_date||current.rows[0].defense_date),start_time:cleanText(req.body.start_time||current.rows[0].start_time,20),end_time:cleanText(req.body.end_time||current.rows[0].end_time,20)};const schedule=await saveSchedule(payload,req.session.user.id,Number(req.params.id));await audit(req.session.user.id,'update','schedule',schedule.id,{});res.json({schedule});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to update defense schedule.',...(e.conflicts?{conflicts:e.conflicts}:{})});}});
app.patch('/api/schedules/:id/cancel', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id);const r=await q("UPDATE schedules SET status='Cancelled' WHERE id=$1 AND status<>'Cancelled' RETURNING id,status,request_id",[id]); if(!r.rowCount)return res.status(404).json({error:'Schedule not found or already cancelled.'}); if(r.rows[0].request_id)await q("UPDATE defense_requests SET status='Returned',review_feedback='Defense schedule was cancelled. Please submit a revised request if needed.',updated_at=NOW() WHERE id=$1 AND status='Scheduled'",[r.rows[0].request_id]); await audit(req.session.user.id,'cancel','schedule',id,{});res.json({schedule:r.rows[0]});});
app.patch('/api/schedules/:id/room', auth, requireRole('coordinator'), async(req,res)=>{try{const id=Number(req.params.id);const current=await q('SELECT * FROM schedules WHERE id=$1',[id]);if(!current.rowCount)return res.status(404).json({error:'Schedule not found.'});const payload={...current.rows[0],room_id:Number(req.body.room_id)||null};const schedule=await saveSchedule(payload,req.session.user.id,id);await audit(req.session.user.id,'update','schedule',id,{room_id:schedule.room_id});res.json({schedule});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to update room assignment.'});}});

// Panel assignments
app.get('/api/panels', auth, async(req,res)=>{
 const u=req.session.user;
 if(u.role==='panel_member'){
   const r=await q(`SELECT pa.id,pa.schedule_id,pa.user_id,pa.panel_role,u.full_name,u.email,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.panel_proceedance,p.title FROM panel_assignments pa JOIN users u ON u.id=pa.user_id JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id WHERE pa.user_id=$1 AND s.status NOT IN ('Cancelled') ORDER BY s.defense_date,s.start_time,pa.panel_role`,[u.id]);
   return res.json({assignments:r.rows});
 }
 let where='';let params=[];
 if(u.role==='student'){where='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)';params=[u.id];}
 if(u.role==='adviser'){where='WHERE p.adviser_id=$1';params=[u.id];}
 if(u.role==='coordinator' || u.role==='administrator'){where='';params=[];}
 const r=await q(`SELECT pa.id,pa.schedule_id,pa.user_id,pa.panel_role,u.full_name,u.email,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.panel_proceedance,p.title FROM panel_assignments pa JOIN users u ON u.id=pa.user_id JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id ${where} ORDER BY s.defense_date,s.start_time,pa.panel_role`,params);res.json({assignments:r.rows});
});
app.get('/api/panel-options', auth, requireRole('coordinator'), async(_req,res)=>{
 const panelMembers=(await q("SELECT id,full_name,email,role,panel_availability FROM users WHERE role='panel_member' AND is_active=true ORDER BY full_name")).rows;
 const advisers=(await q("SELECT id,full_name,email,role FROM users WHERE role='adviser' AND is_active=true ORDER BY full_name")).rows;
 const schedules=(await q(`SELECT s.id,s.project_id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.panel_proceedance,p.title,p.type,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name
                              FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id
                              WHERE s.status <> 'Cancelled' ORDER BY s.defense_date,s.start_time,p.title`)).rows;
 res.json({panelMembers,advisers,schedules});
});
app.post('/api/panels', auth, requireRole('coordinator'), async(req,res)=>{
 const scheduleId=Number(req.body.schedule_id),userId=Number(req.body.user_id),role=['Chairperson','Panel Member','Adviser'].includes(req.body.panel_role)?req.body.panel_role:null; if(!scheduleId||!userId||!role)return res.status(400).json({error:'Defense, member, and panel role are required.'});
 const schedule=await q(`SELECT s.id,s.project_id,s.defense_date,s.start_time,s.end_time,p.adviser_id FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,[scheduleId]);if(!schedule.rowCount)return res.status(404).json({error:'Defense schedule not found.'});
 if(schedule.rows[0].status==='Cancelled' || schedule.rows[0].status==='Completed')return res.status(409).json({error:'Panel assignments can only be made for an active defense schedule.'});
 const target=await q('SELECT id,role,is_active,panel_availability FROM users WHERE id=$1',[userId]);if(!target.rowCount||!target.rows[0].is_active)return res.status(400).json({error:'Selected user is not active.'});
 const expectedRole=role==='Adviser'?'adviser':'panel_member';if(target.rows[0].role!==expectedRole)return res.status(400).json({error:`${role} must be assigned to an active ${expectedRole==='adviser'?'Adviser':'Panel Member'} account.`});if(role==='Adviser'&&target.rows[0].id!==schedule.rows[0].adviser_id)return res.status(400).json({error:'The Adviser role must use the adviser assigned to this project.'});
 if(role!=='Adviser'&&target.rows[0].panel_availability){ /* availability is recorded and can be reviewed; free-form because exact scheduling rules are institution-specific */ }
 const existing=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,userId]);if(existing.rowCount)return res.status(409).json({error:'This person is already assigned to this defense.'});const roleExists=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND panel_role=$2',[scheduleId,role]);if(roleExists.rowCount&&role!=='Panel Member')return res.status(409).json({error:`A ${role} is already assigned to this defense.`});
 const conflict=await q(`SELECT pa.id FROM panel_assignments pa JOIN schedules s ON s.id=pa.schedule_id WHERE pa.user_id=$1 AND s.id<>$2 AND s.status<>'Cancelled' AND s.defense_date=$3 AND s.start_time < $5 AND s.end_time > $4`,[userId,scheduleId,schedule.rows[0].defense_date,schedule.rows[0].start_time,schedule.rows[0].end_time]);if(conflict.rowCount)return res.status(409).json({error:'This person is already assigned to another defense at the same time.'});
 const r=await q('INSERT INTO panel_assignments(schedule_id,user_id,panel_role) VALUES($1,$2,$3) RETURNING *',[scheduleId,userId,role]);await audit(req.session.user.id,'create','panel_assignment',r.rows[0].id,{schedule_id:scheduleId,user_id:userId,panel_role:role});res.status(201).json({assignment:r.rows[0]});
});
app.delete('/api/panels/:id', auth, requireRole('coordinator'), async(req,res)=>{const r=await q('DELETE FROM panel_assignments WHERE id=$1 RETURNING *',[Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:'Panel assignment not found.'});await audit(req.session.user.id,'delete','panel_assignment',Number(req.params.id),{});res.json({assignment:r.rows[0]});});

// Panel flow: proceed or request reschedule.
app.post('/api/schedules/:id/proceed', auth, requireRole('panel_member'), async(req,res)=>{const id=Number(req.params.id);const member=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[id,req.session.user.id]);if(!member.rowCount)return res.status(403).json({error:'You are not assigned to this defense.'});const current=await q("SELECT id,status,panel_proceedance FROM schedules WHERE id=$1",[id]);if(!current.rowCount||current.rows[0].status!=='Upcoming')return res.status(409).json({error:'Only an upcoming defense can be marked to proceed.'});const r=await q("UPDATE schedules SET panel_proceedance='Proceed',panel_proceeded_at=NOW() WHERE id=$1 RETURNING id,project_id,request_id,defense_type,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time,end_time,room_id,status,defense_result,panel_proceedance,panel_proceeded_at,notes,created_at",[id]);await audit(req.session.user.id,'proceed','schedule',id,{});res.json({schedule:r.rows[0]});});
app.post('/api/reschedule-requests', auth, requireRole('panel_member'), async(req,res)=>{const scheduleId=Number(req.body.schedule_id),reason=cleanText(req.body.reason,1000),preferredDate=normalizeDate(req.body.preferred_date),preferredTime=cleanText(req.body.preferred_time,20);const member=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,req.session.user.id]);if(!member.rowCount)return res.status(403).json({error:'You are not assigned to this defense.'});if(!reason||!validDate(preferredDate)||!validTime(preferredTime))return res.status(400).json({error:'Provide a valid preferred date, time, and reason.'});const active=await q("SELECT id,status FROM schedules WHERE id=$1 AND status='Upcoming'",[scheduleId]);if(!active.rowCount)return res.status(409).json({error:'Only an upcoming defense can be rescheduled.'});const duplicate=await q("SELECT id FROM reschedule_requests WHERE schedule_id=$1 AND status='Pending'",[scheduleId]);if(duplicate.rowCount)return res.status(409).json({error:'A reschedule request is already pending for this defense.'});const r=await q('INSERT INTO reschedule_requests(schedule_id,requested_by,reason,preferred_date,preferred_time) VALUES($1,$2,$3,$4,$5) RETURNING *',[scheduleId,req.session.user.id,reason,preferredDate,preferredTime]);await q("UPDATE schedules SET panel_proceedance='Reschedule Requested' WHERE id=$1",[scheduleId]);await audit(req.session.user.id,'request-reschedule','schedule',scheduleId,{preferred_date:preferredDate,preferred_time:preferredTime});res.status(201).json({request:r.rows[0]});});
app.get('/api/reschedule-requests', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT rr.*,u.full_name requester_name,to_char(rr.preferred_date,'YYYY-MM-DD') preferred_date,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,p.title FROM reschedule_requests rr JOIN users u ON u.id=rr.requested_by JOIN schedules s ON s.id=rr.schedule_id JOIN projects p ON p.id=s.project_id ORDER BY rr.created_at DESC`);res.json({requests:r.rows});});
app.patch('/api/reschedule-requests/:id', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id),status=['Approved','Rejected'].includes(req.body.status)?req.body.status:null;if(!status)return res.status(400).json({error:'Invalid status.'});const rr=await q('SELECT * FROM reschedule_requests WHERE id=$1',[id]);if(!rr.rowCount)return res.status(404).json({error:'Request not found.'});if(rr.rows[0].status!=='Pending')return res.status(409).json({error:'This reschedule request has already been handled.'});if(status==='Rejected'){const r=await q("UPDATE reschedule_requests SET status='Rejected',updated_at=NOW() WHERE id=$1 RETURNING *",[id]);await q("UPDATE schedules SET panel_proceedance='Pending' WHERE id=$1 AND status='Upcoming'",[rr.rows[0].schedule_id]);await audit(req.session.user.id,'reject-reschedule','reschedule_request',id,{});return res.json({request:r.rows[0]});}
 const old=await q(`SELECT * FROM schedules WHERE id=$1`,[rr.rows[0].schedule_id]);if(!old.rowCount)return res.status(404).json({error:'Original schedule not found.'});
 try{const replacement=await saveSchedule({project_id:old.rows[0].project_id,request_id:old.rows[0].request_id,defense_type:old.rows[0].defense_type,defense_date:rr.rows[0].preferred_date,start_time:rr.rows[0].preferred_time,end_time:addMinutesToTime(String(rr.rows[0].preferred_time).slice(0,5),Math.max(30,Number(process.env.DEFAULT_DEFENSE_DURATION_MINUTES||120))),room_id:null,notes:`Rescheduled from defense schedule #${old.rows[0].id}. ${old.rows[0].notes||''}`},req.session.user.id,old.rows[0].id); const r=await q("UPDATE reschedule_requests SET status='Approved',updated_at=NOW() WHERE id=$1 RETURNING *",[id]); await q("UPDATE schedules SET panel_proceedance='Pending',panel_proceeded_at=NULL WHERE id=$1",[replacement.id]); await audit(req.session.user.id,'approve-reschedule','reschedule_request',id,{replacement_schedule_id:replacement.id}); res.json({request:r.rows[0],schedule:replacement});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to approve the reschedule request.'});}});

// Evaluation: panel member/adviser only when assigned. Confirmation is represented by the final submit action.
app.get('/api/evaluations', auth, async(req,res)=>{
  const u=req.session.user; let where=''; let params=[];
  if(u.role==='panel_member'){where='WHERE e.evaluator_id=$1';params=[u.id];}
  if(u.role==='adviser'){where='WHERE e.evaluator_id=$1 AND p.adviser_id=$1';params=[u.id];}
  if(u.role==='student'){where='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)';params=[u.id];}
  const r=await q(`SELECT e.*,u.full_name evaluator_name,p.code,p.title,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.defense_type,s.panel_proceedance FROM evaluations e JOIN users u ON u.id=e.evaluator_id JOIN schedules s ON s.id=e.schedule_id JOIN projects p ON p.id=s.project_id ${where} ORDER BY e.created_at DESC`,params);
  res.json({evaluations:r.rows});
});
app.post('/api/evaluations', auth, requireRole('panel_member','adviser'), async(req,res)=>{
  const scheduleId=Number(req.body.schedule_id);
  const schedule=await q("SELECT s.status,s.panel_proceedance,s.project_id,p.adviser_id FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1",[scheduleId]);
  if(!schedule.rowCount)return res.status(404).json({error:'Defense not found.'});
  if(schedule.rows[0].status==='Cancelled')return res.status(409).json({error:'Cancelled defenses cannot be evaluated.'}); if(schedule.rows[0].status==='Upcoming' && schedule.rows[0].panel_proceedance!=='Proceed')return res.status(409).json({error:'The defense must be marked to proceed before evaluation can be submitted.'});
  const isAdviser= req.session.user.role==='adviser';
  let eligible=false;
  if(isAdviser){
    eligible = Number(schedule.rows[0].adviser_id)===Number(req.session.user.id);
  } else {
    const membership=await q('SELECT panel_role FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,req.session.user.id]);
    eligible=membership.rowCount>0;
  }
  if(!eligible)return res.status(403).json({error:isAdviser?'You can only evaluate defenses for projects where you are the assigned adviser.':'You are not assigned to this defense.'});
  const scores=['technical_score','presentation_score','documentation_score'].map(k=>Number(req.body[k]));
  if(scores.some(x=>Number.isNaN(x)||x<0||x>100))return res.status(400).json({error:'Scores must be between 0 and 100.'});
  const comments=cleanText(req.body.comments,2000), recommendation=cleanText(req.body.recommendation,80)||'For Revision'; const result=['Passed','Failed','For Revision','Re-defense Required'].includes(req.body.defense_result)?req.body.defense_result:null; if(!result)return res.status(400).json({error:'Select a defense result.'});
  const r=await q(`INSERT INTO evaluations(schedule_id,evaluator_id,technical_score,presentation_score,documentation_score,comments,recommendation)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(schedule_id,evaluator_id) DO UPDATE SET technical_score=EXCLUDED.technical_score,presentation_score=EXCLUDED.presentation_score,documentation_score=EXCLUDED.documentation_score,comments=EXCLUDED.comments,recommendation=EXCLUDED.recommendation,confirmed_at=NOW()
    RETURNING *`,[scheduleId,req.session.user.id,scores[0],scores[1],scores[2],comments,recommendation]);
  const panelCount=await q('SELECT COUNT(*)::int count FROM panel_assignments WHERE schedule_id=$1',[scheduleId]);
  const adviserAssigned=await q(`SELECT CASE WHEN p.adviser_id IS NULL THEN 0 ELSE 1 END::int count
    FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,[scheduleId]);
  const expectedEvaluators=Number(panelCount.rows[0].count)+Number(adviserAssigned.rows[0]?.count||0);
  const evaluationCount=await q('SELECT COUNT(*)::int count FROM evaluations WHERE schedule_id=$1',[scheduleId]);
  if(expectedEvaluators>0 && Number(evaluationCount.rows[0].count)>=expectedEvaluators) {
    await q("UPDATE schedules SET status='Completed',defense_result=$2 WHERE id=$1",[scheduleId,result]);
    await q("UPDATE defense_requests SET status='Completed',review_feedback=$2,updated_at=NOW() WHERE id=(SELECT request_id FROM schedules WHERE id=$1) AND status <> 'Completed'",[scheduleId,`Defense completed. Result: ${result}.`]);
  }
  await syncCompletedDefenseRequests();
  res.status(201).json({evaluation:r.rows[0]});
});

// Adviser feedback / student revise-resubmit loop.
app.get('/api/feedback', auth, async(req,res)=>{
  const u=req.session.user; let where='';let params=[];
  if(u.role==='adviser'){where='WHERE pf.adviser_id=$1';params=[u.id];}
  if(u.role==='student'){where='WHERE EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1)';params=[u.id];}
  const r=await q(`SELECT pf.*,p.code,p.title,u.full_name adviser_name FROM project_feedback pf JOIN projects p ON p.id=pf.project_id JOIN users u ON u.id=pf.adviser_id ${where} ORDER BY pf.created_at DESC`,params);
  res.json({ feedback:r.rows });
});
app.post('/api/feedback', auth, requireRole('adviser'), async(req,res)=>{
  const projectId=Number(req.body.project_id), feedback=cleanText(req.body.feedback,2000); const p=await q('SELECT adviser_id FROM projects WHERE id=$1',[projectId]);
  if(!p.rowCount||p.rows[0].adviser_id!==req.session.user.id)return res.status(403).json({error:'You can only provide feedback on your assigned projects.'});
  if(!feedback)return res.status(400).json({error:'Feedback is required.'});
  const r=await q('INSERT INTO project_feedback(project_id,adviser_id,feedback) VALUES($1,$2,$3) RETURNING *',[projectId,req.session.user.id,feedback]);res.status(201).json({feedback:r.rows[0]});
});
app.patch('/api/feedback/:id/student-response', auth, requireRole('student'), async(req,res)=>{
  const id=Number(req.params.id), p=await q(`SELECT pf.id,p.student_ids FROM project_feedback pf JOIN projects p ON p.id=pf.project_id WHERE pf.id=$1`,[id]);
  if(!p.rowCount||!p.rows[0].student_ids.includes(req.session.user.id))return res.status(403).json({error:'You can only respond to feedback for your project.'});
  const r=await q("UPDATE project_feedback SET status='Resubmitted',updated_at=NOW() WHERE id=$1 RETURNING *",[id]);res.json({feedback:r.rows[0]});
});
app.patch('/api/feedback/:id/satisfaction', auth, requireRole('adviser'), async(req,res)=>{const status=req.body.status==='Satisfied'?'Satisfied':'Open';const r=await q('UPDATE project_feedback SET status=$1,updated_at=NOW() WHERE id=$2 AND adviser_id=$3 RETURNING *',[status,Number(req.params.id),req.session.user.id]);if(!r.rowCount)return res.status(404).json({error:'Feedback record not found.'});res.json({feedback:r.rows[0]});});

// Student result clarification loop.
app.post('/api/result-clarifications', auth, requireRole('student'), async(req,res)=>{const scheduleId=Number(req.body.schedule_id),message=cleanText(req.body.message,1200);if(!message)return res.status(400).json({error:'Please enter your clarification message.'});const own=await q('SELECT id FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1 AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$2)',[scheduleId,req.session.user.id]);if(!own.rowCount)return res.status(403).json({error:'You can only request clarification for your own result.'});const r=await q('INSERT INTO result_clarifications(schedule_id,student_id,message) VALUES($1,$2,$3) RETURNING *',[scheduleId,req.session.user.id,message]);res.status(201).json({clarification:r.rows[0]});});
app.get('/api/result-clarifications', auth, async(req,res)=>{const u=req.session.user;let where='';let params=[];if(u.role==='student'){where='WHERE rc.student_id=$1';params=[u.id];}if(u.role==='adviser'){where='WHERE p.adviser_id=$1';params=[u.id];}const r=await q(`SELECT rc.*,u.full_name student_name,p.code,p.title,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date FROM result_clarifications rc JOIN users u ON u.id=rc.student_id JOIN schedules s ON s.id=rc.schedule_id JOIN projects p ON p.id=s.project_id ${where} ORDER BY rc.created_at DESC`,params);res.json({clarifications:r.rows});});
app.patch('/api/result-clarifications/:id', auth, requireRole('coordinator','adviser'), async(req,res)=>{const note=cleanText(req.body.resolution_note,1500);const r=await q("UPDATE result_clarifications SET status='Resolved',resolved_at=NOW(),resolution_note=$2 WHERE id=$1 RETURNING *",[Number(req.params.id),note||null]);if(!r.rowCount)return res.status(404).json({error:'Clarification not found.'});await audit(req.session.user.id,'resolve','result_clarification',Number(req.params.id),{});res.json({clarification:r.rows[0]});});

// Project plan — Coordinator only, because this is the project management record.
app.get('/api/management', auth, requireRole('coordinator'), async(_req,res)=>{
  const [wbs,gantt,budget,risks,weekly]=await Promise.all([
    q('SELECT * FROM wbs_items ORDER BY id'),q('SELECT * FROM gantt_items ORDER BY id'),q('SELECT * FROM budgets ORDER BY id'),q('SELECT * FROM risks ORDER BY id'),q('SELECT * FROM weekly_tracker ORDER BY week')
  ]);
  res.json({wbs:wbs.rows,gantt:gantt.rows,budget:budget.rows,risks:risks.rows,weekly:weekly.rows,budgetTotal:budget.rows.reduce((s,r)=>s+Number(r.total),0)});
});
app.patch('/api/weekly/:week', auth, requireRole('coordinator'), async(req,res)=>{const status=['Not started','In Progress','Completed','At Risk'].includes(req.body.status)?req.body.status:null;const progress=Math.max(0,Math.min(100,Number(req.body.progress)||0));if(!status)return res.status(400).json({error:'Invalid weekly status.'});const r=await q('UPDATE weekly_tracker SET status=$1,progress=$2 WHERE week=$3 RETURNING *',[status,progress,Number(req.params.week)]);if(!r.rowCount)return res.status(404).json({error:'Week not found.'});res.json({week:r.rows[0]});});

// Reports — Coordinator only. Each report is a complete dataset required by the project instructions.
app.get('/api/reports/summary', auth, requireRole('coordinator'), async(_req,res)=>{const [p,r,s,u,e]=await Promise.all([q('SELECT COUNT(*)::int count FROM projects'),q('SELECT COUNT(*)::int count FROM defense_requests'),q("SELECT COUNT(*)::int count FROM schedules WHERE status<>'Cancelled'"),q('SELECT COUNT(*)::int count FROM users WHERE is_active=true'),q('SELECT COUNT(*)::int count FROM evaluations')]);res.json({projects:Number(p.rows[0].count),requests:Number(r.rows[0].count),schedules:Number(s.rows[0].count),activeUsers:Number(u.rows[0].count),evaluations:Number(e.rows[0].count)});});
app.get('/api/reports/defense-schedule', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT to_char(s.defense_date,'YYYY-MM-DD') defense_date,s.start_time,s.end_time,s.defense_type,s.status,s.defense_result,p.title,COALESCE(a.full_name,'Unassigned') adviser_name,COALESCE(r.name,'Room TBA') room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN rooms r ON r.id=s.room_id ORDER BY s.defense_date,s.start_time`);res.json({rows:r.rows});});
app.get('/api/reports/panel-assignment', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT to_char(s.defense_date,'YYYY-MM-DD') defense_date,s.start_time,p.title,u.full_name,u.email,pa.panel_role FROM panel_assignments pa JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=pa.user_id ORDER BY s.defense_date,s.start_time,p.title,pa.panel_role`);res.json({rows:r.rows});});
app.get('/api/reports/student-status', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT p.title,p.type,p.status,COALESCE(a.full_name,'Unassigned') adviser_name,u.full_name student_name,u.email FROM projects p LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN project_members pm ON pm.project_id=p.id LEFT JOIN users u ON u.id=pm.student_id ORDER BY p.title,u.full_name`);res.json({rows:r.rows});});
app.get('/api/reports/evaluation', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT p.title,to_char(s.defense_date,'YYYY-MM-DD') defense_date,u.full_name evaluator_name,ROUND(((e.technical_score+e.presentation_score+e.documentation_score)/3)::numeric,1) average_score,e.recommendation,s.defense_result,e.comments FROM evaluations e JOIN schedules s ON s.id=e.schedule_id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=e.evaluator_id ORDER BY s.defense_date,p.title,u.full_name`);res.json({rows:r.rows});});
app.get('/api/audit-logs', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT al.*,u.full_name user_name FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id ORDER BY al.created_at DESC LIMIT 200`);res.json({logs:r.rows});});

app.use('/api', (err, _req, res, _next) => { console.error(err); res.status(500).json({error:'Unexpected server error.'}); });
app.use((req,res,next)=>{ if(req.method==='GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(publicRoot,'index.html')); next(); });

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>console.log(`ThesisFlow running on http://0.0.0.0:${PORT}`));
}).catch(err=>{console.error('Startup failed:',err);process.exit(1);});
