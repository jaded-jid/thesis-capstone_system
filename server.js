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
// PostgreSQL DATE (OID 1082) represents a calendar date, not a UTC instant.
// Keep it as YYYY-MM-DD text instead of allowing node-postgres to create a
// local-midnight Date that JSON serialization can shift to the previous day.
pg.types.setTypeParser(1082, value => value);
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

// The overall project-plan status is derived from its scheduled timeline.
// Use the Philippines date so hosting-server UTC settings cannot shift the status.
const PROJECT_PLAN_START_DATE = '2026-08-12';
const PROJECT_PLAN_END_DATE = '2026-11-04';
function getProjectPlanSummary() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const status = today > PROJECT_PLAN_END_DATE
    ? 'Completed'
    : today < PROJECT_PLAN_START_DATE ? 'Not started' : 'In Progress';
  return { startDate: PROJECT_PLAN_START_DATE, endDate: PROJECT_PLAN_END_DATE, today, status };
}

// The Weekly Tracker is the single source of truth for task progress.
// Each WBS work package is tied to the week(s) that produce its deliverable.
const WBS_WEEK_MAP = Object.freeze({
  '1.0': [1, 2], '1.1': [1], '1.2': [1], '1.3': [2], '1.4': Array.from({ length: 12 }, (_, i) => i + 1),
  '1.5': [2], '1.6': [2], '1.7': [2],
  '2.0': [3, 4], '2.1': [4], '2.2': [4], '2.3': [4],
  '3.0': [5, 6], '3.1': [5], '3.2': [6],
  '4.0': [7, 8], '4.1': [7], '4.2': [8], '4.3': [8],
  '5.0': [9, 10], '5.1': [9], '5.2': [9], '5.3': [10],
  '6.0': [11], '6.1': [11], '6.2': [11], '6.3': [11], '6.4': [11],
  '7.0': [12], '7.1': [12], '7.2': [12], '7.3': [12], '7.4': [12], '7.5': [12]
});

function progressFromWeeks(weekNumbers, weeklyRows) {
  const byWeek = new Map(weeklyRows.map(row => [Number(row.week), row]));
  const rows = [...new Set(weekNumbers.map(Number))].map(week => byWeek.get(week)).filter(Boolean);
  if (!rows.length) return { status: 'Planned', progress: 0 };

  const progress = Math.round(rows.reduce((total, row) => total + Math.max(0, Math.min(100, Number(row.progress) || 0)), 0) / rows.length);
  const statuses = rows.map(row => row.status);
  let status = 'Planned';
  if (statuses.every(value => value === 'Completed')) status = 'Completed';
  else if (statuses.includes('At Risk')) status = 'At Risk';
  else if (statuses.includes('In Progress') || statuses.includes('Completed')) status = 'In Progress';
  return { status, progress };
}

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
  // Use the request protocol, not NODE_ENV alone: production-mode local testing
  // over http://localhost must still receive its session cookie, while Render
  // HTTPS requests remain Secure because trust proxy is enabled above.
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(requireCsrf);

