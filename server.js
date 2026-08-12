const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { TERMINATION_SECTIONS, CRF_SECTIONS, CATEGORY_MATRIX, CATEGORY_OPTIONS, TRACKING_FIELDS, TEAM_NAMES, IMPLEMENTATION_FIELDS, TERMINATION_EXTRA_FIELDS, OPEN_ENROLLMENT_FIELDS } = require('./schema');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const XlsxPopulate = require('xlsx-populate');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DOCUMENTS_DIR = path.join(DATA_DIR, 'Document');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data.db');
// Ensure data directories exist (important for Railway volumes)
[DOCUMENTS_DIR, path.join(DATA_DIR, 'synced'), path.join(DATA_DIR, 'tracker')].forEach(d => {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));

// ---------- Logo (embedded as base64 for the exported document) ----------
let LOGO_DATA_URI = '';
try {
  const logoBuf = fs.readFileSync(path.join(__dirname, 'public', 'images', 'logo.png'));
  LOGO_DATA_URI = 'data:image/png;base64,' + logoBuf.toString('base64');
} catch (e) {
  console.warn('Logo file not found at public/images/logo.png — exports will skip the logo image.');
}

// ---------- DB init ----------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Seed default teams & members if empty
try {
  const teamCount = db.prepare('SELECT COUNT(*) as count FROM teams').get().count;
  if (teamCount === 0) {
    db.exec('BEGIN');
    try {
      const insertTeam = db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)');
      const insertMember = db.prepare('INSERT INTO team_members (id, team_id, name, email) VALUES (?, ?, ?, ?)');

      const cfgTeamId = 'team_cfg';
      insertTeam.run(cfgTeamId, 'Configuration Analyst');
      insertMember.run('m_nitya', cfgTeamId, 'Nitya', 'nitya@hgsi.in');
      insertMember.run('m_john', cfgTeamId, 'John', 'john@hgsi.in');

      const tstTeamId = 'team_tst';
      insertTeam.run(tstTeamId, 'Review/Testing Analyst');
      insertMember.run('m_sarah', tstTeamId, 'Sarah', 'sarah@hgsi.in');
      insertMember.run('m_marcus', tstTeamId, 'Marcus', 'marcus@hgsi.in');

      const mgrTeamId = 'team_mgr';
      insertTeam.run(mgrTeamId, 'Implementation Manager/CRM');
      insertMember.run('m_priya', mgrTeamId, 'Priya', 'priya@hgsi.in');
      insertMember.run('m_david', mgrTeamId, 'David', 'david@hgsi.in');
      insertMember.run('m_elena', mgrTeamId, 'Elena', 'elena@hgsi.in');

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('Failed to seed default teams:', e.message);
    }
  }
} catch (err) {
  console.error('Teams table validation failed:', err.message);
}

// ---------- Lightweight migration for databases created by earlier versions ----------
function tryExec(sql) { try { db.exec(sql); } catch (e) { /* already applied, ignore */ } }
tryExec("ALTER TABLE submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'requested'");
tryExec("ALTER TABLE submissions ADD COLUMN owner TEXT DEFAULT ''");
tryExec("ALTER TABLE submissions ADD COLUMN is_deleted INTEGER DEFAULT 0");
tryExec("DELETE FROM tasks WHERE item_key = '_section'"); // CRF sections no longer track their own status/owner
tryExec("CREATE INDEX IF NOT EXISTS idx_submissions_updated ON submissions(updated_at DESC, is_deleted, status)");
tryExec("CREATE INDEX IF NOT EXISTS idx_tasks_sub_id ON tasks(submission_id)");

// Migrate the submissions table if it still has the old, narrower type CHECK constraint
// (SQLite can't ALTER a CHECK constraint directly, so rebuild the table if needed).
(function migrateTypeConstraint() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='submissions'").get();
  if (row && row.sql && (!row.sql.includes('open_enrollment') || !row.sql.includes('implementation') || !row.sql.includes('draft'))) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE submissions_new (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL CHECK(type IN ('termination','crf','implementation','open_enrollment')),
        client       TEXT DEFAULT '',
        broker       TEXT DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('draft', 'requested','approved','testing','completed')),
        owner        TEXT DEFAULT '',
        header_json  TEXT DEFAULT '{}',
        body_json    TEXT DEFAULT '{}',
        is_deleted   INTEGER DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      )`);
      db.exec('INSERT INTO submissions_new (id, type, client, broker, status, owner, header_json, body_json, created_at, updated_at) SELECT id, type, client, broker, status, owner, header_json, body_json, created_at, updated_at FROM submissions');
      db.exec('DROP TABLE submissions');
      db.exec('ALTER TABLE submissions_new RENAME TO submissions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(type)');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.warn('submissions type-constraint migration failed (safe to ignore on a fresh database):', e.message);
    }
  }
})();

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }
function safeParse(str, fallback) { try { return JSON.parse(str); } catch (e) { return fallback; } }

// ---------- Status stages ----------
const STAGES = [['requested', 'Requested'], ['approved', 'Approved'], ['testing', 'Testing'], ['completed', 'Completed']];
function stageLabel(s) { const f = STAGES.find(x => x[0] === s); return f ? f[1] : s; }
function stageColor(s) { return { requested: '#9694A8', approved: '#2E86AB', testing: '#F0932B', completed: '#00B894' }[s] || '#9694A8'; }
const SECTION_COLORS = {
  crm: '#6C5CE7', edi: '#2E86AB', analytics: '#E17055', systems: '#00B894', benefits: '#F0932B', finance: '#D63384', sales: '#20639B',
  request: '#6C5CE7', solution: '#2E86AB', note: '#7A7D96', approval: '#00B894', finalSolution: '#F0932B', sow: '#D63384', tracking: '#4A7C59', categories: '#20639B'
};

// ---------- helpers ----------

function seedTasks(submissionId, type) {
  const insert = db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
    VALUES (@id, @submission_id, @section_key, @item_key, @label, 'requested', '', '', '', @extra_json)`);
  db.exec('BEGIN');
  try {
    if (type === 'termination') {
      TERMINATION_SECTIONS.forEach(sec => {
        sec.items.forEach(it => {
          insert.run({ id: uid(), submission_id: submissionId, section_key: sec.key, item_key: it.id, label: it.label, extra_json: '{}' });
        });
      });
    } else if (type === 'crf') {
      CRF_SECTIONS.forEach(sec => {
        if (sec.key === 'categories') {
          CATEGORY_MATRIX.forEach(g => {
            g.items.forEach(it => {
              const extra = {};
              if (it.sub) it.sub.forEach(s => { extra[s] = ''; });
              insert.run({
                id: uid(), submission_id: submissionId, section_key: 'categories', item_key: it.id,
                label: (g.group ? g.group + ' — ' : '') + it.label, extra_json: JSON.stringify(extra)
              });
            });
          });
        }
        // Other CRF sections (Request, Solution, Note, Approval, Final Solution, SOW) are plain
        // data-entry sections now — status/owner live once at the submission level, not per section.
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getTasks(submissionId) {
  return db.prepare('SELECT * FROM tasks WHERE submission_id = ? ORDER BY rowid').all(submissionId)
    .map(t => ({ ...t, extra_json: safeParse(t.extra_json, {}) }));
}

function progressOf(tasks, overallStatus) {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'completed').length;
  if (total === 0) return { total: 0, done: 0, pct: overallStatus === 'completed' ? 100 : 0 };
  return { total, done, pct: Math.round((done / total) * 100) };
}

function fullRecord(row) {
  const tasks = getTasks(row.id);
  return {
    id: row.id, type: row.type, client: row.client, broker: row.broker,
    status: row.status,
    header: safeParse(row.header_json, {}), body: safeParse(row.body_json, {}),
    tasks, progress: progressOf(tasks, row.status),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function logEmailAndSend(toEmail, toName, subject, body) {
  const emailId = uid();
  const now = nowIso();
  try {
    db.prepare(`INSERT INTO email_logs (id, to_email, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)`)
      .run(emailId, `${toName} <${toEmail}>`, subject, body, now);
    const logMsg = `[${now}] To: ${toName} <${toEmail}>\nSubject: ${subject}\nBody:\n${body}\n------------------------------------------\n`;
    fs.appendFileSync(path.join(__dirname, 'sent_emails.log'), logMsg, 'utf8');
    console.log(`[EMAIL SENT] ID: ${emailId} To: ${toEmail} Subject: ${subject}`);
  } catch (err) {
    console.error('Failed to log or send email:', err.message);
  }
}

function notifyTeam(teamName, subject, body) {
  try {
    const team = db.prepare('SELECT id FROM teams WHERE name = ?').get(teamName);
    if (!team) return;
    const members = db.prepare('SELECT name, email FROM team_members WHERE team_id = ?').all(team.id);
    members.forEach(m => {
      logEmailAndSend(m.email, m.name, subject, body);
    });
  } catch (e) {
    console.error('notifyTeam error:', e.message);
  }
}

function notifyMember(memberName, subject, body) {
  try {
    const member = db.prepare('SELECT name, email FROM team_members WHERE name = ?').get(memberName);
    if (member) {
      logEmailAndSend(member.email, member.name, subject, body);
    }
  } catch (e) {
    console.error('notifyMember error:', e.message);
  }
}

// ---------- Excel Sync Logic ----------
// TEMPLATE_ = original files — NEVER modified, used as read-only base
const TEMPLATE_CRF = path.join(DOCUMENTS_DIR, 'CRF Config Master Tracker (Pivots and Charts).xlsx');
const TEMPLATE_IMPL_TERM = path.join(DOCUMENTS_DIR, '2026_Client Implemented and Terminated.xlsx');
const TEMPLATE_OE = path.join(DOCUMENTS_DIR, 'Open Enrollment Tracker.xlsx');
// Keep old names as aliases for backward compatibility
const MASTER_CRF = TEMPLATE_CRF;
const MASTER_IMPL_TERM = TEMPLATE_IMPL_TERM;
// SYNC_ = working copies that are written on every data change
const SYNC_DIR = path.join(DATA_DIR, 'synced');
const SYNC_CRF = path.join(SYNC_DIR, 'CRF Config Master Tracker (Synced).xlsx');
const SYNC_IMPL_TERM = path.join(SYNC_DIR, '2026_Client Implemented and Terminated (Synced).xlsx');
if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });

// TRACKER_ = auto-updated files in tracker/ folder (never deleted records are highlighted, not removed)
const TRACKER_DIR = path.join(DATA_DIR, 'tracker');
const TRACKER_CRF = path.join(TRACKER_DIR, 'CRF_Tracker.xlsx');
const TRACKER_IMPL = path.join(TRACKER_DIR, 'Implementation_Tracker.xlsx');
const TRACKER_TERM = path.join(TRACKER_DIR, 'Termination_Tracker.xlsx');
const TRACKER_OE = path.join(TRACKER_DIR, 'OpenEnrollment_Tracker.xlsx');
if (!fs.existsSync(TRACKER_DIR)) fs.mkdirSync(TRACKER_DIR, { recursive: true });

function safeExcelDate(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  const str = String(val).trim();
  if (!str) return null;
  const match = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10) - 1;
    const d = parseInt(match[3], 10);
    const dt = new Date(Date.UTC(y, m, d));
    if (!isNaN(dt.getTime())) return dt;
  }
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) return dt;
  return null;
}