const publicRoot = path.join(__dirname, 'public');
app.use(express.static(publicRoot, { maxAge: 0, etag: true }));

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
function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // PostgreSQL DATE values are parsed by node-postgres as a local-midnight
    // Date. Do NOT use toISOString() here: in timezones east of UTC (including
    // Asia/Manila), that converts local midnight to the previous UTC date.
    // Read the calendar components in the same local timezone used by the
    // PostgreSQL DATE parser so the date chosen by the student is preserved.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = cleanText(value, 40).trim();
  // Keep date-only strings as calendar dates; never parse them through UTC.
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return raw.slice(0,10);
}
function timeMinutes(value) { const m=String(value||'').match(/^(\d{2}):(\d{2})/); return m ? Number(m[1])*60+Number(m[2]) : null; }
function manilaNowParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, minutes };
}
function assertFutureDefenseStart(date, start, now = new Date()) {
  const current = manilaNowParts(now);
  const startMinute = timeMinutes(start);
  if (date < current.date) {
    throw Object.assign(new Error('Defense schedules cannot be placed in the past. Choose today or a future date.'), { status: 400 });
  }
  if (date === current.date && (startMinute === null || startMinute <= current.minutes)) {
    throw Object.assign(new Error('The defense start time has already passed. Choose a later start time in Philippine time (Asia/Manila).'), { status: 400 });
  }
}
function defenseEndHasPassed(date, end, now = new Date()) {
  const current = manilaNowParts(now);
  const scheduledDate = normalizeDate(date);
  const endMinute = timeMinutes(end);
  if (!scheduledDate || endMinute === null) return false;
  return scheduledDate < current.date || (scheduledDate === current.date && endMinute <= current.minutes);
}
function scheduleDisplayStatus(schedule, now = new Date()) {
  if (schedule.status === 'Cancelled' || schedule.status === 'Completed') return schedule.status;
  if (schedule.panel_outcome === 'Not Conducted') return 'Not Conducted';
  if (schedule.result_status === 'Awaiting Coordinator') return 'Awaiting Coordinator Decision';
  if (schedule.panel_outcome === 'Conducted') return 'Pending Evaluation';
  if (schedule.panel_proceedance === 'Reschedule Requested') return 'Reschedule Requested';
  const current = manilaNowParts(now);
  const scheduledDate = normalizeDate(schedule.defense_date);
  const startMinute = timeMinutes(schedule.start_time);
  const endMinute = timeMinutes(schedule.end_time);
  if (!scheduledDate || startMinute === null || endMinute === null) return schedule.status || 'Unknown';
  if (scheduledDate > current.date || (scheduledDate === current.date && current.minutes < startMinute)) return 'Upcoming';
  if (scheduledDate === current.date && current.minutes < endMinute) return 'Ongoing';
  return 'Pending Confirmation';
}
function withScheduleDisplayStatus(schedule) {
  return { ...schedule, display_status: scheduleDisplayStatus(schedule) };
}
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
  return { id: u.id, full_name: u.full_name, email: u.email, role: u.role, role_label: ROLE_LABELS[u.role], is_active: u.is_active, is_primary_coordinator: Boolean(u.is_primary_coordinator), profile_image: u.profile_image || null };
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
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS result_status TEXT NOT NULL DEFAULT 'Pending'`);
  await q(`ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_result_status_check`);
  await q(`ALTER TABLE schedules ADD CONSTRAINT schedules_result_status_check CHECK (result_status IN ('Pending','Awaiting Coordinator','Finalized'))`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS result_decision_note TEXT`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS result_finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS result_finalized_at TIMESTAMPTZ`);
  await q(`UPDATE schedules SET result_status='Finalized', result_finalized_at=COALESCE(result_finalized_at,created_at) WHERE status='Completed' AND defense_result IS NOT NULL AND result_status<>'Finalized'`);
  await q(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS defense_result TEXT`);
  await q(`ALTER TABLE evaluations DROP CONSTRAINT IF EXISTS evaluations_defense_result_check`);
  await q(`ALTER TABLE evaluations ADD CONSTRAINT evaluations_defense_result_check CHECK (defense_result IS NULL OR defense_result IN ('Passed','Failed','For Revision','Re-defense Required'))`);
  await q(`ALTER TABLE projects ALTER COLUMN code DROP NOT NULL`);
  await q(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_code_key`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_proceedance TEXT NOT NULL DEFAULT 'Pending'`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_proceeded_at TIMESTAMPTZ`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_outcome TEXT`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_outcome_at TIMESTAMPTZ`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panel_outcome_note TEXT`);
  await q(`ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_panel_outcome_check`);
  await q(`ALTER TABLE schedules ADD CONSTRAINT schedules_panel_outcome_check CHECK (panel_outcome IS NULL OR panel_outcome IN ('Conducted','Not Conducted'))`);
  await q(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity INTEGER NOT NULL DEFAULT 30 CHECK (capacity > 0)`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS panel_availability TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_coordinator BOOLEAN NOT NULL DEFAULT FALSE`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS users_single_primary_coordinator_uq ON users (is_primary_coordinator) WHERE is_primary_coordinator = TRUE`);
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
  let configuredAdminId = adminExists.rowCount ? Number(adminExists.rows[0].id) : null;
  if (!adminExists.rowCount) {
    const hash = await bcrypt.hash(adminPassword, 12);
    const insertedAdmin = await q(
      'INSERT INTO users (full_name,email,password_hash,role) VALUES ($1,$2,$3,\'coordinator\') RETURNING id',
      [adminName, adminEmail, hash]
    );
    configuredAdminId = Number(insertedAdmin.rows[0].id);
  }

  // Preserve the initial ADMIN_EMAIL account as the protected main coordinator.
  // For existing databases without this flag, prefer that configured account; if
  // it is no longer a coordinator, fall back to the oldest coordinator account.
  const primaryCoordinator = await q('SELECT id FROM users WHERE is_primary_coordinator = TRUE LIMIT 1');
  if (!primaryCoordinator.rowCount) {
    let candidate = adminExists.rowCount && configuredAdminId
      ? await q("SELECT id FROM users WHERE id=$1 AND role='coordinator'", [configuredAdminId])
      : { rowCount: 0, rows: [] };
    if (!candidate.rowCount) {
      candidate = await q("SELECT id FROM users WHERE role='coordinator' ORDER BY created_at ASC, id ASC LIMIT 1");
    }
    if (candidate.rowCount) {
      await q('UPDATE users SET is_primary_coordinator = (id = $1) WHERE role=\'coordinator\'', [Number(candidate.rows[0].id)]);
    }
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

app.get('/api/session', async (req,res) => {
  try {
    if (!req.session.user) return res.json({ user: null });
    const r = await q('SELECT id,full_name,email,role,is_active,is_primary_coordinator,profile_image FROM users WHERE id=$1', [req.session.user.id]);
    if (!r.rowCount) { req.session.destroy(() => {}); return res.json({ user: null }); }
    req.session.user = serializeUser(r.rows[0]);
    res.json({ user: req.session.user });
  } catch (e) {
    console.error('Session refresh failed:', e.message);
    res.json({ user: req.session.user || null });
  }
});

app.get('/api/csrf', (req,res)=>res.json({token:ensureCsrf(req)}));

app.post('/api/login', loginLimiter, async (req,res) => {
  try {
    const email = cleanEmail(req.body.email);
    const role = cleanText(req.body.role, 40);
    const password = String(req.body.password || '');
    if (!email || !password || !validRole(role)) return res.status(400).json({ error: 'Select your role and enter your account credentials.' });
    const r = await q('SELECT id,full_name,email,password_hash,role,is_active,is_primary_coordinator,profile_image FROM users WHERE lower(email)=lower($1)', [email]);
    if (!r.rowCount) return res.status(401).json({ error: 'Invalid account credentials.' });
    const user = r.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact your Coordinator / Administrator.' });
    if (user.role !== role) return res.status(401).json({ error: 'The selected login role does not match this account.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid account credentials.' });
    const safeUser = serializeUser(user);
    await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
    req.session.user = safeUser;
    const csrfToken = ensureCsrf(req);
    await audit(user.id,'login','user',user.id,{});
    // Persist the regenerated session before returning success. The browser
    // immediately calls /api/dashboard after this response; explicitly saving
    // avoids a race where that request arrives before the session store write.
    await new Promise((resolve, reject) => {
      req.session.save(error => error ? reject(error) : resolve());
    });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({ user: req.session.user, csrfToken });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to sign in.' }); }
});

app.post('/api/logout', (req,res) => req.session.destroy(() => res.json({ ok:true })));

app.get('/api/dashboard', auth, async (req,res) => {
  await syncCompletedDefenseRequests();
  const user = req.session.user;
  const params = [];
  let projectWhere = '';
  if (user.role === 'student') { params.push(user.id); projectWhere = 'WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))'; }
  if (user.role === 'adviser') { params.push(user.id); projectWhere = 'WHERE p.adviser_id=$1'; }
  if (user.role === 'panel_member') { params.push(user.id); projectWhere = 'WHERE EXISTS (SELECT 1 FROM panel_assignments pa JOIN schedules ss ON ss.id=pa.schedule_id WHERE ss.project_id=p.id AND pa.user_id=$1)'; }

  const projects = await q(`SELECT p.id,p.code,p.title,p.type,p.status,p.adviser_id,COALESCE(u.full_name,'Unassigned') adviser_name,
    COALESCE((SELECT json_agg(json_build_object('id',sm.student_id,'full_name',su.full_name) ORDER BY su.full_name)
      FROM project_members sm JOIN users su ON su.id=sm.student_id WHERE sm.project_id=p.id),'[]'::json) AS students
    FROM projects p LEFT JOIN users u ON u.id=p.adviser_id ${projectWhere} ORDER BY p.created_at DESC`, params);
  let scheduleWhere = '', scheduleParams = [];
  if (user.role === 'student') { scheduleWhere='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))'; scheduleParams=[user.id]; }
  if (user.role === 'adviser') { scheduleWhere='WHERE p.adviser_id=$1'; scheduleParams=[user.id]; }
  if (user.role === 'panel_member') { scheduleWhere='WHERE EXISTS (SELECT 1 FROM panel_assignments pa WHERE pa.schedule_id=s.id AND pa.user_id=$1)'; scheduleParams=[user.id]; }
  const scheduleBaseWhere = scheduleWhere ? `${scheduleWhere} AND s.status <> 'Cancelled'` : "WHERE s.status <> 'Cancelled'";
  const scheduleResult = await q(`SELECT s.id,s.project_id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.result_status,s.panel_proceedance,s.panel_outcome,s.panel_outcome_at,s.panel_outcome_note,s.defense_result,p.code,p.title,r.name room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN rooms r ON r.id=s.room_id ${scheduleBaseWhere} ORDER BY s.defense_date,s.start_time`, scheduleParams);
  const schedules = scheduleResult.rows.map(withScheduleDisplayStatus);

  let requestWhere = '', requestParams = [];
  if (user.role === 'student') { requestWhere='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))'; requestParams=[user.id]; }
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
  const upcoming = schedules.filter(s=>s.display_status==='Upcoming').length;

  res.json({ role:user.role, counts:{ projects:projects.rowCount, pending_requests:pending, upcoming, assigned_defenses:Number(assigned.rows[0].count), evaluations:Number(evaluations.rows[0].count), available_rooms:Number(availableRooms.rows[0].count), active_users:Number(activeUsers.rows[0].count), progress:Number(progressQ.rows[0].progress) }, projectPlan:getProjectPlanSummary(), projects:projects.rows, schedules, requests:requests.rows });
});

// User management — Coordinator only. No public registration endpoint exists.
app.get('/api/users', auth, requireRole('coordinator'), async (_req,res) => {
  res.set('Cache-Control','no-store, no-cache, must-revalidate, private');
  const r = await q('SELECT id,full_name,email,role,is_active,is_primary_coordinator,created_at,updated_at,panel_availability,profile_image FROM users ORDER BY full_name');
  res.json({ users:r.rows });
});
app.get('/api/users/:id/profile-image', auth, requireRole('coordinator'), async (req,res) => {
  try {
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0) return res.status(400).end();
    const r=await q('SELECT profile_image FROM users WHERE id=$1',[id]);
    if(!r.rowCount || !r.rows[0].profile_image) return res.status(404).end();
    const m=String(r.rows[0].profile_image).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!m) return res.status(404).end();
    res.set('Cache-Control','no-store, no-cache, must-revalidate, private');
    res.type(m[1]).send(Buffer.from(m[2],'base64'));
  } catch(e) { console.error('Profile image endpoint failed:',e.message); res.status(500).end(); }
});
app.get('/api/advisers', auth, requireRole('coordinator'), async (_req,res) => {
  // Return assignment information so already-assigned advisers can be disabled in the form.
  const r = await q(`
    SELECT u.id,u.full_name,u.email,assigned.project_titles AS assigned_project_title
    FROM users u
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT p.title, ', ' ORDER BY p.title) AS project_titles
      FROM projects p WHERE p.adviser_id=u.id
    ) assigned ON TRUE
    WHERE u.role='adviser' AND u.is_active=true
    ORDER BY u.full_name
  `);
  res.json({ users:r.rows });
});
app.get('/api/students', auth, requireRole('coordinator'), async (_req,res) => {
  // Check both the legacy student_ids array and normalized project_members table.
  const r = await q(`
    SELECT u.id,u.full_name,u.email,assigned.project_titles AS assigned_project_title
    FROM users u
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT p.title, ', ' ORDER BY p.title) AS project_titles
      FROM projects p
      WHERE u.id=ANY(COALESCE(p.student_ids, ARRAY[]::int[]))
         OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=u.id)
    ) assigned ON TRUE
    WHERE u.role='student' AND u.is_active=true
    ORDER BY u.full_name
  `);
  res.json({ users:r.rows });
});
app.post('/api/users', auth, requireRole('coordinator'), async (req,res) => {
  const name=cleanText(req.body.full_name,120), email=cleanEmail(req.body.email), password=String(req.body.password||''), role=cleanText(req.body.role,40);
  if (!name || !email || password.length < 8 || !validRole(role)) return res.status(400).json({ error:'Provide a name, valid email, role, and password of at least 8 characters.' });
  const exists=await q('SELECT id FROM users WHERE lower(email)=lower($1)',[email]);
  if (exists.rowCount) return res.status(409).json({ error:'An account with this email already exists.' });
  const hash=await bcrypt.hash(password,12);
  const r=await q('INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,full_name,email,role,is_active,created_at,panel_availability',[name,email,hash,role]);
  await audit(req.session.user.id,'create','user',r.rows[0].id,{role});
  res.status(201).json({ user:r.rows[0] });
});
app.patch('/api/profile', auth, async (req,res) => {
  try {
    const id = req.session.user.id;
    const existing = await q('SELECT id,full_name,email,password_hash,role,is_active,is_primary_coordinator,profile_image FROM users WHERE id=$1',[id]);
    if (!existing.rowCount) return res.status(404).json({ error:'Account not found.' });
    const current = existing.rows[0];
    const isCoordinator = current.role==='coordinator';
    const name = isCoordinator && req.body.full_name !== undefined ? cleanText(req.body.full_name,120) : current.full_name;
    const email = isCoordinator && req.body.email !== undefined ? cleanEmail(req.body.email) : current.email;
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const profileImage = req.body.profile_image === undefined ? current.profile_image : (req.body.profile_image ? String(req.body.profile_image) : null);
    if (profileImage && (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(profileImage) || profileImage.length > 850000)) return res.status(400).json({ error:'Profile image must be a PNG, JPG, or WebP image under 600 KB.' });
    if (!name || !email) return res.status(400).json({ error:'Name and email are required.' });
    if (isCoordinator) {
      const exists = await q('SELECT id FROM users WHERE lower(trim(email))=lower(trim($1)) AND id<>$2',[email,id]);
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
    const r = await q('UPDATE users SET full_name=$1,email=$2,password_hash=$3,profile_image=$4,updated_at=NOW() WHERE id=$5 RETURNING id,full_name,email,role,is_active,is_primary_coordinator,profile_image',[name,email,hash,profileImage,id]);
    if (!r.rowCount) return res.status(404).json({ error:'Account could not be updated.' });
    req.session.user = serializeUser(r.rows[0]);
    res.json({ user:req.session.user });
  } catch (e) {
    console.error('Profile update failed:', e);
    if (e?.code === '23505') return res.status(409).json({ error:'That email address is already in use.' });
    res.status(500).json({ error:'Unable to update profile. Please try again.' });
  }
});

app.patch('/api/users/:id', auth, requireRole('coordinator'), async (req,res) => {
  try {
    const id=Number(req.params.id);
    if (!Number.isInteger(id) || id<=0) return res.status(400).json({error:'Invalid user id.'});
    const target=await q('SELECT id,full_name,email,password_hash,role,is_active,is_primary_coordinator,panel_availability,profile_image FROM users WHERE id=$1',[id]);
    if(!target.rowCount)return res.status(404).json({error:'User not found.'});
    const user=target.rows[0];
    if (user.is_primary_coordinator) return res.status(403).json({error:'The main Coordinator / Administrator account is protected from changes through User Management. Use My Profile to update its details.'});
    const name=cleanText(req.body.full_name,120), email=cleanEmail(req.body.email), password=String(req.body.password||''), role=cleanText(req.body.role,40);
    if(!name||!email||!validRole(role))return res.status(400).json({error:'Name and email are required.'});
    const exists=await q('SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2',[email,id]);
    if(exists.rowCount)return res.status(409).json({error:'That email address is already in use.'});
    let hash=user.password_hash;
    if(password){if(password.length<8)return res.status(400).json({error:'New password must be at least 8 characters.'});hash=await bcrypt.hash(password,12);}
    const r=await q('UPDATE users SET full_name=$1,email=$2,password_hash=$3,role=$4,updated_at=NOW() WHERE id=$5 RETURNING id,full_name,email,role,is_active,created_at,panel_availability,profile_image',[name,email,hash,role,id]);
    await audit(req.session.user.id,'update','user',id,{});
    res.json({user:r.rows[0]});
  } catch(e){console.error(e);res.status(500).json({error:'Unable to update user account.'});}
});

app.delete('/api/users/:id', auth, requireRole('coordinator'), async (req,res)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid user id.'});
    const roleCheck=await q('SELECT role,is_primary_coordinator FROM users WHERE id=$1',[id]);
    if(!roleCheck.rowCount)return res.status(404).json({error:'User not found.'});
    if(id===req.session.user.id)return res.status(400).json({error:'Your own administrator account cannot be deleted.'});
    if(roleCheck.rows[0].is_primary_coordinator)return res.status(403).json({error:'The main Coordinator / Administrator account is protected and cannot be deleted by another coordinator.'});
    if(roleCheck.rows[0].role==='coordinator'){const activeAdmins=await q("SELECT COUNT(*)::int count FROM users WHERE role='coordinator' AND is_active=true");if(Number(activeAdmins.rows[0].count)<=1)return res.status(400).json({error:'At least one active Coordinator / Administrator account must remain.'});}
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
  if (!Number.isInteger(id) || id<=0) return res.status(400).json({error:'Invalid user id.'});
  if (typeof req.body.is_active !== 'boolean') return res.status(400).json({error:'Account status must be true or false.'});
  const target=await q('SELECT id,role,is_active,is_primary_coordinator FROM users WHERE id=$1',[id]);
  if (!target.rowCount) return res.status(404).json({error:'User not found.'});
  if (id===req.session.user.id && req.body.is_active === false) return res.status(400).json({ error:'Your own administrator account cannot be deactivated here.' });
  if (target.rows[0].is_primary_coordinator && req.body.is_active === false) {
    return res.status(403).json({error:'The main Coordinator / Administrator account cannot be deactivated by another coordinator.'});
  }
  if(req.body.is_active===false && target.rows[0].role==='coordinator'){const activeAdmins=await q("SELECT COUNT(*)::int count FROM users WHERE role='coordinator' AND is_active=true");if(Number(activeAdmins.rows[0].count)<=1)return res.status(400).json({error:'At least one active Coordinator / Administrator account must remain.'});}
  const r=await q('UPDATE users SET is_active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,full_name,email,role,is_active,is_primary_coordinator',[req.body.is_active,id]);
  if (!r.rowCount) return res.status(404).json({ error:'User not found.' });
  await audit(req.session.user.id, req.body.is_active ? 'activate' : 'deactivate', 'user', id, { primaryCoordinator: Boolean(r.rows[0].is_primary_coordinator) });
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
                     WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::integer[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))
                     ORDER BY p.created_at DESC`, [req.session.user.id]);
  const projectIds=r.rows.map(p=>Number(p.id));
  let activeByProject=new Map();
  if(projectIds.length){
    const schedules=await q(`SELECT s.id,s.project_id,s.defense_type,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,
      to_char(s.start_time,'HH24:MI') AS start_time,to_char(s.end_time,'HH24:MI') AS end_time,
      s.status,s.panel_outcome,s.panel_proceedance
      FROM schedules s WHERE s.project_id=ANY($1::int[]) AND s.status='Upcoming'
      ORDER BY s.defense_date,s.start_time,s.id`,[projectIds]);
    for(const schedule of schedules.rows){
      const projectId=Number(schedule.project_id);
      if(!activeByProject.has(projectId))activeByProject.set(projectId,{
        id:Number(schedule.id),defense_type:schedule.defense_type,defense_date:schedule.defense_date,
        start_time:schedule.start_time,end_time:schedule.end_time,display_status:scheduleDisplayStatus(schedule)
      });
    }
  }
  res.json({ projects:r.rows.map(p=>({...p,active_defense:activeByProject.get(Number(p.id))||null})) });
});
app.post('/api/projects', auth, requireRole('coordinator'), async (req,res) => {
  const title=cleanText(req.body.title,240);
  const type=req.body.type==='Capstone'?'Capstone':req.body.type==='Thesis'?'Thesis':null;
  const adviserId=Number(req.body.adviser_id)||null;
  // A project may contain any number of students; deduplicate IDs but impose no group-size cap.
  const studentIds=Array.isArray(req.body.student_ids)
    ? [...new Set(req.body.student_ids.map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))]
    : [];
  if (!title) return res.status(400).json({ error:'Project title is required.' });
  if (!type) return res.status(400).json({ error:'Choose Thesis or Capstone as the project type.' });
  if (studentIds.length < 1) return res.status(400).json({ error:'Select at least one student for a project.' });
  if (!Number.isSafeInteger(adviserId) || adviserId<=0) return res.status(400).json({ error:'Please select an active adviser.' });

  // Lock all selected account rows in a consistent order. This makes the conflict
  // check and insert atomic even when two coordinators submit at the same time.
  const client=await pool.connect();
  let createdProject;
  try {
    await client.query('BEGIN');
    const lockedIds=[...new Set([...studentIds,adviserId])].sort((a,b)=>a-b);
    const locked=await client.query(
      'SELECT id,role,is_active,full_name FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',
      [lockedIds]
    );
    const lockedById=new Map(locked.rows.map(row=>[Number(row.id),row]));
    const adviser=lockedById.get(adviserId);
    if (!adviser || adviser.role!=='adviser' || !adviser.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error:'Please select an active adviser.' });
    }
    if (studentIds.some(id=>!lockedById.has(id)||lockedById.get(id).role!=='student'||!lockedById.get(id).is_active)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error:'All selected students must be active student accounts.' });
    }

    // A person may only be assigned to one project record. Check both assignment
    // representations so older records cannot bypass the rule.
    const conflicts=await client.query(`
      SELECT 'adviser'::text AS assignment_type,u.id AS person_id,u.full_name,p.id AS project_id,p.title AS project_title
      FROM projects p JOIN users u ON u.id=p.adviser_id
      WHERE p.adviser_id=$1
      UNION ALL
      SELECT 'student'::text AS assignment_type,u.id AS person_id,u.full_name,p.id AS project_id,p.title AS project_title
      FROM projects p JOIN users u ON u.id=ANY($2::int[])
      WHERE u.id=ANY(COALESCE(p.student_ids, ARRAY[]::int[]))
         OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=u.id)
      ORDER BY assignment_type,full_name,project_title
    `,[adviserId,studentIds]);

    if (conflicts.rowCount) {
      await client.query('ROLLBACK');
      const conflictDetails=conflicts.rows.map(row=>({
        type:row.assignment_type,
        person:row.full_name,
        project:row.project_title,
        project_id:Number(row.project_id)
      }));
      const names=conflictDetails.map(row=>`${row.type==='adviser'?'Adviser':'Student'} ${row.person} is already assigned to “${row.project}”`);
      return res.status(409).json({
        error:`Cannot create this project. ${names.join('; ')}. Choose unassigned people or remove the existing project if it was created by mistake.`,
        conflicts:conflictDetails
      });
    }

    const result=await client.query(
      'INSERT INTO projects(title,type,student_ids,adviser_id) VALUES($1,$2,$3,$4) RETURNING *',
      [title,type,studentIds,adviserId]
    );
    createdProject=result.rows[0];
    for (const sid of studentIds) {
      await client.query('INSERT INTO project_members(project_id,student_id) VALUES($1,$2)',[createdProject.id,sid]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Project creation failed:',e);
    return res.status(500).json({ error:'Unable to create the project. No project was saved; please try again.' });
  } finally {
    client.release();
  }

  await audit(req.session.user.id,'create','project',createdProject.id,{student_ids:studentIds,adviser_id:adviserId});
  res.status(201).json({ project:createdProject });
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
  if (u.role==='student') { where='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))'; params=[u.id]; }
  // PostgreSQL DATE is a calendar date, not a timestamp. Format it as text
  // before it leaves the API so Node/browser timezone conversion cannot move
  // the preferred date to the previous day for the coordinator.
  const r=await q(`SELECT dr.id,dr.project_id,dr.defense_type,
    to_char(dr.preferred_date,'YYYY-MM-DD') AS preferred_date,
    dr.preferred_time,dr.reason,dr.submitted_by,dr.status,dr.review_feedback,
    dr.created_at,dr.updated_at,p.code,p.title,p.adviser_id,
    COALESCE(a.full_name,'Unassigned') adviser_name
    FROM defense_requests dr JOIN projects p ON p.id=dr.project_id
    LEFT JOIN users a ON a.id=p.adviser_id ${where} ORDER BY dr.created_at DESC`,params);
  res.json({ requests:r.rows });
});
app.post('/api/defense-requests', auth, requireRole('student'), async (req,res) => {
  const projectId=Number(req.body.project_id), type=req.body.defense_type==='Final Defense'?'Final Defense':'Proposal Defense';
  const date=cleanText(req.body.preferred_date,20), time=cleanText(req.body.preferred_time,20), reason=cleanText(req.body.reason,800);
  if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error:'Select an assigned project.' });
  if (!validDate(date) || !validTime(time)) return res.status(400).json({ error:'Enter a valid preferred date and time.' });
  try { assertFutureDefenseStart(date, time); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const owns=await q(`SELECT p.id,p.title,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name
                       FROM projects p LEFT JOIN users a ON a.id=p.adviser_id
                       WHERE p.id=$1 AND ($2=ANY(COALESCE(p.student_ids, ARRAY[]::integer[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$2))`,[projectId,req.session.user.id]);
  if (!owns.rowCount) return res.status(403).json({ error:'You can only submit a request for a project assigned to you.' });
  const activeSchedule=await q(`SELECT s.id,s.defense_type,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,
    to_char(s.start_time,'HH24:MI') AS start_time,to_char(s.end_time,'HH24:MI') AS end_time,
    s.status,s.panel_outcome,s.panel_proceedance
    FROM schedules s WHERE s.project_id=$1 AND s.status='Upcoming'
    ORDER BY s.defense_date,s.start_time,s.id LIMIT 1`,[projectId]);
  if(activeSchedule.rowCount){
    const active=activeSchedule.rows[0];
    const displayStatus=scheduleDisplayStatus(active);
    return res.status(409).json({error:`This project already has an active ${active.defense_type.toLowerCase()} scheduled for ${active.defense_date} at ${String(active.start_time).slice(0,5)} (${displayStatus}). You cannot submit another defense request until this schedule is completed or cancelled.`});
  }
  const duplicate=await q(`SELECT id FROM defense_requests WHERE project_id=$1 AND status IN ('Pending','Approved','Scheduled')`,[projectId]);
  if (duplicate.rowCount) return res.status(409).json({ error:'This project already has an active defense request.' });
  const r=await q(`INSERT INTO defense_requests(project_id,defense_type,preferred_date,preferred_time,reason,submitted_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,project_id,defense_type,to_char(preferred_date,'YYYY-MM-DD') AS preferred_date,preferred_time,reason,submitted_by,status,review_feedback,created_at,updated_at`,[projectId,type,date,time,reason,req.session.user.id]);
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
  const date=normalizeDate(dr.preferred_date);
  const start=String(dr.preferred_time ?? '').slice(0,5);
  const duration=Math.max(30,Number(process.env.DEFAULT_DEFENSE_DURATION_MINUTES||120));
  const end=addMinutesToTime(start,duration);
  if(!end) throw new Error('The preferred time plus the default defense duration goes past midnight. Choose an earlier time.');
  if(!validDate(date)||!validTime(start)) throw Object.assign(new Error('The requested date or time is invalid.'),{status:400});
  assertFutureDefenseStart(date, start);
  const conflicts=await scheduleConflictsWithClient(client,{projectId:dr.project_id,date,start,end,roomId:null});
  if(conflicts.length){const error=new Error('The preferred date and time conflicts with another defense, student, adviser, panel, or room schedule. Resolve the conflict before approving this request.');error.code='SCHEDULE_CONFLICT';throw error;}
  const existing=await client.query("SELECT id FROM schedules WHERE request_id=$1 AND status<>'Cancelled' LIMIT 1",[requestId]); if(existing.rowCount) return existing.rows[0];
  const schedule=await client.query(`INSERT INTO schedules(project_id,request_id,defense_type,defense_date,start_time,end_time,room_id,notes) VALUES($1,$2,$3,$4,$5,$6,NULL,$7) RETURNING *`,[dr.project_id,requestId,dr.defense_type,date,start,end,'Automatically scheduled from the approved student request. Room and panel assignment pending.']);
  await client.query("UPDATE defense_requests SET status='Scheduled',updated_at=NOW() WHERE id=$1",[requestId]);
  return schedule.rows[0];
 });
}

app.patch('/api/defense-requests/:id/review', auth, requireRole('coordinator'), async (req,res) => {
  const id=Number(req.params.id);
  const status=String(req.body.status||'');
  const feedback=cleanText(req.body.feedback,1200);
  const scheduleNow=Boolean(req.body.schedule_now);
  if (!['Approved','Returned'].includes(status)) return res.status(400).json({ error:'Choose Approve or Return with Feedback.' });
  if (status === 'Returned' && !feedback) return res.status(400).json({ error:'Feedback is required when returning a request.' });
  const request=await q(`SELECT dr.*,p.adviser_id FROM defense_requests dr JOIN projects p ON p.id=dr.project_id WHERE dr.id=$1`,[id]);
  if (!request.rowCount) return res.status(404).json({error:'Request not found.'});
  if (request.rows[0].status !== 'Pending') return res.status(409).json({error:'This defense request has already been reviewed.'});
  if (req.session.user.role==='adviser' && request.rows[0].adviser_id!==req.session.user.id) return res.status(403).json({error:'You can only review requests for your assigned projects.'});
  if (status==='Approved' && scheduleNow) {
    try {
      const schedule = await createAutomaticScheduleForRequest(id);
      const scheduledNote=`Scheduled — ${normalizeDate(schedule.defense_date)} ${String(schedule.start_time).slice(0,5)}.`;
      const r=await q("UPDATE defense_requests SET status='Scheduled',review_feedback=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[scheduledNote,id]);
      await audit(req.session.user.id,'approve_proceed','defense_request',id,{feedback,schedule_id:schedule.id,scheduled_automatically:true});
      return res.json({ request:r.rows[0], schedule, scheduledAutomatically:true });
    } catch (e) {
      if (e.code==='SCHEDULE_CONFLICT') return res.status(409).json({error:e.message});
      if (e.status) return res.status(e.status).json({error:e.message});
      console.error('Approve/proceed defense request failed:', e);
      return res.status(500).json({error:'Unable to proceed to defense and create the automatic schedule. Please verify the requested date/time and try again.'});
    }
  }
  if (status==='Approved') {
    const r=await q("UPDATE defense_requests SET status='Approved',review_feedback=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[feedback,id]);
    await audit(req.session.user.id,'approve_ready','defense_request',id,{feedback,scheduled_automatically:false});
    return res.json({ request:r.rows[0], scheduledAutomatically:false });
  }
  const r=await q("UPDATE defense_requests SET status='Returned',review_feedback=$1,updated_at=NOW() WHERE id=$2 RETURNING *",[feedback,id]);
  await audit(req.session.user.id,'return','defense_request',id,{feedback});
  res.json({ request:r.rows[0], scheduledAutomatically:false });
});

// Student resubmission of returned defense requests.
app.patch('/api/defense-requests/:id/resubmit', auth, requireRole('student'), async(req,res)=>{
 const id=Number(req.params.id), date=normalizeDate(req.body.preferred_date), time=cleanText(req.body.preferred_time,20), reason=cleanText(req.body.reason,800);
 if(!validDate(date)||!validTime(time))return res.status(400).json({error:'Enter a valid preferred date and time.'});
 try { assertFutureDefenseStart(date, time); } catch (e) { return res.status(e.status || 400).json({error:e.message}); }
 const own=await q(`SELECT dr.id,dr.project_id,p.student_ids FROM defense_requests dr JOIN projects p ON p.id=dr.project_id WHERE dr.id=$1 AND ($2=ANY(COALESCE(p.student_ids, ARRAY[]::integer[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$2))`,[id,req.session.user.id]);
 if(!own.rowCount)return res.status(403).json({error:'You can only revise a request for your own project.'});
 const activeSchedule=await q(`SELECT s.defense_type,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,to_char(s.start_time,'HH24:MI') AS start_time,s.status,s.panel_outcome,s.panel_proceedance FROM schedules s WHERE s.project_id=$1 AND s.status='Upcoming' ORDER BY s.defense_date,s.start_time,s.id LIMIT 1`,[own.rows[0].project_id]);
 if(activeSchedule.rowCount){const active=activeSchedule.rows[0];return res.status(409).json({error:`This project already has an active ${active.defense_type.toLowerCase()} scheduled for ${active.defense_date} at ${String(active.start_time).slice(0,5)}. You cannot resubmit another defense request until this schedule is completed or cancelled.`});}
 const r=await q(`UPDATE defense_requests SET preferred_date=$1,preferred_time=$2,reason=$3,status='Pending',review_feedback=NULL,updated_at=NOW() WHERE id=$4 AND status='Returned' RETURNING id,project_id,defense_type,to_char(preferred_date,'YYYY-MM-DD') AS preferred_date,preferred_time,reason,submitted_by,status,review_feedback,created_at,updated_at`,[date,time,reason,id]);
 if(!r.rowCount)return res.status(409).json({error:'This request is not available for resubmission.'});
 await audit(req.session.user.id,'resubmit','defense_request',id,{}); res.json({request:r.rows[0]});
});

// Room Management — coordinators can maintain room capacity and availability.
app.get('/api/rooms', auth, requireRole('coordinator'), async (req,res)=>{
  const date=normalizeDate(req.query.date||'');
  const start=cleanText(req.query.start||'',20);
  const end=cleanText(req.query.end||'',20);
  const excludeId=Number(req.query.exclude_id)||null;
  const hasSlot=validDate(date)&&validTime(start)&&validTime(end)&&timeMinutes(start)<timeMinutes(end);
  let rooms=(await q('SELECT id,name,location,capacity,is_available FROM rooms ORDER BY name')).rows;
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
  const capacity=Number(req.body.capacity);
  if(!name||!location)return res.status(400).json({error:'Room name and location are required.'});
  if(!validPositiveInt(capacity)||capacity>10000)return res.status(400).json({error:'Room capacity must be a whole number between 1 and 10000 people.'});
  try { const r=await q('INSERT INTO rooms(name,location,capacity,is_available) VALUES($1,$2,$3,true) RETURNING *',[name,location,capacity]); res.status(201).json({room:r.rows[0]}); }
  catch { res.status(409).json({error:'A room with this name already exists.'}); }
});
app.patch('/api/rooms/:id', auth, requireRole('coordinator'), async(req,res)=>{
  const id=Number(req.params.id);
  const name=cleanText(req.body.name,100), location=cleanText(req.body.location,160);
  const hasName=Object.prototype.hasOwnProperty.call(req.body,'name');
  const hasLocation=Object.prototype.hasOwnProperty.call(req.body,'location');
  const hasAvail=Object.prototype.hasOwnProperty.call(req.body,'is_available');
  const hasCapacity=Object.prototype.hasOwnProperty.call(req.body,'capacity');
  const capacity=hasCapacity?Number(req.body.capacity):null;
  if(hasCapacity&&(!validPositiveInt(capacity)||capacity>10000))return res.status(400).json({error:'Room capacity must be a whole number between 1 and 10000 people.'});
  try{
    const r=await q(`UPDATE rooms SET name=CASE WHEN $1 THEN $2 ELSE name END, location=CASE WHEN $3 THEN $4 ELSE location END, is_available=CASE WHEN $5 THEN $6 ELSE is_available END, capacity=CASE WHEN $7 THEN $8 ELSE capacity END WHERE id=$9 RETURNING *`,[hasName,name,hasLocation,location,hasAvail,!!req.body.is_available,hasCapacity,capacity,id]);
    if(!r.rowCount)return res.status(404).json({error:'Room not found.'});
    await audit(req.session.user.id,'update','room',id,{capacity:hasCapacity?capacity:undefined});
    res.json({room:r.rows[0]});
  }catch(e){res.status(409).json({error:'Unable to update room. The room name may already exist or the room is still in use.'});}
});
app.delete('/api/rooms/:id', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id);const used=await q("SELECT COUNT(*)::int count FROM schedules WHERE room_id=$1 AND status<>'Cancelled'",[id]);if(Number(used.rows[0].count)>0)return res.status(409).json({error:'This room is assigned to an active defense. Mark it unavailable instead of deleting it.'});const r=await q('DELETE FROM rooms WHERE id=$1 RETURNING id,name',[id]);if(!r.rowCount)return res.status(404).json({error:'Room not found.'});await audit(req.session.user.id,'delete','room',id,{});res.json({room:r.rows[0]});});