function monthName(iso) {
  if (!iso) return '';
  const dt = safeExcelDate(iso);
  if (!dt) return String(iso);
  try {
    return dt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) + ' ' + dt.getUTCFullYear();
  } catch (e) {
    return String(iso);
  }
}

function toExcelTimeFraction(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') {
    if (val < 1 && val > 0) return val; // already a day fraction
    return val / 24; // convert hours to day fraction
  }
  const str = String(val).trim();
  if (!str) return null;
  if (str.includes(':')) {
    const parts = str.split(':');
    const hrs = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    return (hrs + (mins / 60)) / 24;
  }
  const num = parseFloat(str);
  if (isNaN(num)) return str;
  if (num > 0 && num < 1) return num; // keep existing day fraction stored as string
  return num / 24; // convert hours (e.g. "2" -> 2 hrs, "1.5" -> 1.5 hrs) to day fraction
}

function getRecordYear(d, fallbackIso) {
  const dt = safeExcelDate(d) || safeExcelDate(fallbackIso);
  if (dt) return dt.getUTCFullYear();
  return 2026;
}

function buildRowsData(type) {
  const rows = db.prepare("SELECT * FROM submissions WHERE type = ? AND is_deleted = 0 AND status != 'draft' ORDER BY created_at DESC").all(type);
  if (type === 'crf') {
    return rows.map(r => {
      const h = safeParse(r.header_json, {});
      const b = safeParse(r.body_json, {});
      const req_ = b.request || {}, sol = b.solution || {}, tr = b.tracking || {};
      return { month: monthName(req_.dateOfRequest || r.created_at), client: r.client, broker: r.broker, conv: h.refConversation, requestedBy: req_.requestedBy, requestDate: req_.dateOfRequest, category: tr.category, reason: req_.requestText, proposedSolution: sol.proposedSolution, timeConfig: tr.timeConfig, timeTesting: tr.timeTesting, errors: tr.errors, configAnalyst: tr.configAnalyst, testingAnalyst: tr.testingAnalyst, implementationManager: tr.implementationManager, completedDate: h.completedOn, rating: tr.rating, comments: tr.comments, billable: tr.billable };
    });
  } else if (type === 'implementation') {
    return rows.map((r, i) => {
      const h = safeParse(r.header_json, {});
      return { sl: i + 1, client: r.client, broker: r.broker, designGuideReceived: h.designGuideReceived, implementationCompletion: h.implementationCompletion, clientGoLive: h.clientGoLive, headcount: h.headcount };
    });
  } else if (type === 'termination') {
    return rows.map((r, i) => {
      const h = safeParse(r.header_json, {});
      return { sl: i + 1, client: r.client, broker: r.broker, terminationDate: h.requestedDate, headcount: h.eeHeadcount, reason: h.reason };
    });
  } else if (type === 'open_enrollment') {
    return rows.map((r, i) => {
      const h = safeParse(r.header_json, {});
      return {
        sl: i + 1,
        oeDocReceivedDate: h.oeDocReceivedDate,
        client: r.client,
        oeStartDate: h.oeStartDate,
        oeEndDate: h.oeEndDate,
        oeEffectiveDate: h.oeEffectiveDate,
        typeOfOe: h.typeOfOe,
        listOrWorkflow: h.listOrWorkflow,
        activePlans: h.activePlans,
        passivePlans: h.passivePlans,
        setupStatus: h.setupStatus,
        testingStatus: h.testingStatus,
        finalizationRulesStatus: h.finalizationRulesStatus,
        finalizationStartEndDate: h.finalizationStartEndDate,
        announcementSentBy: h.announcementSentBy,
        reminderFrequency: h.reminderFrequency,
        comments: h.comments,
        closure: h.closure,
        confirmationEmails: h.confirmationEmails
      };
    });
  }
  return [];
}

// ---------- Shared helper: apply styling to a CRF data row in ExcelJS ----------
function styleCRFDataRow(dataRow, isDeleted) {
  dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.font = { name: 'Calibri', size: 10, strike: !!isDeleted, color: isDeleted ? { argb: '999999' } : { argb: '000000' } };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'E0E0E0' } },
      left: { style: 'thin', color: { argb: 'E0E0E0' } },
      bottom: { style: 'thin', color: { argb: 'E0E0E0' } },
      right: { style: 'thin', color: { argb: 'E0E0E0' } }
    };
    if (isDeleted) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
    if ((colNum === 6 || colNum === 17) && cell.value instanceof Date) {
      cell.numFmt = 'mm/dd/yyyy';
      cell.alignment = { vertical: 'top', horizontal: 'center', wrapText: false };
    }
    if ((colNum === 10 || colNum === 11 || colNum === 12) && typeof cell.value === 'number') {
      cell.numFmt = '[h]:mm';
      cell.alignment = { vertical: 'top', horizontal: 'center', wrapText: false };
    }
  });
}