app.get('/api/schedules', auth, async(req,res)=>{
 const u=req.session.user; let where='';let params=[]; if(u.role==='student'){where='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))';params=[u.id];} if(u.role==='adviser'){where='WHERE p.adviser_id=$1';params=[u.id];} if(u.role==='panel_member'){where="WHERE EXISTS (SELECT 1 FROM panel_assignments pa WHERE pa.schedule_id=s.id AND pa.user_id=$1) AND s.status NOT IN ('Cancelled')";params=[u.id];}
 const r=await q(`SELECT s.id,s.project_id,s.request_id,s.defense_type,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.room_id,s.status,s.defense_result,s.result_status,s.panel_proceedance,s.panel_proceeded_at,s.panel_outcome,s.panel_outcome_at,s.panel_outcome_note,s.notes,s.created_at,p.title,p.type,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name,r.name room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN rooms r ON r.id=s.room_id ${where} ORDER BY s.defense_date,s.start_time`,params);
 res.json({schedules:r.rows.map(withScheduleDisplayStatus)});
});
async function saveSchedule(payload, userId, excludeId=null){
 const projectId=Number(payload.project_id),requestId=Number(payload.request_id)||null,date=normalizeDate(payload.defense_date),start=cleanText(payload.start_time,20),end=cleanText(payload.end_time,20),roomId=Number(payload.room_id)||null,type=payload.defense_type==='Final Defense'?'Final Defense':'Proposal Defense',notes=cleanText(payload.notes,1000);
 if(!validPositiveInt(projectId)||!validDate(date)||!validTime(start)||!validTime(end))throw Object.assign(new Error('Project, date, start time, and end time are required in a valid format.'),{status:400});
 if(timeMinutes(start)>=timeMinutes(end))throw Object.assign(new Error('End time must be after start time.'),{status:400});
 assertFutureDefenseStart(date, start);
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
  let r; if(excludeId){
    const prior=await client.query(`SELECT project_id,to_char(defense_date,'YYYY-MM-DD') AS defense_date,to_char(start_time,'HH24:MI') AS start_time,to_char(end_time,'HH24:MI') AS end_time FROM schedules WHERE id=$1`,[excludeId]);
    if(!prior.rowCount)throw Object.assign(new Error('Schedule not found.'),{status:404});
    const old=prior.rows[0];
    const slotChanged=Number(old.project_id)!==projectId||old.defense_date!==date||String(old.start_time).slice(0,5)!==start.slice(0,5)||String(old.end_time).slice(0,5)!==end.slice(0,5);
    const resetLifecycle=slotChanged?",panel_proceedance='Pending',panel_proceeded_at=NULL,panel_outcome=NULL,panel_outcome_at=NULL,panel_outcome_note=NULL":'';
    r=await client.query(`UPDATE schedules SET project_id=$1,request_id=$2,defense_type=$3,defense_date=$4,start_time=$5,end_time=$6,room_id=$7,notes=$8${resetLifecycle} WHERE id=$9 RETURNING *`,[projectId,resolvedRequestId,type,date,start,end,roomId,notes,excludeId]);
  } else {r=await client.query(`INSERT INTO schedules(project_id,request_id,defense_type,defense_date,start_time,end_time,room_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[projectId,resolvedRequestId,type,date,start,end,roomId,notes]);}
  if(resolvedRequestId){
    await client.query(`UPDATE defense_requests SET status='Scheduled',review_feedback=$2,updated_at=NOW() WHERE id=$1 AND status <> 'Completed'`,[resolvedRequestId,`Scheduled — ${date} ${start.slice(0,5)}${roomId?' · Room assigned':''}.`]);
  }
  return r.rows[0];
 });
}
app.post('/api/schedules', auth, requireRole('coordinator'), async(req,res)=>{try{const schedule=await saveSchedule(req.body,req.session.user.id);await audit(req.session.user.id,'create','schedule',schedule.id,{project_id:schedule.project_id});res.status(201).json({schedule});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to save defense schedule.',...(e.conflicts?{conflicts:e.conflicts}:{})});}});
app.patch('/api/schedules/:id', auth, requireRole('coordinator'), async(req,res)=>{try{const current=await q('SELECT * FROM schedules WHERE id=$1',[Number(req.params.id)]);if(!current.rowCount)return res.status(404).json({error:'Schedule not found.'});if(current.rows[0].status!=='Upcoming'||current.rows[0].panel_outcome==='Conducted')return res.status(409).json({error:'Only active schedules that have not been confirmed as conducted can be edited.'});const payload={...current.rows[0],...req.body,defense_date:normalizeDate(req.body.defense_date||current.rows[0].defense_date),start_time:cleanText(req.body.start_time||current.rows[0].start_time,20),end_time:cleanText(req.body.end_time||current.rows[0].end_time,20)};const schedule=await saveSchedule(payload,req.session.user.id,Number(req.params.id));await audit(req.session.user.id,'update','schedule',schedule.id,{});res.json({schedule});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to update defense schedule.',...(e.conflicts?{conflicts:e.conflicts}:{})});}});
app.patch('/api/schedules/:id/cancel', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id);const r=await q("UPDATE schedules SET status='Cancelled' WHERE id=$1 AND status='Upcoming' AND panel_outcome IS NULL RETURNING id,status,request_id",[id]); if(!r.rowCount)return res.status(409).json({error:'This schedule cannot be cancelled because it is not an active, unconfirmed defense. Preserve confirmed outcomes and completed evaluations.'}); if(r.rows[0].request_id)await q("UPDATE defense_requests SET status='Returned',review_feedback='Defense schedule was cancelled. Please submit a revised request if needed.',updated_at=NOW() WHERE id=$1 AND status='Scheduled'",[r.rows[0].request_id]); await audit(req.session.user.id,'cancel','schedule',id,{});res.json({schedule:r.rows[0]});});

// Panel assignments
app.get('/api/panels', auth, async(req,res)=>{
 const u=req.session.user;
 if(u.role==='panel_member'){
   const r=await q(`SELECT pa.id,pa.schedule_id,pa.user_id,pa.panel_role,u.full_name,u.email,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.result_status,s.panel_proceedance,s.panel_outcome,s.panel_outcome_at,s.panel_outcome_note,p.title FROM panel_assignments pa JOIN users u ON u.id=pa.user_id JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id WHERE pa.user_id=$1 AND s.status NOT IN ('Cancelled') ORDER BY s.defense_date,s.start_time,pa.panel_role`,[u.id]);
   return res.json({assignments:r.rows.map(withScheduleDisplayStatus)});
 }
 let where='';let params=[];
 if(u.role==='student'){where='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))';params=[u.id];}
 if(u.role==='adviser'){where='WHERE p.adviser_id=$1';params=[u.id];}
 if(u.role==='coordinator' || u.role==='administrator'){where='';params=[];}
 const r=await q(`SELECT pa.id,pa.schedule_id,pa.user_id,pa.panel_role,u.full_name,u.email,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.result_status,s.panel_proceedance,s.panel_outcome,s.panel_outcome_at,s.panel_outcome_note,p.title FROM panel_assignments pa JOIN users u ON u.id=pa.user_id JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id ${where} ORDER BY s.defense_date,s.start_time,pa.panel_role`,params);res.json({assignments:r.rows.map(withScheduleDisplayStatus)});
});
app.get('/api/panel-options', auth, requireRole('coordinator'), async(_req,res)=>{
 const panelMembers=(await q("SELECT id,full_name,email,role,panel_availability FROM users WHERE role='panel_member' AND is_active=true ORDER BY full_name")).rows;
 const advisers=(await q("SELECT id,full_name,email,role FROM users WHERE role='adviser' AND is_active=true ORDER BY full_name")).rows;
 const schedules=(await q(`SELECT s.id,s.project_id,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,s.status,s.panel_proceedance,s.panel_outcome,s.result_status,p.title,p.type,p.adviser_id,COALESCE(a.full_name,'Unassigned') adviser_name
                              FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id
                              WHERE s.status NOT IN ('Cancelled','Completed') AND s.panel_outcome IS NULL AND s.result_status<>'Finalized'
                              ORDER BY s.defense_date,s.start_time,p.title`)).rows;
 res.json({panelMembers,advisers,schedules});
});
app.post('/api/panels', auth, requireRole('coordinator'), async(req,res)=>{
 const scheduleId=Number(req.body.schedule_id),userId=Number(req.body.user_id),role=['Chairperson','Panel Member','Adviser'].includes(req.body.panel_role)?req.body.panel_role:null;
 if(!scheduleId||!userId||!role)return res.status(400).json({error:'Defense, member, and panel role are required.'});
 try{
  const assignment=await withTransaction(async client=>{
   // Lock the schedule so its evaluator roster cannot change while the defense is being confirmed/finalized.
   const schedule=await client.query(`SELECT s.id,s.project_id,s.defense_date,s.start_time,s.end_time,s.status,s.panel_outcome,s.result_status,p.adviser_id
     FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1 FOR UPDATE OF s`,[scheduleId]);
   if(!schedule.rowCount)throw Object.assign(new Error('Defense schedule not found.'),{status:404});
   const row=schedule.rows[0];
   if(row.status==='Cancelled'||row.status==='Completed'||row.panel_outcome||row.result_status==='Finalized')
    throw Object.assign(new Error('Panel assignments are locked after the defense outcome is recorded or the final result is finalized.'),{status:409});
   const target=await client.query('SELECT id,role,is_active,panel_availability FROM users WHERE id=$1',[userId]);
   if(!target.rowCount||!target.rows[0].is_active)throw Object.assign(new Error('Selected user is not active.'),{status:400});
   const expectedRole=role==='Adviser'?'adviser':'panel_member';
   if(target.rows[0].role!==expectedRole)throw Object.assign(new Error(`${role} must be assigned to an active ${expectedRole==='adviser'?'Adviser':'Panel Member'} account.`),{status:400});
   if(role==='Adviser'&&target.rows[0].id!==row.adviser_id)throw Object.assign(new Error('The Adviser role must use the adviser assigned to this project.'),{status:400});
   const existing=await client.query('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,userId]);
   if(existing.rowCount)throw Object.assign(new Error('This person is already assigned to this defense.'),{status:409});
   const roleExists=await client.query('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND panel_role=$2',[scheduleId,role]);
   if(roleExists.rowCount&&role!=='Panel Member')throw Object.assign(new Error(`A ${role} is already assigned to this defense.`),{status:409});
   const conflict=await client.query(`SELECT pa.id FROM panel_assignments pa JOIN schedules s ON s.id=pa.schedule_id
     WHERE pa.user_id=$1 AND s.id<>$2 AND s.status<>'Cancelled' AND s.defense_date=$3
       AND s.start_time < $5 AND s.end_time > $4`,[userId,scheduleId,row.defense_date,row.start_time,row.end_time]);
   if(conflict.rowCount)throw Object.assign(new Error('This person is already assigned to another defense at the same time.'),{status:409});
   const saved=await client.query('INSERT INTO panel_assignments(schedule_id,user_id,panel_role) VALUES($1,$2,$3) RETURNING *',[scheduleId,userId,role]);
   return saved.rows[0];
  });
  await audit(req.session.user.id,'create','panel_assignment',assignment.id,{schedule_id:scheduleId,user_id:userId,panel_role:role});
  res.status(201).json({assignment});
 }catch(e){res.status(e.status||500).json({error:e.message||'Unable to assign panel member.'});}
});
app.delete('/api/panels/:id', auth, requireRole('coordinator'), async(req,res)=>{
 const assignmentId=Number(req.params.id);
 try{
  const removed=await withTransaction(async client=>{
   const current=await client.query(`SELECT pa.id,pa.schedule_id,s.status,s.panel_outcome,s.result_status
     FROM panel_assignments pa JOIN schedules s ON s.id=pa.schedule_id WHERE pa.id=$1 FOR UPDATE OF s`,[assignmentId]);
   if(!current.rowCount)throw Object.assign(new Error('Panel assignment not found.'),{status:404});
   const row=current.rows[0];
   if(row.status==='Completed'||row.status==='Cancelled'||row.panel_outcome||row.result_status==='Finalized')
    throw Object.assign(new Error('Panel assignments cannot be removed after the defense outcome is recorded or the final result is finalized.'),{status:409});
   const deleted=await client.query('DELETE FROM panel_assignments WHERE id=$1 RETURNING *',[assignmentId]);
   return deleted.rows[0];
  });
  await audit(req.session.user.id,'delete','panel_assignment',assignmentId,{});
  res.json({assignment:removed});
 }catch(e){res.status(e.status||500).json({error:e.message||'Unable to remove panel assignment.'});}
});

// Panel flow: proceed or request reschedule.
app.post('/api/schedules/:id/proceed', auth, requireRole('panel_member'), async(req,res)=>{
 const id=Number(req.params.id);
 const member=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[id,req.session.user.id]);
 if(!member.rowCount)return res.status(403).json({error:'You are not assigned to this defense.'});
 const current=await q("SELECT id,status,panel_proceedance,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time,end_time,panel_outcome FROM schedules WHERE id=$1",[id]);
 if(!current.rowCount||current.rows[0].status!=='Upcoming'||current.rows[0].panel_outcome)return res.status(409).json({error:'This defense is no longer awaiting a pre-defense Proceed confirmation.'});
 try{assertFutureDefenseStart(current.rows[0].defense_date,current.rows[0].start_time);}catch(e){return res.status(409).json({error:'The scheduled start time has arrived or passed. Use the post-defense confirmation instead.'});}
 const r=await q("UPDATE schedules SET panel_proceedance='Proceed',panel_proceeded_at=NOW() WHERE id=$1 RETURNING id,project_id,request_id,defense_type,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time,end_time,room_id,status,defense_result,panel_proceedance,panel_proceeded_at,panel_outcome,panel_outcome_at,panel_outcome_note,notes,created_at",[id]);
 await audit(req.session.user.id,'proceed','schedule',id,{});res.json({schedule:withScheduleDisplayStatus(r.rows[0])});
});
app.post('/api/schedules/:id/outcome', auth, requireRole('panel_member'), async(req,res)=>{
 const id=Number(req.params.id);
 const outcome=req.body.outcome==='Conducted'?'Conducted':req.body.outcome==='Not Conducted'?'Not Conducted':null;
 if(!Number.isInteger(id)||id<=0||!outcome)return res.status(400).json({error:'Select whether the defense was conducted.'});
 const member=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[id,req.session.user.id]);
 if(!member.rowCount)return res.status(403).json({error:'You are not assigned to this defense.'});
 const current=await q("SELECT id,status,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time,end_time,panel_outcome FROM schedules WHERE id=$1",[id]);
 if(!current.rowCount||current.rows[0].status!=='Upcoming')return res.status(409).json({error:'This defense is not awaiting a panel outcome.'});
 if(current.rows[0].panel_outcome)return res.status(409).json({error:'A panel outcome has already been recorded for this defense.'});
 if(!defenseEndHasPassed(current.rows[0].defense_date,current.rows[0].end_time))return res.status(409).json({error:'You can confirm the outcome only after the scheduled defense end time has passed.'});
 const note=cleanText(req.body.note,1000)||(outcome==='Conducted'?'Panel member confirmed that the defense was conducted.':'Panel member reported that the defense was not conducted.');
 const r=await q("UPDATE schedules SET panel_outcome=$1,panel_outcome_at=NOW(),panel_outcome_note=$2 WHERE id=$3 AND status='Upcoming' AND panel_outcome IS NULL RETURNING id,project_id,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time,end_time,status,panel_proceedance,panel_outcome,panel_outcome_at,panel_outcome_note",[outcome,note,id]);
 if(!r.rowCount)return res.status(409).json({error:'The defense outcome was already recorded by another panel member.'});
 await audit(req.session.user.id,outcome==='Conducted'?'confirm-defense-conducted':'report-defense-not-conducted','schedule',id,{note});
 res.json({schedule:withScheduleDisplayStatus(r.rows[0])});
});
app.post('/api/reschedule-requests', auth, requireRole('panel_member'), async(req,res)=>{const scheduleId=Number(req.body.schedule_id),reason=cleanText(req.body.reason,1000),preferredDate=normalizeDate(req.body.preferred_date),preferredTime=cleanText(req.body.preferred_time,20);const member=await q('SELECT id FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,req.session.user.id]);if(!member.rowCount)return res.status(403).json({error:'You are not assigned to this defense.'});if(!reason||!validDate(preferredDate)||!validTime(preferredTime))return res.status(400).json({error:'Provide a valid preferred date, time, and reason.'});try{assertFutureDefenseStart(preferredDate,preferredTime)}catch(e){return res.status(e.status||400).json({error:e.message})}const active=await q("SELECT id,status,panel_outcome,to_char(defense_date,'YYYY-MM-DD') AS defense_date,start_time FROM schedules WHERE id=$1 AND status='Upcoming'",[scheduleId]);if(!active.rowCount)return res.status(409).json({error:'Only an upcoming defense can be rescheduled.'});if(active.rows[0].panel_outcome)return res.status(409).json({error:'A defense outcome has already been recorded. Contact the coordinator for the next step.'});try{assertFutureDefenseStart(active.rows[0].defense_date,active.rows[0].start_time)}catch(e){return res.status(409).json({error:'The scheduled defense has already started or passed. Record whether it was conducted instead of requesting a late reschedule.'})}const duplicate=await q("SELECT id FROM reschedule_requests WHERE schedule_id=$1 AND status='Pending'",[scheduleId]);if(duplicate.rowCount)return res.status(409).json({error:'A reschedule request is already pending for this defense.'});const r=await q('INSERT INTO reschedule_requests(schedule_id,requested_by,reason,preferred_date,preferred_time) VALUES($1,$2,$3,$4,$5) RETURNING *',[scheduleId,req.session.user.id,reason,preferredDate,preferredTime]);await q("UPDATE schedules SET panel_proceedance='Reschedule Requested' WHERE id=$1",[scheduleId]);await audit(req.session.user.id,'request-reschedule','schedule',scheduleId,{preferred_date:preferredDate,preferred_time:preferredTime});res.status(201).json({request:r.rows[0]});});
app.get('/api/reschedule-requests', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT rr.*,u.full_name requester_name,to_char(rr.preferred_date,'YYYY-MM-DD') preferred_date,to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.start_time,s.end_time,p.title FROM reschedule_requests rr JOIN users u ON u.id=rr.requested_by JOIN schedules s ON s.id=rr.schedule_id JOIN projects p ON p.id=s.project_id ORDER BY rr.created_at DESC`);res.json({requests:r.rows});});
app.patch('/api/reschedule-requests/:id', auth, requireRole('coordinator'), async(req,res)=>{const id=Number(req.params.id),status=['Approved','Rejected'].includes(req.body.status)?req.body.status:null;if(!status)return res.status(400).json({error:'Invalid status.'});const rr=await q('SELECT * FROM reschedule_requests WHERE id=$1',[id]);if(!rr.rowCount)return res.status(404).json({error:'Request not found.'});if(rr.rows[0].status!=='Pending')return res.status(409).json({error:'This reschedule request has already been handled.'});if(status==='Rejected'){const r=await q("UPDATE reschedule_requests SET status='Rejected',updated_at=NOW() WHERE id=$1 RETURNING *",[id]);await q("UPDATE schedules SET panel_proceedance='Pending' WHERE id=$1 AND status='Upcoming'",[rr.rows[0].schedule_id]);await audit(req.session.user.id,'reject-reschedule','reschedule_request',id,{});return res.json({request:r.rows[0]});}
 const old=await q(`SELECT * FROM schedules WHERE id=$1`,[rr.rows[0].schedule_id]);if(!old.rowCount)return res.status(404).json({error:'Original schedule not found.'});
 try{const replacement=await saveSchedule({project_id:old.rows[0].project_id,request_id:old.rows[0].request_id,defense_type:old.rows[0].defense_type,defense_date:rr.rows[0].preferred_date,start_time:rr.rows[0].preferred_time,end_time:addMinutesToTime(String(rr.rows[0].preferred_time).slice(0,5),Math.max(30,Number(process.env.DEFAULT_DEFENSE_DURATION_MINUTES||120))),room_id:null,notes:`Rescheduled from defense schedule #${old.rows[0].id}. ${old.rows[0].notes||''}`},req.session.user.id,old.rows[0].id); const r=await q("UPDATE reschedule_requests SET status='Approved',updated_at=NOW() WHERE id=$1 RETURNING *",[id]); await q("UPDATE schedules SET panel_proceedance='Pending',panel_proceeded_at=NULL WHERE id=$1",[replacement.id]); await audit(req.session.user.id,'approve-reschedule','reschedule_request',id,{replacement_schedule_id:replacement.id}); res.json({request:r.rows[0],schedule:replacement});}catch(e){res.status(e.status||500).json({error:e.message||'Unable to approve the reschedule request.'});}});

// Evaluations retain each evaluator's own decision. The system finalizes automatically
// only when all required evaluators agree; disagreement is resolved explicitly by the Coordinator.
app.get('/api/evaluations', auth, async(req,res)=>{
  const u=req.session.user; let where=''; let params=[];
  if(u.role==='panel_member'){where='WHERE e.evaluator_id=$1';params=[u.id];}
  if(u.role==='adviser'){where='WHERE e.evaluator_id=$1 AND p.adviser_id=$1';params=[u.id];}
  if(u.role==='student'){where='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))';params=[u.id];}
  const r=await q(`SELECT e.*,u.full_name evaluator_name,p.code,p.title,
      to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.defense_type,
      s.panel_proceedance,s.defense_result AS final_defense_result,
      s.result_status,s.result_decision_note,s.result_finalized_at
    FROM evaluations e JOIN users u ON u.id=e.evaluator_id
    JOIN schedules s ON s.id=e.schedule_id JOIN projects p ON p.id=s.project_id
    ${where} ORDER BY e.created_at DESC`,params);
  let finalizations=[];
  if(u.role==='coordinator'){
    const summaries=await q(`SELECT s.id AS schedule_id,p.title,s.defense_type,
        to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.result_status,
        s.defense_result AS final_defense_result,
        req.expected_count,sub.submitted_count,sub.decision_count,
        COALESCE(votes.evaluation_summary,'No evaluator assignments found') AS evaluation_summary
      FROM schedules s JOIN projects p ON p.id=s.project_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS expected_count FROM (
          SELECT user_id AS evaluator_id FROM panel_assignments WHERE schedule_id=s.id
        ) required
      ) req ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE e.id IS NOT NULL)::int AS submitted_count,
               COUNT(*) FILTER (WHERE e.defense_result IS NOT NULL)::int AS decision_count
        FROM (
          SELECT user_id AS evaluator_id FROM panel_assignments WHERE schedule_id=s.id
        ) required
        LEFT JOIN evaluations e ON e.schedule_id=s.id AND e.evaluator_id=required.evaluator_id
      ) sub ON TRUE
      LEFT JOIN LATERAL (
        SELECT string_agg(u2.full_name || ': ' || COALESCE(e.defense_result,'Decision not recorded'), ' · ' ORDER BY u2.full_name) AS evaluation_summary
        FROM (
          SELECT user_id AS evaluator_id FROM panel_assignments WHERE schedule_id=s.id
        ) required
        JOIN users u2 ON u2.id=required.evaluator_id
        LEFT JOIN evaluations e ON e.schedule_id=s.id AND e.evaluator_id=required.evaluator_id
      ) votes ON TRUE
      WHERE s.panel_outcome='Conducted' AND s.status<>'Cancelled'
      ORDER BY CASE WHEN s.result_status='Awaiting Coordinator' THEN 0 ELSE 1 END,s.defense_date DESC,s.id DESC`);
    finalizations=summaries.rows;
  }
  res.json({evaluations:r.rows,finalizations});
});