// ---------- Shared helper: add CRF columns definition ----------
function addCRFColumns(ws, includeStatus) {
  const cols = [
    { header: 'Month', key: 'month', width: 14 },
    { header: 'Client Name', key: 'client', width: 32 },
    { header: 'Partner Name', key: 'broker', width: 22 },
    { header: 'Conversation#', key: 'conv', width: 16 },
    { header: 'Change Requested By', key: 'requestedBy', width: 20 },
    { header: 'Change Request Date', key: 'requestDate', width: 20 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Reason for Raising', key: 'reason', width: 45 },
    { header: 'Change Request', key: 'proposedSolution', width: 45 },
    { header: 'Time Spent on Configuration', key: 'timeConfig', width: 26 },
    { header: 'Time Spent on Review/Testing', key: 'timeTesting', width: 26 },
    { header: 'Total Time', key: 'totalTime', width: 16 },
    { header: 'No. of Errors', key: 'errors', width: 14 },
    { header: 'Configuration Analyst', key: 'configAnalyst', width: 22 },
    { header: 'Review/Testing Analyst', key: 'testingAnalyst', width: 22 },
    { header: 'Implementation Manager/CRM', key: 'implementationManager', width: 26 },
    { header: 'Completed Date', key: 'completedDate', width: 18 },
    { header: 'Rating', key: 'rating', width: 12 },
    { header: 'Comments', key: 'comments', width: 35 },
    { header: 'Billable/Non Billable', key: 'billable', width: 20 }
  ];
  if (includeStatus) cols.push({ header: 'Status', key: 'status', width: 14 });
  ws.columns = cols;
}

// ---------- Shared helper: build CRF row array from DB record ----------
function buildCRFRowArray(r, includeStatus) {
  const h = safeParse(r.header_json, {});
  const b = safeParse(r.body_json, {});
  const req_ = b.request || {}, sol = b.solution || {}, tr = b.tracking || {};
  const dReq = safeExcelDate(req_.dateOfRequest);
  const dComp = safeExcelDate(h.completedOn);
  const tCfg = toExcelTimeFraction(tr.timeConfig);
  const tTst = toExcelTimeFraction(tr.timeTesting);
  const tc = (typeof tCfg === 'number') ? tCfg : 0;
  const tt = (typeof tTst === 'number') ? tTst : 0;
  const arr = [
    monthName(req_.dateOfRequest || r.created_at),
    r.client || '',
    r.broker || '',
    h.refConversation || '',
    req_.requestedBy || '',
    dReq ? dReq : (req_.dateOfRequest || ''),
    tr.category || '',
    req_.requestText || '',
    sol.proposedSolution || '',
    typeof tCfg === 'number' ? tCfg : null,
    typeof tTst === 'number' ? tTst : null,
    (tc || tt) ? (tc + tt) : null,
    tr.errors ? parseInt(tr.errors, 10) : null,
    tr.configAnalyst || '',
    tr.testingAnalyst || '',
    tr.implementationManager || '',
    dComp ? dComp : (h.completedOn || ''),
    tr.rating ? (isNaN(tr.rating) ? tr.rating : parseFloat(tr.rating)) : null,
    tr.comments || '',
    tr.billable || ''
  ];
  if (includeStatus) arr.push(r.is_deleted ? 'DELETED' : (r.status || ''));
  return arr;
}

// ---------- CRF Excel export (ExcelJS — clean, no title row, headers at row 1) ----------
async function generateCRFExcel() {
  const rows = db.prepare("SELECT * FROM submissions WHERE type = 'crf' AND is_deleted = 0 AND status != 'draft' ORDER BY created_at DESC").all();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Workforce Junction';
  wb.created = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('CRF Source Data Config', { views: [{ showGridLines: true }] });
  addCRFColumns(ws, false);

  // Row 1: Header row styling
  const headerRow = ws.getRow(1);
  headerRow.height = 30;
  headerRow.eachCell(cell => {
    cell.font = { name: 'Calibri', size: 11, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9EAD3' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'CCCCCC' } },
      left: { style: 'thin', color: { argb: 'CCCCCC' } },
      bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
      right: { style: 'thin', color: { argb: 'CCCCCC' } }
    };
  });

  // Row 2+: Data rows (active records only)
  rows.forEach(r => {
    const dataRow = ws.addRow(buildCRFRowArray(r, false));
    styleCRFDataRow(dataRow, false);
  });

  ws.autoFilter = `A1:T${Math.max(2, 1 + rows.length)}`;
  return wb.xlsx.writeBuffer();
}

// ---------- Impl/Term Excel export (xlsx-populate against template) ----------
async function populateWithXlsxPopulate(templatePath, type, rowsData) {
  const workbook = await XlsxPopulate.fromFileAsync(templatePath);

  if (type === 'implementation') {
    const sheet = workbook.sheet('2026') || workbook.sheet(0);
    rowsData.forEach((d, i) => {
      const rowIdx = 3 + i;
      sheet.cell(`A${rowIdx}`).value(d.sl);
      sheet.cell(`B${rowIdx}`).value(d.client || '');
      sheet.cell(`C${rowIdx}`).value(d.broker || '');

      const d4 = safeExcelDate(d.designGuideReceived);
      if (d4) sheet.cell(`D${rowIdx}`).value(d4).style({ numberFormat: 'mm/dd/yyyy' });
      else sheet.cell(`D${rowIdx}`).value(d.designGuideReceived || '');

      const d5 = safeExcelDate(d.implementationCompletion);
      if (d5) sheet.cell(`E${rowIdx}`).value(d5).style({ numberFormat: 'mm/dd/yyyy' });
      else sheet.cell(`E${rowIdx}`).value(d.implementationCompletion || '');

      const d6 = safeExcelDate(d.clientGoLive);
      if (d6) sheet.cell(`F${rowIdx}`).value(d6).style({ numberFormat: 'mm/dd/yyyy' });
      else sheet.cell(`F${rowIdx}`).value(d.clientGoLive || '');

      sheet.cell(`G${rowIdx}`).value(d.headcount ? parseInt(d.headcount) : '');
    });
    return await workbook.outputAsync();

  } else if (type === 'termination') {
    const sheet = workbook.sheet('2026') || workbook.sheet(0);
    rowsData.forEach((d, i) => {
      const rowIdx = 3 + i;
      sheet.cell(`I${rowIdx}`).value(d.sl);
      sheet.cell(`J${rowIdx}`).value(d.client || '');
      sheet.cell(`K${rowIdx}`).value(d.broker || '');

      const d12 = safeExcelDate(d.terminationDate);
      if (d12) sheet.cell(`L${rowIdx}`).value(d12).style({ numberFormat: 'mm/dd/yyyy' });
      else sheet.cell(`L${rowIdx}`).value(d.terminationDate || '');

      sheet.cell(`M${rowIdx}`).value(d.headcount ? parseInt(d.headcount) : '');
      sheet.cell(`N${rowIdx}`).value(d.reason || '');
    });
    return await workbook.outputAsync();
  }
}

// ---------- Tracker: auto-update Excel files in tracker/ folder ----------
async function updateTrackerExcel(type) {
  try {
    if (type === 'crf') {
      // ALL crf rows (active + deleted), newest first
      const rows = db.prepare("SELECT * FROM submissions WHERE type = 'crf' AND status != 'draft' ORDER BY created_at DESC").all();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Workforce Junction';
      wb.created = new Date();
      wb.modified = new Date();
      const ws = wb.addWorksheet('CRF Source Data Config', { views: [{ showGridLines: true }] });
      addCRFColumns(ws, true); // includeStatus = true

      // Header row
      const hdr = ws.getRow(1);
      hdr.height = 30;
      hdr.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9EAD3' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      rows.forEach(r => {
        const dataRow = ws.addRow(buildCRFRowArray(r, true));
        styleCRFDataRow(dataRow, !!r.is_deleted);
        if (r.is_deleted) {
          // Color the Status cell orange/red
          const statusCell = dataRow.getCell(21);
          statusCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'C00000' } };
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAD6' } };
        } else {
          const statusCell = dataRow.getCell(21);
          statusCell.font = { name: 'Calibri', size: 10, bold: false, color: { argb: '1F6B2E' } };
        }
      });

      ws.autoFilter = `A1:U${Math.max(2, 1 + rows.length)}`;
      const buf = await wb.xlsx.writeBuffer();
      fs.writeFileSync(TRACKER_CRF, Buffer.from(buf));
      console.log(`Tracker updated: CRF (${rows.length} rows including deleted)`);

    } else if (type === 'implementation') {
      const rows = db.prepare("SELECT * FROM submissions WHERE type = 'implementation' AND status != 'draft' ORDER BY created_at DESC").all();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Workforce Junction';
      wb.created = new Date();
      wb.modified = new Date();
      const ws = wb.addWorksheet('Implementation Tracker', { views: [{ showGridLines: true }] });
      ws.columns = [
        { header: 'Sl#', key: 'sl', width: 8 },
        { header: 'Client Name', key: 'client', width: 32 },
        { header: 'Partner Name', key: 'broker', width: 22 },
        { header: 'Design Guide Received', key: 'designGuideReceived', width: 22 },
        { header: 'Implementation Completion', key: 'implementationCompletion', width: 24 },
        { header: 'Client Go-Live', key: 'clientGoLive', width: 18 },
        { header: 'Headcount', key: 'headcount', width: 14 },
        { header: 'Status', key: 'status', width: 14 }
      ];
      const hdr = ws.getRow(1);
      hdr.height = 28;
      hdr.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CFE2F3' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      let sl = 1;
      rows.forEach(r => {
        const h = safeParse(r.header_json, {});
        const deleted = !!r.is_deleted;
        const dRow = ws.addRow([
          sl++,
          r.client || '',
          r.broker || '',
          safeExcelDate(h.designGuideReceived) || h.designGuideReceived || '',
          safeExcelDate(h.implementationCompletion) || h.implementationCompletion || '',
          safeExcelDate(h.clientGoLive) || h.clientGoLive || '',
          h.headcount ? parseInt(h.headcount, 10) : null,
          deleted ? 'DELETED' : (r.status || '')
        ]);
        dRow.eachCell({ includeEmpty: true }, (cell, cn) => {
          cell.font = { name: 'Calibri', size: 10, strike: deleted, color: deleted ? { argb: '999999' } : { argb: '000000' } };
          cell.alignment = { vertical: 'top' };
          cell.border = { top: { style: 'thin', color: { argb: 'E0E0E0' } }, left: { style: 'thin', color: { argb: 'E0E0E0' } }, bottom: { style: 'thin', color: { argb: 'E0E0E0' } }, right: { style: 'thin', color: { argb: 'E0E0E0' } } };
          if (deleted) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
          if ([4, 5, 6].includes(cn) && cell.value instanceof Date) cell.numFmt = 'mm/dd/yyyy';
        });
        if (deleted) {
          const sc = dRow.getCell(8);
          sc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'C00000' } };
          sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAD6' } };
        }
      });
      ws.autoFilter = `A1:H${Math.max(2, 1 + rows.length)}`;
      const buf = await wb.xlsx.writeBuffer();
      fs.writeFileSync(TRACKER_IMPL, Buffer.from(buf));
      console.log(`Tracker updated: Implementation (${rows.length} rows)`);

    } else if (type === 'termination') {
      const rows = db.prepare("SELECT * FROM submissions WHERE type = 'termination' AND status != 'draft' ORDER BY created_at DESC").all();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Workforce Junction';
      wb.created = new Date();
      wb.modified = new Date();
      const ws = wb.addWorksheet('Termination Tracker', { views: [{ showGridLines: true }] });
      ws.columns = [
        { header: 'Sl#', key: 'sl', width: 8 },
        { header: 'Client Name', key: 'client', width: 32 },
        { header: 'Partner Name', key: 'broker', width: 22 },
        { header: 'Termination Date', key: 'terminationDate', width: 20 },
        { header: 'EE Headcount', key: 'headcount', width: 16 },
        { header: 'Reason', key: 'reason', width: 40 },
        { header: 'Status', key: 'status', width: 14 }
      ];
      const hdr = ws.getRow(1);
      hdr.height = 28;
      hdr.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FCE4D6' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      let sl = 1;
      rows.forEach(r => {
        const h = safeParse(r.header_json, {});
        const deleted = !!r.is_deleted;
        const dRow = ws.addRow([
          sl++,
          r.client || '',
          r.broker || '',
          safeExcelDate(h.requestedDate) || h.requestedDate || '',
          h.eeHeadcount ? parseInt(h.eeHeadcount, 10) : null,
          h.reason || '',
          deleted ? 'DELETED' : (r.status || '')
        ]);
        dRow.eachCell({ includeEmpty: true }, (cell, cn) => {
          cell.font = { name: 'Calibri', size: 10, strike: deleted, color: deleted ? { argb: '999999' } : { argb: '000000' } };
          cell.alignment = { vertical: 'top', wrapText: cn === 6 };
          cell.border = { top: { style: 'thin', color: { argb: 'E0E0E0' } }, left: { style: 'thin', color: { argb: 'E0E0E0' } }, bottom: { style: 'thin', color: { argb: 'E0E0E0' } }, right: { style: 'thin', color: { argb: 'E0E0E0' } } };
          if (deleted) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
          if (cn === 4 && cell.value instanceof Date) cell.numFmt = 'mm/dd/yyyy';
        });
        if (deleted) {
          const sc = dRow.getCell(7);
          sc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'C00000' } };
          sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDAD6' } };
        }
      });
      ws.autoFilter = `A1:G${Math.max(2, 1 + rows.length)}`;
      const buf = await wb.xlsx.writeBuffer();
      fs.writeFileSync(TRACKER_TERM, Buffer.from(buf));
      console.log(`Tracker updated: Termination (${rows.length} rows)`);
    }
  } catch (err) {
    console.error(`updateTrackerExcel(${type}) failed:`, err.message);
  }
}

const syncDebounceTimers = {};

function scheduleExcelSync(type) {
  if (!type) return;
  if (syncDebounceTimers[type]) clearTimeout(syncDebounceTimers[type]);
  syncDebounceTimers[type] = setTimeout(() => {
    runExcelSync(type).catch(e => console.error(`Background Excel sync (${type}) error:`, e.message));
  }, 4000);
}

async function runExcelSync(type) {
  // Always update tracker (includes deleted records, never loses data)
  await updateTrackerExcel(type);

  const templatePath = type === 'crf' ? TEMPLATE_CRF : TEMPLATE_IMPL_TERM;
  const syncPath = type === 'crf' ? SYNC_CRF : SYNC_IMPL_TERM;
  if (!fs.existsSync(templatePath)) return;

  try {
    const rowsData = buildRowsData(type);
    let buffer;
    if (type === 'crf') {
      buffer = await generateCRFExcel();
    } else {
      buffer = await populateWithXlsxPopulate(templatePath, type, rowsData);
    }
    if (buffer) {
      fs.writeFileSync(syncPath, buffer);
      console.log(`Excel synced (${type}): ${syncPath} — ${rowsData.length} rows written`);
    }
  } catch (err) {
    console.error(`Failed to sync to Excel for ${type}:`, err.message);
  }
}

// ---------- API: schema ----------

app.get('/api/schema', (req, res) => {
  const dynamicTeams = db.prepare('SELECT DISTINCT name FROM team_members ORDER BY name').all().map(r => r.name);
  res.json({ TERMINATION_SECTIONS, CRF_SECTIONS, CATEGORY_MATRIX, CATEGORY_OPTIONS, TRACKING_FIELDS, TEAM_NAMES: dynamicTeams, STAGES, IMPLEMENTATION_FIELDS, TERMINATION_EXTRA_FIELDS, OPEN_ENROLLMENT_FIELDS });
});

// ---------- API: submissions ----------

app.get('/api/submissions', (req, res) => {
  // Performance fix: only select columns needed for the index (no body_json / tasks)
  // and limit to 500 most recent records so the index stays fast.
  const rows = db.prepare(
    `SELECT id, type, client, broker, status, header_json, body_json, created_at, updated_at
     FROM submissions
     WHERE status != 'draft' AND is_deleted = 0
     ORDER BY updated_at DESC
     LIMIT 500`
  ).all();

  function parseTimeToHours(val) {
    if (!val) return 0;
    const s = String(val).trim();
    if (s.includes(':')) {
      const [h, m] = s.split(':').map(Number);
      return (h || 0) + ((m || 0) / 60);
    }
    return parseFloat(s) || 0;
  }
  function countPlans(val) {
    if (!val) return 0;
    return String(val).trim().split(',').map(x => x.trim()).filter(x => x.length > 0).length;
  }

  res.json(rows.map(row => {
    const header = safeParse(row.header_json, {});
    const body = safeParse(row.body_json, {});

    let dashData = {};
    if (row.type === 'crf') {
      const tr = body.tracking || {};
      dashData = {
        category: tr.category || header.category || 'Other',
        timeConfig: parseTimeToHours(tr.timeConfig),
        timeTesting: parseTimeToHours(tr.timeTesting),
        configAnalyst: tr.configAnalyst || '',
        testingAnalyst: tr.testingAnalyst || '',
        implementationManager: tr.implementationManager || '',
        requestedBy: (body.request && body.request.requestedBy) ? body.request.requestedBy : 'Unknown'
      };
    } else if (row.type === 'implementation') {
      dashData = { headcount: parseInt(header.headcount, 10) || 0 };
    } else if (row.type === 'termination') {
      dashData = { headcount: parseInt(header.eeHeadcount, 10) || 0 };
    } else if (row.type === 'open_enrollment') {
      dashData = {
        configAnalyst: header.configAnalyst || 'Unassigned',
        typeOfOe: header.typeOfOe || 'Unknown',
        activePlans: countPlans(header.activePlans),
        passivePlans: countPlans(header.passivePlans),
        crm: header.crm || ''
      };
    }

    return {
      id: row.id, type: row.type, client: row.client, broker: row.broker,
      status: row.status, refConversation: header.refConversation || '',
      progress: 0, // progress computed on submission open, not index
      createdAt: row.created_at, updatedAt: row.updated_at,
      taskText: '',
      ...dashData
    };
  }));
});