app.post('/api/evaluations', auth, requireRole('panel_member','adviser'), async(req,res)=>{
  const scheduleId=Number(req.body.schedule_id);
  const scores=['technical_score','presentation_score','documentation_score'].map(k=>Number(req.body[k]));
  if(!Number.isSafeInteger(scheduleId)||scheduleId<=0)return res.status(400).json({error:'Select an assigned defense.'});
  if(scores.some(x=>!Number.isFinite(x)||x<0||x>100))return res.status(400).json({error:'Scores must be between 0 and 100.'});
  const comments=cleanText(req.body.comments,2000);
  const recommendation=cleanText(req.body.recommendation,80)||'For Revision';
  const result=['Passed','Failed','For Revision','Re-defense Required'].includes(req.body.defense_result)?req.body.defense_result:null;
  if(!result)return res.status(400).json({error:'Select an evaluator result.'});

  try{
    const outcome=await withTransaction(async client=>{
      const schedule=await client.query(`SELECT s.id,s.status,s.result_status,s.panel_outcome,
          to_char(s.defense_date,'YYYY-MM-DD') AS defense_date,s.end_time,s.project_id,p.adviser_id,s.request_id
        FROM schedules s JOIN projects p ON p.id=s.project_id WHERE s.id=$1 FOR UPDATE OF s`,[scheduleId]);
      if(!schedule.rowCount)throw Object.assign(new Error('Defense not found.'),{status:404});
      const row=schedule.rows[0];
      if(row.status==='Cancelled')throw Object.assign(new Error('Cancelled defenses cannot be evaluated.'),{status:409});
      if(row.result_status==='Finalized')throw Object.assign(new Error('The final defense result has already been recorded. Evaluations can no longer be changed.'),{status:409});
      if(row.panel_outcome==='Not Conducted')throw Object.assign(new Error('This defense was reported as not conducted and cannot be evaluated.'),{status:409});
      if(row.panel_outcome!=='Conducted')throw Object.assign(new Error('A panel member must first confirm that the defense was conducted.'),{status:409});
      if(!defenseEndHasPassed(row.defense_date,row.end_time))throw Object.assign(new Error('Evaluation is available only after the scheduled defense end time.'),{status:409});

      const membership=await client.query('SELECT panel_role FROM panel_assignments WHERE schedule_id=$1 AND user_id=$2',[scheduleId,req.session.user.id]);
      const isAdviser=req.session.user.role==='adviser';
      const eligible=membership.rowCount>0 && (isAdviser
        ? membership.rows[0].panel_role==='Adviser'
        : ['Chairperson','Panel Member'].includes(membership.rows[0].panel_role));
      if(!eligible)throw Object.assign(new Error(isAdviser
        ? 'The Adviser can evaluate only when explicitly assigned to this defense.'
        : 'You are not assigned to this defense.'),{status:403});

      const saved=await client.query(`INSERT INTO evaluations(schedule_id,evaluator_id,technical_score,presentation_score,documentation_score,comments,recommendation,defense_result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(schedule_id,evaluator_id) DO UPDATE SET
          technical_score=EXCLUDED.technical_score,presentation_score=EXCLUDED.presentation_score,
          documentation_score=EXCLUDED.documentation_score,comments=EXCLUDED.comments,
          recommendation=EXCLUDED.recommendation,defense_result=EXCLUDED.defense_result,confirmed_at=NOW()
        RETURNING *`,[scheduleId,req.session.user.id,scores[0],scores[1],scores[2],comments,recommendation,result]);

      const stats=await client.query(`WITH required AS (
          SELECT user_id AS evaluator_id FROM panel_assignments WHERE schedule_id=$1
        )
        SELECT COUNT(*)::int AS expected_count,
          COUNT(e.id)::int AS submitted_count,
          COUNT(e.defense_result)::int AS decision_count,
          COUNT(DISTINCT e.defense_result)::int AS distinct_result_count,
          MIN(e.defense_result) AS unanimous_result
        FROM required LEFT JOIN evaluations e ON e.schedule_id=$1 AND e.evaluator_id=required.evaluator_id`,[scheduleId]);
      const st=stats.rows[0];
      let finalizationStatus='Pending';
      if(Number(st.expected_count)>0&&Number(st.submitted_count)>=Number(st.expected_count)&&Number(st.decision_count)>=Number(st.expected_count)){
        if(Number(st.distinct_result_count)===1){
          finalizationStatus='Finalized';
          await client.query(`UPDATE schedules SET status='Completed',defense_result=$2,result_status='Finalized',
              result_decision_note='Automatically finalized because all required evaluators agreed.',result_finalized_by=NULL,result_finalized_at=NOW()
            WHERE id=$1`,[scheduleId,st.unanimous_result]);
          if(row.request_id)await client.query("UPDATE defense_requests SET status='Completed',review_feedback=$2,updated_at=NOW() WHERE id=$1 AND status<>'Completed'",[row.request_id,`Defense completed. Final result: ${st.unanimous_result}.`]);
        } else {
          finalizationStatus='Awaiting Coordinator';
          await client.query("UPDATE schedules SET result_status='Awaiting Coordinator',defense_result=NULL,result_decision_note=NULL,result_finalized_by=NULL,result_finalized_at=NULL WHERE id=$1",[scheduleId]);
        }
      } else {
        await client.query("UPDATE schedules SET result_status='Pending',defense_result=NULL WHERE id=$1",[scheduleId]);
      }
      return {evaluation:saved.rows[0],expected:Number(st.expected_count),submitted:Number(st.submitted_count),decisionCount:Number(st.decision_count),finalizationStatus};
    });
    await audit(req.session.user.id,'submit','evaluation',outcome.evaluation.id,{schedule_id:scheduleId,evaluator_result:result,finalization_status:outcome.finalizationStatus});
    await syncCompletedDefenseRequests();
    res.status(201).json(outcome);
  }catch(e){res.status(e.status||500).json({error:e.message||'Unable to submit evaluation.'});}
});

app.patch('/api/evaluations/:scheduleId/final-result', auth, requireRole('coordinator'), async(req,res)=>{
  const scheduleId=Number(req.params.scheduleId);
  const finalResult=['Passed','Failed','For Revision','Re-defense Required'].includes(req.body.defense_result)?req.body.defense_result:null;
  const note=cleanText(req.body.decision_note,2000);
  if(!Number.isSafeInteger(scheduleId)||scheduleId<=0)return res.status(400).json({error:'Invalid defense schedule.'});
  if(!finalResult)return res.status(400).json({error:'Select the final defense result.'});
  if(!note)return res.status(400).json({error:'Explain the Coordinator final decision.'});
  try{
    const finalized=await withTransaction(async client=>{
      const schedule=await client.query(`SELECT s.id,s.status,s.result_status,s.panel_outcome,s.request_id
        FROM schedules s WHERE s.id=$1 FOR UPDATE`,[scheduleId]);
      if(!schedule.rowCount)throw Object.assign(new Error('Defense schedule not found.'),{status:404});
      const row=schedule.rows[0];
      if(row.status==='Cancelled'||row.panel_outcome!=='Conducted')throw Object.assign(new Error('Only a conducted, active defense can receive a final result.'),{status:409});
      if(row.result_status!=='Awaiting Coordinator')throw Object.assign(new Error('This defense is not awaiting a Coordinator final decision.'),{status:409});
      const stats=await client.query(`WITH required AS (
          SELECT user_id AS evaluator_id FROM panel_assignments WHERE schedule_id=$1
        )
        SELECT COUNT(*)::int expected_count,COUNT(e.id)::int submitted_count,COUNT(e.defense_result)::int decision_count,
          COUNT(DISTINCT e.defense_result)::int distinct_result_count
        FROM required LEFT JOIN evaluations e ON e.schedule_id=$1 AND e.evaluator_id=required.evaluator_id`,[scheduleId]);
      const st=stats.rows[0];
      if(Number(st.expected_count)===0||Number(st.submitted_count)<Number(st.expected_count)||Number(st.decision_count)<Number(st.expected_count))throw Object.assign(new Error('All evaluators assigned to this defense must submit an individual result before the Coordinator can finalize it.'),{status:409});
      if(Number(st.distinct_result_count)<2)throw Object.assign(new Error('The evaluator results no longer disagree. Refresh the page; the system will finalize an unanimous result automatically.'),{status:409});
      const saved=await client.query(`UPDATE schedules SET status='Completed',defense_result=$2,result_status='Finalized',
          result_decision_note=$3,result_finalized_by=$4,result_finalized_at=NOW()
        WHERE id=$1 RETURNING id,status,defense_result,result_status,result_decision_note,result_finalized_at`,[scheduleId,finalResult,note,req.session.user.id]);
      if(row.request_id)await client.query("UPDATE defense_requests SET status='Completed',review_feedback=$2,updated_at=NOW() WHERE id=$1 AND status<>'Completed'",[row.request_id,`Defense completed. Final result: ${finalResult}.`]);
      return saved.rows[0];
    });
    await audit(req.session.user.id,'finalize','defense_result',scheduleId,{defense_result:finalResult,decision_note:note});
    await syncCompletedDefenseRequests();
    res.json({schedule:finalized});
  }catch(e){res.status(e.status||500).json({error:e.message||'Unable to finalize defense result.'});}
});