function handleSubmissionChanges(oldSub, newSub, incomingTasks) {
  const clientName = newSub.client || 'Untitled Client';

  // 1. Check status transition
  if (oldSub && oldSub.status !== newSub.status) {
    const s = newSub.status;
    if (s === 'approved') {
      notifyTeam('Configuration Analyst',
        `Action Required: CRF Approved for ${clientName}`,
        `Hi Team,\n\nThe Change Request Form for client "${clientName}" has been APPROVED. It is now ready for configuration.\n\nPlease assign a Configuration Analyst to configure this request.\n\nBest regards,\nWorkforce Junction App`);
    } else if (s === 'testing') {
      notifyTeam('Review/Testing Analyst',
        `Action Required: CRF Ready for Testing for ${clientName}`,
        `Hi Team,\n\nThe Change Request Form for client "${clientName}" has been configured. It is now ready for review and testing.\n\nPlease assign a Testing Analyst to test this configuration.\n\nBest regards,\nWorkforce Junction App`);
    } else if (s === 'completed') {
      const oldHeader = safeParse(oldSub.header_json, {});
      const newHeader = safeParse(newSub.header_json, {});
      const im = newHeader.implementationManager || oldHeader.implementationManager;
      if (im) {
        notifyMember(im,
          `CRF Marked Completed for ${clientName}`,
          `Hi ${im},\n\nThe Change Request Form for client "${clientName}" has been successfully tested and marked COMPLETED.\n\nBest regards,\nWorkforce Junction App`);
      } else {
        notifyTeam('Implementation Manager/CRM',
          `CRF Marked Completed for ${clientName}`,
          `Hi CRM Team,\n\nThe Change Request Form for client "${clientName}" has been successfully tested and marked COMPLETED.\n\nBest regards,\nWorkforce Junction App`);
      }
    }
  }

  // 2. Check tracking analyst changes
  if (oldSub) {
    const oldHeader = safeParse(oldSub.header_json, {});
    const newHeader = safeParse(newSub.header_json, {});
    if (newHeader.configAnalyst && newHeader.configAnalyst !== oldHeader.configAnalyst) {
      notifyMember(newHeader.configAnalyst,
        `Task Assigned: Configure CRF for ${clientName}`,
        `Hi ${newHeader.configAnalyst},\n\nYou have been assigned as the Configuration Analyst for client "${clientName}"'s change request.\n\nBest regards,\nWorkforce Junction App`);
    }
    if (newHeader.testingAnalyst && newHeader.testingAnalyst !== oldHeader.testingAnalyst) {
      notifyMember(newHeader.testingAnalyst,
        `Task Assigned: Test CRF for ${clientName}`,
        `Hi ${newHeader.testingAnalyst},\n\nYou have been assigned as the Review/Testing Analyst for client "${clientName}"'s change request.\n\nBest regards,\nWorkforce Junction App`);
    }
    if (newHeader.implementationManager && newHeader.implementationManager !== oldHeader.implementationManager) {
      notifyMember(newHeader.implementationManager,
        `Assigned as IM/CRM for ${clientName} CRF`,
        `Hi ${newHeader.implementationManager},\n\nYou have been assigned as the Implementation Manager/CRM for client "${clientName}"'s change request.\n\nBest regards,\nWorkforce Junction App`);
    }
  }

  // 3. Check individual checklist task assignee changes
  if (oldSub && incomingTasks && Array.isArray(incomingTasks)) {
    const oldTasks = getTasks(oldSub.id);
    incomingTasks.forEach(t => {
      const oldT = oldTasks.find(ot => ot.id === t.id);
      if (t.assignee && (!oldT || oldT.assignee !== t.assignee)) {
        notifyMember(t.assignee,
          `Checklist Task Assigned: ${t.label} (${clientName})`,
          `Hi ${t.assignee},\n\nYou have been assigned the checklist task: "${t.label}" for client "${clientName}".\n\nTask details:\n- Section: ${t.section_key}\n- Notes: ${t.notes || 'None'}\n\nBest regards,\nWorkforce Junction App`);
      }
    });
  }
}

app.post('/api/submissions', (req, res) => {
  const { type, client = '', broker = '', status = 'requested', owner = '', header = {}, body = {}, tasks = [] } = req.body || {};
  if (!['termination', 'crf', 'implementation', 'open_enrollment'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const id = uid();
  const now = nowIso();

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO submissions (id, type, client, broker, status, owner, header_json, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type, client, broker, status, owner, JSON.stringify(header), JSON.stringify(body), now, now);

    if (tasks && tasks.length) {
      const insertTask = db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      tasks.forEach(t => {
        const taskId = t.id && !t.id.startsWith('draft_') ? t.id : uid();
        insertTask.run(taskId, id, t.section_key, t.item_key, t.label, t.status || 'requested', t.assignee || '', t.completed_on || '', t.notes || '', JSON.stringify(t.extra_json || {}));
      });
    } else {
      if (type === 'termination') {
        const insertTask = db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
          VALUES (?, ?, ?, ?, ?, 'requested', '', '', '', '{}')`);
        TERMINATION_SECTIONS.forEach(sec => {
          sec.items.forEach(it => {
            insertTask.run(uid(), id, sec.key, it.id, it.label);
          });
        });
      } else if (type === 'crf') {
        const insertTask = db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
          VALUES (?, ?, ?, ?, ?, 'requested', '', '', '', ?)`);
        CRF_SECTIONS.forEach(sec => {
          if (sec.key === 'categories') {
            CATEGORY_MATRIX.forEach(g => {
              g.items.forEach(it => {
                const extra = {};
                if (it.sub) it.sub.forEach(s => { extra[s] = ''; });
                insertTask.run(uid(), id, 'categories', it.id, (g.group ? g.group + ' — ' : '') + it.label, JSON.stringify(extra));
              });
            });
          }
        });
      }
    }

    db.exec('COMMIT');

    // Trigger initial notification check for new records
    const newRecord = { id, client, broker, status, owner, header_json: JSON.stringify(header), body_json: JSON.stringify(body), type, updatedAt: now };
    handleSubmissionChanges(null, newRecord, tasks);

    const finalRec = fullRecord(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
    scheduleExcelSync(type);
    res.json(finalRec);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Failed to create submission:', e);
    res.status(500).json({ error: 'failed to create submission: ' + e.message });
  }
});

app.get('/api/submissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(fullRecord(row));
});

app.put('/api/submissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { client, broker, status, owner, header, body, tasks } = req.body || {};
  const newClient = client !== undefined ? client : row.client;
  const newBroker = broker !== undefined ? broker : row.broker;
  const newStatus = status !== undefined ? status : row.status;
  const newOwner = owner !== undefined ? owner : row.owner;
  const newHeader = header !== undefined ? JSON.stringify({ ...safeParse(row.header_json, {}), ...header }) : row.header_json;
  const newBody = body !== undefined ? JSON.stringify({ ...safeParse(row.body_json, {}), ...body }) : row.body_json;

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE submissions SET client=?, broker=?, status=?, owner=?, header_json=?, body_json=?, updated_at=? WHERE id=?`)
      .run(newClient, newBroker, newStatus, newOwner, newHeader, newBody, nowIso(), req.params.id);

    if (tasks && Array.isArray(tasks)) {
      db.prepare('DELETE FROM tasks WHERE submission_id = ?').run(req.params.id);
      const insert = db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
        VALUES (@id, @submission_id, @section_key, @item_key, @label, @status, @assignee, @completed_on, @notes, @extra_json)`);
      for (const t of tasks) {
        insert.run({
          id: t.id || uid(),
          submission_id: req.params.id,
          section_key: t.section_key || '',
          item_key: t.item_key || ('custom_' + uid()),
          label: t.label || '',
          status: t.status || 'requested',
          assignee: t.assignee || '',
          completed_on: t.completed_on || '',
          notes: t.notes || '',
          extra_json: JSON.stringify(t.extra_json || {})
        });
      }
    }
    db.exec('COMMIT');

    // Check transitions and email notifications
    const newSubState = {
      id: req.params.id,
      type: row.type,
      client: newClient,
      broker: newBroker,
      status: newStatus,
      owner: newOwner,
      header_json: newHeader,
      body_json: newBody,
      updatedAt: nowIso()
    };
    handleSubmissionChanges(row, newSubState, tasks);

    const finalRec = fullRecord(db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id));
    scheduleExcelSync(row.type);
    res.json(finalRec);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Failed to save submission:', e);
    res.status(500).json({ error: 'failed to save submission: ' + e.message });
  }
});

app.delete('/api/submissions/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'submission not found' });
    db.prepare('UPDATE submissions SET is_deleted = 1, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
    scheduleExcelSync(row.type);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete submission error:', e);
    res.status(500).json({ error: 'failed to delete submission: ' + e.message });
  }
});

// ---------- Batch / Bulk Deletes ----------