// Adviser feedback / student revise-resubmit loop.
app.get('/api/feedback', auth, async(req,res)=>{
  const u=req.session.user; let where='';let params=[];
  if(u.role==='adviser'){where='WHERE pf.adviser_id=$1';params=[u.id];}
  if(u.role==='student'){where='WHERE ($1=ANY(COALESCE(p.student_ids, ARRAY[]::int[])) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.student_id=$1))';params=[u.id];}
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
  const weeklyRows=weekly.rows;
  const linkedWbs=wbs.rows.map(item=>{
    const weeks=WBS_WEEK_MAP[item.code];
    return weeks?{...item,...progressFromWeeks(weeks,weeklyRows)}:item;
  });
  const linkedGantt=gantt.rows.map(item=>{
    const weeks=Array.from({length:Math.max(0,Number(item.week_end)-Number(item.week_start)+1)},(_,i)=>Number(item.week_start)+i);
    return {...item,...progressFromWeeks(weeks,weeklyRows)};
  });
  res.json({wbs:linkedWbs,gantt:linkedGantt,budget:budget.rows,risks:risks.rows,weekly:weeklyRows,budgetTotal:budget.rows.reduce((s,r)=>s+Number(r.total),0),projectPlan:getProjectPlanSummary()});
});
app.patch('/api/weekly/:week', auth, requireRole('coordinator'), async(req,res)=>{const status=['Not started','In Progress','Completed','At Risk'].includes(req.body.status)?req.body.status:null;const progress=Math.max(0,Math.min(100,Number(req.body.progress)||0));if(!status)return res.status(400).json({error:'Invalid weekly status.'});const r=await q('UPDATE weekly_tracker SET status=$1,progress=$2 WHERE week=$3 RETURNING *',[status,progress,Number(req.params.week)]);if(!r.rowCount)return res.status(404).json({error:'Week not found.'});res.json({week:r.rows[0]});});

// Reports — Coordinator only. Each report is a complete dataset required by the project instructions.
app.get('/api/reports/summary', auth, requireRole('coordinator'), async(_req,res)=>{const [p,r,s,u,e]=await Promise.all([q('SELECT COUNT(*)::int count FROM projects'),q('SELECT COUNT(*)::int count FROM defense_requests'),q("SELECT COUNT(*)::int count FROM schedules WHERE status<>'Cancelled'"),q('SELECT COUNT(*)::int count FROM users WHERE is_active=true'),q('SELECT COUNT(*)::int count FROM evaluations')]);res.json({projects:Number(p.rows[0].count),requests:Number(r.rows[0].count),schedules:Number(s.rows[0].count),activeUsers:Number(u.rows[0].count),evaluations:Number(e.rows[0].count)});});
app.get('/api/reports/defense-schedule', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT to_char(s.defense_date,'YYYY-MM-DD') defense_date,s.start_time,s.end_time,s.defense_type,s.status,s.defense_result,p.title,COALESCE(a.full_name,'Unassigned') adviser_name,COALESCE(r.name,'Room TBA') room_name FROM schedules s JOIN projects p ON p.id=s.project_id LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN rooms r ON r.id=s.room_id ORDER BY s.defense_date,s.start_time`);res.json({rows:r.rows});});
app.get('/api/reports/panel-assignment', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT to_char(s.defense_date,'YYYY-MM-DD') defense_date,s.start_time,p.title,u.full_name,u.email,pa.panel_role FROM panel_assignments pa JOIN schedules s ON s.id=pa.schedule_id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=pa.user_id ORDER BY s.defense_date,s.start_time,p.title,pa.panel_role`);res.json({rows:r.rows});});
app.get('/api/reports/student-status', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT p.title,p.type,p.status,COALESCE(a.full_name,'Unassigned') adviser_name,u.full_name student_name,u.email FROM projects p LEFT JOIN users a ON a.id=p.adviser_id LEFT JOIN project_members pm ON pm.project_id=p.id LEFT JOIN users u ON u.id=pm.student_id ORDER BY p.title,u.full_name`);res.json({rows:r.rows});});
app.get('/api/reports/evaluation', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT p.title,to_char(s.defense_date,'YYYY-MM-DD') defense_date,u.full_name evaluator_name,ROUND(((e.technical_score+e.presentation_score+e.documentation_score)/3)::numeric,1) average_score,e.recommendation,e.defense_result AS evaluator_result,s.defense_result AS final_defense_result,s.result_status,s.result_decision_note,e.comments FROM evaluations e JOIN schedules s ON s.id=e.schedule_id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=e.evaluator_id ORDER BY s.defense_date,p.title,u.full_name`);res.json({rows:r.rows});});
app.get('/api/audit-logs', auth, requireRole('coordinator'), async(_req,res)=>{const r=await q(`SELECT al.*,u.full_name user_name FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id ORDER BY al.created_at DESC LIMIT 200`);res.json({logs:r.rows});});

app.use('/api', (err, _req, res, _next) => { console.error(err); res.status(500).json({error:'Unexpected server error.'}); });
app.use((req,res,next)=>{ if(req.method==='GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(publicRoot,'index.html')); next(); });

initDb().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>console.log(`ThesisFlow running on http://0.0.0.0:${PORT}`));
}).catch(err=>{console.error('Startup failed:',err);process.exit(1);});