app.post('/api/submissions/bulk-delete', (req, res) => {
  const { ids } = req.body || {};
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'invalid ids' });
  db.exec('BEGIN');
  try {
    const delSub = db.prepare('UPDATE submissions SET is_deleted = 1, updated_at = ? WHERE id = ?');
    const typesToSync = new Set();
    ids.forEach(id => {
      const row = db.prepare('SELECT type FROM submissions WHERE id = ?').get(id);
      if (row) typesToSync.add(row.type);
      delSub.run(nowIso(), id);
    });
    db.exec('COMMIT');
    typesToSync.forEach(t => scheduleExcelSync(t));
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/submissions/delete-all', (req, res) => {
  db.exec('BEGIN');
  try {
    db.exec(`UPDATE submissions SET is_deleted = 1, updated_at = '${nowIso()}'`);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: Admin Settings & Teams ----------

app.get('/api/admin/teams', (req, res) => {
  try {
    let teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
    // Seed default teams if none exist yet
    if (teams.length === 0) {
      const defaultTeams = ['Implementation', 'Terminations', 'HR', 'Finance', 'IT', 'Configuration', 'Testing'];
      const insertTeam = db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)');
      defaultTeams.forEach(name => {
        const id = 'team_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        insertTeam.run(id, name);
      });
      teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
    }
    teams.forEach(t => {
      t.members = db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY name').all(t.id);
    });
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/teams', (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const id = uid();
  try {
    db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name.trim());
    res.json({ id, name: name.trim(), members: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/teams/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/teams/:id/members', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const id = uid();
  try {
    db.prepare('INSERT INTO team_members (id, team_id, name, email) VALUES (?, ?, ?, ?)')
      .run(id, req.params.id, name.trim(), email.trim());
    res.json({ id, team_id: req.params.id, name: name.trim(), email: email.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/members/:id', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    db.prepare('UPDATE team_members SET name = ?, email = ? WHERE id = ?')
      .run(name.trim(), email.trim(), req.params.id);
    res.json({ id: req.params.id, name: name.trim(), email: email.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/members/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM team_members WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/emails', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM email_logs ORDER BY sent_at DESC').all();
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: Notifications (email log for Notifications tab) ----------

app.get('/api/notifications', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 100').all();
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: Tracker data (read-only summary for Tracker tab) ----------

app.get('/api/tracker/data', (req, res) => {
  try {
    const crfRows = db.prepare("SELECT id, client, broker, status, is_deleted, created_at, updated_at, header_json, body_json FROM submissions WHERE type = 'crf' AND status != 'draft' ORDER BY created_at DESC").all().map(r => {
      const h = safeParse(r.header_json, {});
      const b = safeParse(r.body_json, {});
      const req_ = b.request || {}; const sol = b.solution || {}; const tr = b.tracking || {};
      return {
        id: r.id, client: r.client, broker: r.broker, status: r.status, is_deleted: r.is_deleted,
        month: monthName(req_.dateOfRequest || r.created_at),
        refConversation: h.refConversation || '',
        requestedBy: req_.requestedBy || '',
        requestDate: req_.dateOfRequest || '',
        category: tr.category || '',
        reason: req_.requestText || '',
        changeRequest: sol.proposedSolution || '',
        timeConfig: tr.timeConfig || '',
        timeTesting: tr.timeTesting || '',
        errors: tr.errors || '',
        configAnalyst: tr.configAnalyst || '', testingAnalyst: tr.testingAnalyst || '',
        implementationManager: tr.implementationManager || '',
        completedDate: h.completedOn || '',
        rating: tr.rating || '',
        comments: tr.comments || '',
        billable: tr.billable || '',
        createdAt: r.created_at, updatedAt: r.updated_at
      };
    });
    const implRows = db.prepare("SELECT id, client, broker, status, is_deleted, created_at, updated_at, header_json FROM submissions WHERE type = 'implementation' AND status != 'draft' ORDER BY created_at DESC").all().map(r => {
      const h = safeParse(r.header_json, {});
      return {
        id: r.id, client: r.client, broker: r.broker, status: r.status, is_deleted: r.is_deleted,
        designGuideReceived: h.designGuideReceived || '', implementationCompletion: h.implementationCompletion || '',
        clientGoLive: h.clientGoLive || '', headcount: h.headcount || '',
        createdAt: r.created_at, updatedAt: r.updated_at
      };
    });
    const termRows = db.prepare("SELECT id, client, broker, status, is_deleted, created_at, updated_at, header_json FROM submissions WHERE type = 'termination' AND status != 'draft' ORDER BY created_at DESC").all().map(r => {
      const h = safeParse(r.header_json, {});
      return {
        id: r.id, client: r.client, broker: r.broker, status: r.status, is_deleted: r.is_deleted,
        terminationDate: h.requestedDate || '', headcount: h.eeHeadcount || '', reason: h.reason || '',
        createdAt: r.created_at, updatedAt: r.updated_at
      };
    });
    const oeRows = db.prepare("SELECT id, client, broker, status, is_deleted, created_at, updated_at, header_json, body_json FROM submissions WHERE type = 'open_enrollment' AND status != 'draft' ORDER BY created_at DESC").all().map(r => {
      const h = safeParse(r.header_json, {});
      const b = safeParse(r.body_json, {});
      return {
        id: r.id, client: r.client, broker: r.broker, status: r.status, is_deleted: r.is_deleted,
        oeDocReceivedDate: h.oeDocReceivedDate || b.oeDocReceivedDate || '',
        crm: h.crm || b.crm || '',
        configAnalyst: h.configAnalyst || b.configAnalyst || '',
        oeType: h.typeOfOe || b.typeOfOe || '',
        typeOfOe: h.typeOfOe || b.typeOfOe || '',
        oeStartDateBlackout: h.oeStartDate || b.oeStartDate || '',
        oeEndDateEE: h.oeEndDate || b.oeEndDate || '',
        oeEndDateHR: h.oeEndDateHR || b.oeEndDateHR || '',
        oeEffective: h.oeEffectiveDate || b.oeEffectiveDate || '',
        activePlans: h.activePlans || b.activePlans || '',
        passivePlans: h.passivePlans || b.passivePlans || '',
        setupStatus: h.setupStatus || b.setupStatus || '',
        reviewTestingStatus: h.testingStatus || b.testingStatus || '',
        finalizationRulesStatus: h.finalizationRulesStatus || b.finalizationRulesStatus || '',
        announcementEmailSentBy: h.announcementEmailSentBy || b.announcementEmailSentBy || '',
        reminderEmailsFrequency: h.reminderEmailsFrequency || b.reminderEmailsFrequency || '',
        oeClosure: h.oeClosure || b.oeClosure || '',
        oeFinalizationDate: h.oeFinalizationDate || b.oeFinalizationDate || '',
        comments: h.comments || b.comments || '',
        month: monthName(h.oeStartDate || r.created_at),
        createdAt: r.created_at, updatedAt: r.updated_at
      };
    });
    res.json({ crf: crfRows, implementation: implRows, termination: termRows, open_enrollment: oeRows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: tasks (update / add / delete) ----------

app.put('/api/submissions/:id/tasks/:taskId', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND submission_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const { status, assignee, completed_on, notes, label, extra } = req.body || {};
  const newStatus = status !== undefined ? status : task.status;
  const newAssignee = assignee !== undefined ? assignee : task.assignee;
  const newLabel = label !== undefined ? label : task.label;
  let newCompletedOn = completed_on !== undefined ? completed_on : task.completed_on;
  if (status === 'completed' && !newCompletedOn) newCompletedOn = new Date().toISOString().slice(0, 10);
  if (status !== undefined && status !== 'completed') newCompletedOn = '';
  const newNotes = notes !== undefined ? notes : task.notes;
  const newExtra = extra !== undefined ? JSON.stringify({ ...safeParse(task.extra_json, {}), ...extra }) : task.extra_json;
  db.prepare(`UPDATE tasks SET status=?, assignee=?, label=?, completed_on=?, notes=?, extra_json=? WHERE id=?`)
    .run(newStatus, newAssignee, newLabel, newCompletedOn, newNotes, newExtra, req.params.taskId);
  db.prepare('UPDATE submissions SET updated_at=? WHERE id=?').run(nowIso(), req.params.id);
  res.json(fullRecord(db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id)));
});

app.post('/api/submissions/:id/tasks', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { section_key, label } = req.body || {};
  if (!section_key || !label) return res.status(400).json({ error: 'section_key and label required' });
  const id = uid();
  db.prepare(`INSERT INTO tasks (id, submission_id, section_key, item_key, label, status, assignee, completed_on, notes, extra_json)
    VALUES (?, ?, ?, ?, ?, 'requested', '', '', '', '{}')`).run(id, req.params.id, section_key, 'custom_' + id, label);
  db.prepare('UPDATE submissions SET updated_at=? WHERE id=?').run(nowIso(), req.params.id);
  res.json(fullRecord(db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id)));
});

app.delete('/api/submissions/:id/tasks/:taskId', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND submission_id = ?').run(req.params.taskId, req.params.id);
  db.prepare('UPDATE submissions SET updated_at=? WHERE id=?').run(nowIso(), req.params.id);
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(fullRecord(row));
});

// ---------- Word-compatible, colorful, branded export ----------

function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d; } }

function wordDoc(title, bodyHtml) {
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
  <head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    body{font-family:'Calibri',Arial,sans-serif;font-size:10.5pt;color:#000;line-height:1.25;}
    h1{font-size:14pt;font-weight:bold;margin-bottom:2pt;text-align:center;}
    .subtitle{color:#555;font-size:9pt;margin-bottom:10pt;text-align:center;}
    h2{font-size:11pt;font-weight:bold;padding:2pt 0;margin-top:10pt;margin-bottom:3pt;border-bottom:1.5pt solid #000000;}
    table{border-collapse:collapse;width:100%;margin-bottom:8pt;}
    td,th{border:1px solid #000000;padding:4pt 6pt;vertical-align:top;font-size:9.5pt;}
    th{background:#F2F2F2;text-align:left;font-weight:bold;}
  </style></head><body>
  ${LOGO_DATA_URI ? `<div style="text-align:center;margin-bottom:8pt;"><img src="${LOGO_DATA_URI}" height="38"></div>` : ''}
  ${bodyHtml}
  </body></html>`;
}

function renderPairedTable(leftKey, rightKey, tasks) {
  const bySection = {};
  tasks.forEach(t => { (bySection[t.section_key] = bySection[t.section_key] || []).push(t); });

  const leftSec = TERMINATION_SECTIONS.find(s => s.key === leftKey);
  const rightSec = TERMINATION_SECTIONS.find(s => s.key === rightKey);

  const leftTasks = leftSec ? (bySection[leftSec.key] || []) : [];
  const rightTasks = rightSec ? (bySection[rightSec.key] || []) : [];
  const maxRows = Math.max(leftTasks.length, rightTasks.length);

  let rowsHtml = '';
  for (let i = 0; i < maxRows; i++) {
    const lTask = leftTasks[i];
    const rTask = rightTasks[i];

    let leftCell = '';
    if (lTask) {
      const isDone = lTask.status === 'completed' ? '☒' : '☐';
      const ex = lTask.extra_json || {};
      let extra = '';
      if (lTask.item_key === 'crm1' && ex.extraVal) extra = ` ${fmtDate(ex.extraVal)}`;
      if (lTask.item_key === 'crm2' && ex.extraVal) {
        extra = ` ${ex.extraVal === 'yes' ? '☒ Yes  ☐ No' : '☐ Yes  ☒ No'}`;
        if (ex.extraVal === 'yes' && ex.extraVal2) extra += ` Amount: $${ex.extraVal2}`;
      }
      if (lTask.item_key === 'an1' && ex.extraVal) extra = ` ${ex.extraVal}`;
      if (lTask.item_key === 'sys3' && ex.extraVal) extra = ` – ${ex.extraVal}`;

      leftCell = `
        <td width="4%" style="border:1px solid #000000;text-align:center;font-size:10pt;font-family:'Arial';">${isDone}</td>
        <td width="46%" style="border:1px solid #000000;font-size:9pt;font-family:'Calibri';">${esc(lTask.label)}${extra}${lTask.notes ? '<br><i style="color:#555;">Note: ' + esc(lTask.notes) + '</i>' : ''}</td>
      `;
    } else {
      leftCell = `
        <td width="4%" style="border:1px solid #000000;"></td>
        <td width="46%" style="border:1px solid #000000;"></td>
      `;
    }

    let rightCell = '';
    if (rTask) {
      const isDone = rTask.status === 'completed' ? '☒' : '☐';
      const ex = rTask.extra_json || {};
      let extra = '';
      if (rTask.item_key === 'sys3' && ex.extraVal) extra = ` – ${ex.extraVal}`;

      rightCell = `
        <td width="4%" style="border:1px solid #000000;text-align:center;font-size:10pt;font-family:'Arial';">${isDone}</td>
        <td width="46%" style="border:1px solid #000000;font-size:9pt;font-family:'Calibri';">${esc(rTask.label)}${extra}${rTask.notes ? '<br><i style="color:#555;">Note: ' + esc(rTask.notes) + '</i>' : ''}</td>
      `;
    } else {
      rightCell = `
        <td width="4%" style="border:1px solid #000000;"></td>
        <td width="46%" style="border:1px solid #000000;"></td>
      `;
    }

    rowsHtml += `<tr>${leftCell}${rightCell}</tr>`;
  }

  const leftTitle = leftSec ? esc(leftSec.title) : '';
  const rightTitle = rightSec ? esc(rightSec.title) : '';

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:6pt;">
      <tr style="background:#F2F2F2;">
        <th colspan="2" width="50%" style="border:1px solid #000000;font-size:10pt;font-weight:bold;padding:3pt 5pt;font-family:'Calibri';">${leftTitle}</th>
        <th colspan="2" width="50%" style="border:1px solid #000000;font-size:10pt;font-weight:bold;padding:3pt 5pt;font-family:'Calibri';">${rightTitle}</th>
      </tr>
      ${rowsHtml}
    </table>
  `;
}

function renderCRFCategoriesTable(tasks) {
  const cTasks = {};
  tasks.forEach(t => { cTasks[t.item_key] = t; });

  const getTaskState = (id, defLabel = '') => {
    const t = cTasks[id];
    return {
      checked: t && t.status === 'completed' ? '☒' : '☐',
      label: t ? t.label : defLabel,
      extra: t ? t.extra_json || {} : {}
    };
  };

  const cldd_edi = getTaskState('cldd_edi', 'EDI Structure');
  const cldd_ded = getTaskState('cldd_ded', 'Deductions');
  const cldd_bill = getTaskState('cldd_bill', 'Billing');

  const clddGroupChecked = (cldd_edi.checked === '☒' || cldd_ded.checked === '☒' || cldd_bill.checked === '☒') ? '☒' : '☐';

  const ediFiles = cldd_edi.extra.files || '';
  const ediHours = cldd_edi.extra.hours || '';
  const ediAmount = cldd_edi.extra.amount || '';
  const ediDetail = `Files: ${ediFiles || 'Enter #'} | Hours: ${ediHours || 'Enter #:'} | Amount: $${ediAmount || 'Enter $'}`;

  const planRules = getTaskState('plan_rules', 'Plan Rules');
  const rates = getTaskState('rates', 'Rates');
  const dataFix = getTaskState('data_fix', 'Data Fix');
  const reports = getTaskState('reports', 'Reports');
  const setup = getTaskState('setup', 'Setup');
  const notifications = getTaskState('notifications', 'Notifications');
  const process = getTaskState('process', 'Process');
  const ediNonCldd = getTaskState('edi_noncldd', 'EDI (non-CLDD changes)');
  const newFeature = getTaskState('new_feature', 'New Feature');

  const customItems = tasks.filter(t => t.section_key === 'categories' && !['cldd_edi', 'cldd_ded', 'cldd_bill', 'plan_rules', 'rates', 'data_fix', 'reports', 'setup', 'notifications', 'process', 'edi_noncldd', 'new_feature'].includes(t.item_key));
  const customRows = customItems.map(t => `
    <tr>
      <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;font-family:'Calibri';">${t.status === 'completed' ? '☒' : '☐'} ${esc(t.label)}</td>
      <td style="border:1px solid #000000;padding:3pt 5pt;font-family:'Calibri';"></td>
    </tr>
  `).join('');

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:6pt;font-size:9pt;font-family:'Calibri';">
      <tr style="background:#F2F2F2;">
        <th width="30%" style="border:1px solid #000000;padding:3pt 5pt;font-weight:bold;">Group</th>
        <th width="30%" style="border:1px solid #000000;padding:3pt 5pt;font-weight:bold;">Item</th>
        <th width="40%" style="border:1px solid #000000;padding:3pt 5pt;font-weight:bold;">Detail / Notes</th>
      </tr>
      <tr>
        <td rowspan="3" valign="top" style="border:1px solid #000000;padding:3pt 5pt;">${clddGroupChecked} CLDD</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">${cldd_edi.checked} EDI Structure</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">${esc(ediDetail)}</td>
      </tr>
      <tr>
        <td style="border:1px solid #000000;padding:3pt 5pt;">${cldd_ded.checked} Deductions</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;"></td>
      </tr>
      <tr>
        <td style="border:1px solid #000000;padding:3pt 5pt;">${cldd_bill.checked} Billing</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Proposed change in grid must be attached</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${planRules.checked} Plan Rules</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${rates.checked} Rates</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${dataFix.checked} Data Fix</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${reports.checked} Reports</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${setup.checked} Setup</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${notifications.checked} Notifications</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${process.checked} Process</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;">Choose an item.</td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${ediNonCldd.checked} EDI (non-CLDD changes)</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;"></td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000000;padding:3pt 5pt;">${newFeature.checked} New Feature</td>
        <td style="border:1px solid #000000;padding:3pt 5pt;"></td>
      </tr>
      ${customRows}
    </table>
  `;
}

app.get('/api/submissions/:id/export', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Not found');
  const rec = fullRecord(row);
  let bodyHtml, filename;

  if (rec.type === 'implementation') {
    const h = rec.header;
    bodyHtml = `<h1>CLIENT IMPLEMENTATION CHECKLIST</h1><div class="subtitle">Workforce Junction &middot; HR Governance Solutions</div>
      <table style="width:100%;border-collapse:collapse;margin-top:10pt;">
        <tr><th width="30%">Field</th><th>Value</th></tr>
        <tr><td>Client Name</td><td>${esc(rec.client)}</td></tr>
        <tr><td>Broker</td><td>${esc(rec.broker)}</td></tr>
        <tr><td>Design Guide Received Date</td><td>${fmtDate(h.designGuideReceived)}</td></tr>
        <tr><td>Implementation Completion Date</td><td>${fmtDate(h.implementationCompletion)}</td></tr>
        <tr><td>Client Go Live Date</td><td>${fmtDate(h.clientGoLive)}</td></tr>
        <tr><td>Headcount</td><td>${esc(h.headcount)}</td></tr>
        <tr><td>Status</td><td><b>${stageLabel(rec.status)}</b></td></tr>
      </table>`;
    filename = `${rec.client || 'Client'} Implementation Checklist.doc`;
  } else if (rec.type === 'termination') {
    const h = rec.header;
    const metaTable = `
      <div style="font-size:13pt;font-weight:bold;margin-bottom:2pt;text-align:center;font-family:'Calibri';">CLIENT TERMINATION CHECKLIST</div>
      <div style="font-size:9pt;color:#555;margin-bottom:8pt;text-align:center;font-family:'Calibri';">Workforce Junction &middot; HR Governance Solutions</div>
      <table style="width:100%;border:none;margin-bottom:8pt;font-size:9.5pt;font-family:'Calibri';">
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Client:</b> ${esc(rec.client)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Broker Partner:</b> ${esc(rec.broker)}</td>
        </tr>
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Requested Termination Date:</b> ${fmtDate(h.requestedDate)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>CRM:</b> ${esc(h.crm)}</td>
        </tr>
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Termination Reason:</b> ${esc(h.reason)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>EE Headcount:</b> ${esc(h.eeHeadcount) || '—'}</td>
        </tr>
        <tr>
          <td colspan="2" style="border:none;padding:1pt 0;"><b>Status:</b> <b>${stageLabel(rec.status)}</b></td>
        </tr>
      </table>
    `;

    const tablesHtml = `
      ${renderPairedTable('crm', 'edi', rec.tasks)}
      ${renderPairedTable('analytics', 'systems', rec.tasks)}
      ${renderPairedTable('benefits', 'finance', rec.tasks)}
      ${renderPairedTable(null, 'sales', rec.tasks)}
    `;

    bodyHtml = metaTable + tablesHtml;
    filename = `${rec.client || 'Client'} Termination Checklist.doc`;
  } else {
    const h = rec.header, b = rec.body;
    const req_ = b.request || {}, sol = b.solution || {}, note = b.note || {}, appr = b.approval || {}, fin = b.finalSolution || {}, sow = b.sow || {}, action = b.action || {};

    const changeChecked = note.kind === 'change' ? '☒' : '☐';
    const correctionChecked = note.kind === 'correction' ? '☒' : '☐';

    bodyHtml = `
      <div style="font-size:8pt;color:#555;margin-bottom:8pt;font-family:'Calibri';">
        Make sure you’re not editing the template!<br>
        Save in the Change Requests Folder for each customer: <i>&lt;Client Name&gt; CRF &lt;change info in brief&gt; &lt;request date&gt;.doc</i><br>
        Do not attach to emails or conversations, only use the SharePoint link to share.
      </div>
      <div style="font-size:13pt;font-weight:bold;margin-bottom:2pt;text-align:center;font-family:'Calibri';">CHANGE REQUEST FORM</div>
      <div style="font-size:9pt;color:#555;margin-bottom:8pt;text-align:center;font-family:'Calibri';">Workforce Junction &middot; HR Governance Solutions</div>
      
      <table style="width:100%;border:none;margin-bottom:8pt;font-size:9.5pt;font-family:'Calibri';">
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Reference Conversation No:</b> ${esc(h.refConversation)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Client:</b> ${esc(rec.client)}</td>
        </tr>
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Submitted by:</b> ${esc(h.submittedBy)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Broker Partner:</b> ${esc(rec.broker)}</td>
        </tr>
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Submitted on:</b> ${fmtDate(h.submittedOn)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Completed on:</b> ${fmtDate(h.completedOn)}</td>
        </tr>
        <tr>
          <td colspan="2" style="border:none;padding:1pt 0;"><b>Status:</b> <b>${stageLabel(rec.status)}</b></td>
        </tr>
      </table>

      <h2>Request</h2>
      <table style="width:100%;border:none;font-size:9.5pt;font-family:'Calibri';">
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Requested by:</b> ${esc(req_.requestedBy)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Date of request:</b> ${fmtDate(req_.dateOfRequest)}</td>
        </tr>
        <tr>
          <td colspan="2" style="border:none;padding:1pt 0;">
            ${req_.modified === 'yes' ? '☒' : '☐'} Was the initial request modified
          </td>
        </tr>
      </table>
      <div style="margin-top:4pt;font-size:9.5pt;font-family:'Calibri';">
        <b>What is the request and why? What problem is it trying to solve for?</b><br>
        <div style="padding:3pt 0;white-space:pre-wrap;">${esc(req_.requestText)}</div>
        <b>Desired completion date:</b> ${fmtDate(req_.desiredCompletion)}
      </div>

      <h2>Suggested Change/Solution</h2>
      <table style="width:100%;border:none;font-size:9.5pt;font-family:'Calibri';">
        <tr>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Solution Architect:</b> ${esc(sol.architect)}</td>
          <td style="border:none;width:50%;padding:1pt 0;"><b>Reviewed on:</b> ${fmtDate(sol.reviewedOn)}</td>
        </tr>
      </table>
      <div style="margin-top:4pt;font-size:9.5pt;font-family:'Calibri';">
        <b>Proposed solution to be presented to Requestor with justification of associated costs.</b><br>
        <div style="padding:3pt 0;white-space:pre-wrap;">${esc(sol.proposedSolution)}</div>
        <b>Fee:</b> ${sol.feeNone ? '☐ Enter Fee Amount &nbsp;&nbsp;&nbsp; ☒ None' : `☒ Fee: $${esc(sol.fee)} &nbsp;&nbsp;&nbsp; ☐ None`}<br>
        <b>Proposed completion date:</b> ${fmtDate(sol.proposedCompletion)}
      </div>

      <h2>Change Category</h2>
      ${renderCRFCategoriesTable(rec.tasks)}

      <h2>Note</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';line-height:1.4;">
        ${changeChecked} Change: from what was requested earlier by Customer (Customer issue)<br>
        ${correctionChecked} Correction: of how request was implemented (WFJ issue)
      </div>

      <h2>Approval of Solution &amp; Fees</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';">
        ${appr.approvedBy ? '☒' : '☐'} Approved by: ${esc(appr.approvedBy)} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Date: ${fmtDate(appr.approvedDate)} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Ticket #: ${esc(appr.ticketNo)}<br>
        Fees: ${appr.feesCharged === 'yes' ? '☒ Charged &nbsp; ☐ None' : '☐ Charged &nbsp; ☒ None'}<br>
        If fees were charged, what is the Hello Sign ticket #: ${esc(appr.helloSignTicket || 'Number')}
      </div>

      <h2>Final Solution</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';">
        ${fin.approved ? '☒' : '☐'} Approved<br>
        <i>Final solution must be executed when CSO has been signed, but up to Solution Architect’s discretion.</i><br>
        <b>Date promised:</b> ${fmtDate(fin.datePromised)}
      </div>

      <h2>What action must be taken?</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';line-height:1.4;">
        ${action.configChange ? '☒' : '☐'} Configuration Change &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        ${action.maintenanceFix ? '☒' : '☐'} Maintenance Fix &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        ${action.dataFix ? '☒' : '☐'} Data Fix &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        ${action.sprintRelease ? '☒' : '☐'} Sprint Release &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        ${action.edi ? '☒' : '☐'} EDI &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        ${action.processChange ? '☒' : '☐'} Process Change
      </div>

      <h2>Describe Statement of Work</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';white-space:pre-wrap;margin-bottom:8pt;">${esc(sow.text)}</div>
      
      <h2>Insert Screenshots/Images here:</h2>
      <div style="font-size:9.5pt;font-family:'Calibri';color:#666;font-style:italic;">${esc(sow.screenshotNote) || 'Please use this section for screenshots/images'}</div>
    `;
    filename = `${rec.client || 'Client'} CRF.doc`;
  }

  const html = wordDoc(filename, bodyHtml);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.send('\ufeff' + html);
});

// ---------- Dashboard Excel export ----------


app.get('/api/export-dashboard', (req, res) => {
  const type = req.query.type;
  if (type === 'termination') return res.redirect('/api/export-excel/termination');
  if (type === 'implementation') return res.redirect('/api/export-excel/implementation');
  if (type === 'open_enrollment') return res.redirect('/api/export-excel/open_enrollment');
  return res.redirect('/api/export-excel/crf');
});

// ---------- Type-specific Excel exports (exact tracker column formats) ----------

app.get('/api/export-excel/crf', async (req, res) => {
  try {
    const buffer = await generateCRFExcel();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="CRF Config Master Tracker.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('CRF export failed:', e);
    res.status(500).send('Error generating Excel file: ' + e.message);
  }
});

app.get('/api/export-excel/open_enrollment', async (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM submissions WHERE type = 'open_enrollment' AND is_deleted = 0 AND status != 'draft' ORDER BY created_at DESC").all();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Workforce Junction';
    const ws = wb.addWorksheet('OE Tracker', { views: [{ showGridLines: true }] });

    ws.columns = [
      { header: 'S.No', width: 8 },
      { header: 'OE Renewal Doc Received Date', width: 22 },
      { header: 'Client', width: 30 },
      { header: 'CRM', width: 20 },
      { header: 'OE Start Date', width: 16 },
      { header: 'OE End Date (EE)', width: 16 },
      { header: 'OE End Date (HR)', width: 16 },
      { header: 'OE Effective Date', width: 16 },
      { header: 'Type of OE', width: 16 },
      { header: 'List/Work Flow OE', width: 18 },
      { header: 'Plans Going Through Active OE', width: 30 },
      { header: 'Plans Going Through Passive OE', width: 30 },
      { header: 'OE Setup Status', width: 18 },
      { header: 'OE Review/Testing Status', width: 22 },
      { header: 'OE Finalization Rules Status', width: 25 },
      { header: 'OE Finalization Start Date & End Date', width: 28 },
      { header: 'OE Announcement Email Sent By', width: 26 },
      { header: 'OE Reminder Email Frequency', width: 24 },
      { header: 'HGS Comments', width: 35 },
      { header: 'OE Closure', width: 16 },
      { header: 'OE Finalization Date', width: 18 }
    ];

    const headerRow = ws.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 10, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9EAD3' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'CCCCCC' } },
        left: { style: 'thin', color: { argb: 'CCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'CCCCCC' } },
        right: { style: 'thin', color: { argb: 'CCCCCC' } }
      };
    });

    rows.forEach((r, i) => {
      const h = safeParse(r.header_json, {});
      const dataRow = ws.addRow([
        i + 1,
        h.oeDocReceivedDate || '',
        r.client || '',
        h.crm || '',
        h.oeStartDate || '',
        h.oeEndDate || '',
        h.oeEndDateHR || '',
        h.oeEffectiveDate || '',
        h.typeOfOe || '',
        h.listOrWorkflow || '',
        h.activePlans || '',
        h.passivePlans || '',
        h.setupStatus || '',
        h.testingStatus || '',
        h.finalizationRulesStatus || '',
        h.finalizationStartEndDate || '',
        h.announcementEmailSentBy || '',
        h.reminderEmailsFrequency || '',
        h.comments || '',
        h.oeClosure || '',
        h.oeFinalizationDate || ''
      ]);
      dataRow.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'E0E0E0' } },
          left: { style: 'thin', color: { argb: 'E0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'E0E0E0' } },
          right: { style: 'thin', color: { argb: 'E0E0E0' } }
        };
      });
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Open Enrollment Tracker.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('Open Enrollment export failed:', e);
    res.status(500).send('Error generating Excel file: ' + e.message);
  }
});

app.get('/api/export-excel/implementation', async (req, res) => {
  if (!fs.existsSync(TEMPLATE_IMPL_TERM)) return res.status(404).send('Impl/Term Master Template not found in Document folder.');
  try {
    const rowsData = buildRowsData('implementation');
    const buffer = await populateWithXlsxPopulate(TEMPLATE_IMPL_TERM, 'implementation', rowsData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Clients Implemented.xlsx"');
    res.send(buffer);
  } catch (e) {
    console.error('Implementation export failed:', e);
    res.status(500).send('Error generating Excel file');
  }
});

app.get('/api/export-excel/termination', async (req, res) => {
  if (!fs.existsSync(TEMPLATE_IMPL_TERM)) return res.status(404).send('Impl/Term Master Template not found in Document folder.');
  try {
    const rowsData = buildRowsData('termination');
    const buffer = await populateWithXlsxPopulate(TEMPLATE_IMPL_TERM, 'termination', rowsData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Clients Terminated.xlsx"');
    res.send(buffer);
  } catch (e) {
    console.error('Termination export failed:', e);
    res.status(500).send('Error generating Excel file');
  }
});

// Reads a cell's true value. If it's an Excel time-formatted number (h:mm),
// converts the day-fraction serial into decimal hours instead of a raw decimal.
function getExcelCellText(ws, rowIdx, colIdx) {
  if (colIdx === undefined) return '';
  const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  const cell = ws[ref];
  if (!cell) return '';
  if (cell.t === 'n' && cell.z && cell.z.includes(':') && /h/i.test(cell.z)) {
    const hours = cell.v * 24;
    return (Math.round(hours * 100) / 100).toString();
  }
  if (cell.w !== undefined && cell.w !== null) return String(cell.w).trim();
  if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
  return '';
}

// ---------- Excel import (round-trips with the exports above) ----------

function parseExcelDate(val) {
  if (val === undefined || val === null || val === '') return '';
  if (typeof val === 'number') {
    if (val > 10000 && val < 100000) {
      const date = new Date(Math.round((val - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) {
        return date.toISOString().slice(0, 10);
      }
    }
    return String(val);
  }
  const str = String(val).trim();
  if (!str) return '';
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = parseFloat(str);
    if (num > 10000 && num < 100000) {
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) {
        return date.toISOString().slice(0, 10);
      }
    }
  }
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return str;
}

app.post('/api/import-excel/:type', upload.single('file'), (req, res) => {
  const type = req.params.type;
  if (!['termination', 'crf', 'implementation', 'open_enrollment'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    return res.status(400).json({ error: 'could not read Excel file: ' + e.message });
  }

  const now = nowIso();
  let created = 0;
  let totalRows = 0;
  let errors = 0;

  db.exec('BEGIN');
  try {
    wb.SheetNames.forEach(sheetName => {
      const ws = wb.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!grid || grid.length === 0) return;

      let headerRowIdx = -1;
      let colIndices = {};

      // Scan rows to find one that matches our expected headers
      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row || !Array.isArray(row)) continue;

        let tempIndices = {};
        row.forEach((cell, cIdx) => {
          if (cell === null || cell === undefined) return;
          const cellStr = String(cell).trim().toLowerCase().replace(/\s+/g, '');


          if (type === 'crf') {
            if (cellStr.includes('clientname')) tempIndices['client'] = cIdx;
            else if (cellStr.includes('partnername') || cellStr.includes('brokername')) tempIndices['broker'] = cIdx;
            else if (cellStr.includes('conversation')) tempIndices['refConversation'] = cIdx;
            else if (cellStr.includes('changerequestedby')) tempIndices['requestedBy'] = cIdx;
            else if (cellStr.includes('changerequestdate')) tempIndices['dateOfRequest'] = cIdx;
            else if (cellStr.includes('reasonforraising') || cellStr.includes('reasonraising')) tempIndices['requestText'] = cIdx;
            else if (cellStr.includes('changerequest')) tempIndices['proposedSolution'] = cIdx;
            else if (cellStr.includes('timespentonconfig')) tempIndices['timeConfig'] = cIdx;
            else if (cellStr.includes('timespentonreview') || cellStr.includes('timespentontesting')) tempIndices['timeTesting'] = cIdx;
            else if (cellStr.includes('noof') && cellStr.includes('error')) tempIndices['errors'] = cIdx;
            else if (cellStr.includes('configurationanalyst') || cellStr.includes('configanalyst')) tempIndices['configAnalyst'] = cIdx;
            else if (cellStr.includes('testinganalyst') || cellStr.includes('reviewanalyst')) tempIndices['testingAnalyst'] = cIdx;
            else if (cellStr.includes('implementationmanager')) tempIndices['implementationManager'] = cIdx;
            else if (cellStr.includes('completeddate')) tempIndices['completedOn'] = cIdx;
            else if (cellStr.includes('rating')) tempIndices['rating'] = cIdx;
            else if (cellStr.includes('comments')) tempIndices['comments'] = cIdx;
            else if (cellStr.includes('billable')) tempIndices['billable'] = cIdx;
            else if (cellStr.includes('category')) tempIndices['category'] = cIdx;
          } else if (type === 'implementation') {
            if (cellStr === 'clientname') tempIndices['client'] = cIdx;
            else if (cellStr === 'broker' || cellStr === 'brokername') tempIndices['broker'] = cIdx;
            else if (cellStr === 'designguidereceiveddate') tempIndices['designGuideReceived'] = cIdx;
            else if (cellStr === 'implementationcompletiondate') tempIndices['implementationCompletion'] = cIdx;
            else if (cellStr === 'clientgolivedate') tempIndices['clientGoLive'] = cIdx;
            else if (cellStr === 'headcount') tempIndices['headcount'] = cIdx;
          } else if (type === 'termination') {
            if (cellStr === 'clients' || cellStr === 'client' || cellStr === 'clientname') tempIndices['client'] = cIdx;
            else if (cellStr === 'broker' || cellStr === 'brokername') tempIndices['broker'] = cIdx;
            else if (cellStr === 'terminationeffectivedate') tempIndices['requestedDate'] = cIdx;
            else if (cellStr === 'eeheadcount') tempIndices['eeHeadcount'] = cIdx;
            else if (cellStr === 'reason') tempIndices['reason'] = cIdx;
          } else if (type === 'open_enrollment') {
            if (cellStr.includes('client')) tempIndices['client'] = cIdx;
            else if (cellStr.includes('renewaldoc')) tempIndices['oeDocReceivedDate'] = cIdx;
            else if (cellStr === 'crm') tempIndices['crm'] = cIdx;
            else if (cellStr.includes('configanalyst')) tempIndices['configAnalyst'] = cIdx;
            else if (cellStr.includes('finilizationrulesstatus') || cellStr.includes('finalizationrulesstatus')) tempIndices['finalizationRulesStatus'] = cIdx;
            else if (cellStr.includes('finilizationstartdate') || cellStr.includes('finalizationstartdate')) tempIndices['finalizationStartEndDate'] = cIdx;
            else if (cellStr.includes('finalizationdate') || cellStr.includes('finilizationdate')) tempIndices['oeFinalizationDate'] = cIdx;
            else if (cellStr.includes('startdate')) tempIndices['oeStartDate'] = cIdx;
            else if (cellStr.includes('enddate') && cellStr.includes('hr')) tempIndices['oeEndDateHR'] = cIdx;
            else if (cellStr.includes('enddate')) tempIndices['oeEndDate'] = cIdx;
            else if (cellStr.includes('effective')) tempIndices['oeEffectiveDate'] = cIdx;
            else if (cellStr.includes('typeofoe')) tempIndices['typeOfOe'] = cIdx;
            else if (cellStr.includes('list/workflow') || cellStr.includes('listorworkflow') || cellStr.includes('list/workflowtype')) tempIndices['listOrWorkflow'] = cIdx;
            else if (cellStr.includes('activeoe') || cellStr.includes('activeplans')) tempIndices['activePlans'] = cIdx;
            else if (cellStr.includes('passiveoe') || cellStr.includes('passiveplans')) tempIndices['passivePlans'] = cIdx;
            else if (cellStr.includes('setupstatus')) tempIndices['setupStatus'] = cIdx;
            else if (cellStr.includes('review/testingstatus') || cellStr.includes('testingstatus')) tempIndices['testingStatus'] = cIdx;
            else if (cellStr.includes('announcementemail') || cellStr.includes('announcementsentby')) tempIndices['announcementEmailSentBy'] = cIdx;
            else if (cellStr.includes('reminderemail') || cellStr.includes('reminderfrequency')) tempIndices['reminderEmailsFrequency'] = cIdx;
            else if (cellStr.includes('hgscomments') || cellStr.includes('comments')) tempIndices['comments'] = cIdx;
            else if (cellStr.includes('oeclosure') || cellStr.includes('closure')) tempIndices['oeClosure'] = cIdx;
            else if (cellStr.includes('confirmationemails')) tempIndices['confirmationEmails'] = cIdx;
          }
        });

        let isHeader = false;
        if (type === 'crf' && tempIndices['client'] !== undefined && tempIndices['refConversation'] !== undefined) {
          isHeader = true;
        } else if (type === 'implementation' && tempIndices['client'] !== undefined && tempIndices['designGuideReceived'] !== undefined) {
          isHeader = true;
        } else if (type === 'termination' && tempIndices['client'] !== undefined && tempIndices['requestedDate'] !== undefined) {
          isHeader = true;
        } else if (type === 'open_enrollment' && tempIndices['client'] !== undefined) {
          isHeader = true;
        }

        if (isHeader) {
          headerRowIdx = r;
          colIndices = tempIndices;
          break;
        }
      }

      if (headerRowIdx === -1) return;

      for (let r = headerRowIdx + 1; r < grid.length; r++) {
        const row = grid[r];
        if (!row || !Array.isArray(row)) continue;

        /*const getVal = (colKey) => {
          const idx = colIndices[colKey];
          if (idx === undefined || row[idx] === undefined || row[idx] === null) return '';
          return String(row[idx]).trim()  ;
        };*/

        // NEW — replace with this:
        const getVal = (colKey) => getExcelCellText(ws, r, colIndices[colKey]);

        const client = getVal('client');
        if (!client) continue;

        totalRows++;
        try {
          const id = uid();
          const broker = getVal('broker');

          if (type === 'crf') {
            const header = {
              refConversation: getVal('refConversation'),
              completedOn: parseExcelDate(getVal('completedOn')),
              submittedOn: parseExcelDate(getVal('dateOfRequest'))
            };
            const body = {
              request: {
                requestedBy: getVal('requestedBy'),
                dateOfRequest: parseExcelDate(getVal('dateOfRequest')),
                requestText: getVal('requestText')
              },
              solution: {
                proposedSolution: getVal('proposedSolution')
              },
              tracking: {
                category: getVal('category'),
                timeConfig: getVal('timeConfig'),
                timeTesting: getVal('timeTesting'),
                errors: getVal('errors'),
                configAnalyst: getVal('configAnalyst'),
                testingAnalyst: getVal('testingAnalyst'),
                implementationManager: getVal('implementationManager'),
                rating: getVal('rating'),
                comments: getVal('comments'),
                billable: getVal('billable')
              }
            };
            db.prepare(`INSERT INTO submissions (id, type, client, broker, status, header_json, body_json, created_at, updated_at) VALUES (?, 'crf', ?, ?, 'completed', ?, ?, ?, ?)`)
              .run(id, client, broker, JSON.stringify(header), JSON.stringify(body), now, now);
          } else if (type === 'implementation') {
            const header = {
              designGuideReceived: parseExcelDate(getVal('designGuideReceived')),
              implementationCompletion: parseExcelDate(getVal('implementationCompletion')),
              clientGoLive: parseExcelDate(getVal('clientGoLive')),
              headcount: getVal('headcount')
            };
            db.prepare(`INSERT INTO submissions (id, type, client, broker, status, header_json, body_json, created_at, updated_at) VALUES (?, 'implementation', ?, ?, 'completed', ?, '{}', ?, ?)`)
              .run(id, client, broker, JSON.stringify(header), now, now);
          } else if (type === 'termination') {
            const header = {
              requestedDate: parseExcelDate(getVal('requestedDate')),
              eeHeadcount: getVal('eeHeadcount'),
              reason: getVal('reason')
            };
            db.prepare(`INSERT INTO submissions (id, type, client, broker, status, header_json, body_json, created_at, updated_at) VALUES (?, 'termination', ?, ?, 'completed', ?, '{}', ?, ?)`)
              .run(id, client, broker, JSON.stringify(header), now, now);
          } else if (type === 'open_enrollment') {
            const header = {
              oeDocReceivedDate: parseExcelDate(getVal('oeDocReceivedDate')),
              crm: getVal('crm'),
              configAnalyst: getVal('configAnalyst'),
              oeStartDate: parseExcelDate(getVal('oeStartDate')),
              oeEndDate: parseExcelDate(getVal('oeEndDate')),
              oeEndDateHR: parseExcelDate(getVal('oeEndDateHR')),
              oeEffectiveDate: parseExcelDate(getVal('oeEffectiveDate')),
              typeOfOe: getVal('typeOfOe'),
              listOrWorkflow: getVal('listOrWorkflow'),
              activePlans: getVal('activePlans'),
              passivePlans: getVal('passivePlans'),
              setupStatus: getVal('setupStatus'),
              testingStatus: getVal('testingStatus'),
              finalizationRulesStatus: getVal('finalizationRulesStatus'),
              finalizationStartEndDate: getVal('finalizationStartEndDate'),
              announcementEmailSentBy: parseExcelDate(getVal('announcementEmailSentBy')),
              reminderEmailsFrequency: getVal('reminderEmailsFrequency'),
              comments: getVal('comments'),
              oeClosure: getVal('oeClosure'),
              oeFinalizationDate: parseExcelDate(getVal('oeFinalizationDate')),
              confirmationEmails: getVal('confirmationEmails')
            };
            db.prepare(`INSERT INTO submissions (id, type, client, broker, status, header_json, body_json, created_at, updated_at) VALUES (?, 'open_enrollment', ?, '', 'completed', ?, '{}', ?, ?)`)
              .run(id, client, JSON.stringify(header), now, now);
          }
          created++;
        } catch (err) {
          errors++;
          console.warn('Import row failed:', err.message);
        }
      }
    });

    db.exec('COMMIT');
    res.json({ ok: true, created, totalRows, errors });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Import process failed:', e);
    res.status(500).json({ error: 'Import failed: ' + e.message });
  }
});

// ---------- fallback to SPA ----------
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  console.log(`Workforce Junction app running on http://localhost:${PORT}`);
  // On cloud (Railway), skip boot-time Excel sync to avoid OOM.
  // Excel files will be regenerated on first data change.
  const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);
  if (!isCloud) {
    // Defer local boot sync by 10s so server accepts requests first
    setTimeout(() => {
      updateTrackerExcel('crf');
      updateTrackerExcel('implementation');
      updateTrackerExcel('termination');
    }, 10000);
  }
});
