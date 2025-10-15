const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB (configurable for Render persistent disk)
const DEFAULT_DATA_DIR = path.join(__dirname, 'data');
const FALLBACK_TMP_DB = path.join('/tmp', 'quiz.db');
let dbFilePath = process.env.DB_FILE || path.join(DEFAULT_DATA_DIR, 'quiz.db');
try {
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
} catch (err) {
  if (err && (err.code === 'EACCES' || err.code === 'EROFS')) {
    console.warn(`[quiz] Cannot create DB dir at ${path.dirname(dbFilePath)} (${err.code}). Falling back to ${FALLBACK_TMP_DB}.`);
    try {
      fs.mkdirSync(path.dirname(FALLBACK_TMP_DB), { recursive: true });
      dbFilePath = FALLBACK_TMP_DB;
    } catch (e2) {
      console.error(`[quiz] Failed to prepare fallback DB dir: ${e2.message}`);
      process.exit(1);
    }
  } else {
    throw err;
  }
}
const db = new Database(dbFilePath);
db.pragma('journal_mode = WAL');

// Create tables if not exists
db.exec(`
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  correct_option_id INTEGER
);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  device_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(question_id) REFERENCES questions(id),
  FOREIGN KEY(option_id) REFERENCES options(id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS qna_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  answered INTEGER DEFAULT 0,
  answer_text TEXT
);
`);

// Ensure device_id column and uniqueness for one-vote-per-device-per-question
try {
  const cols = db.prepare("PRAGMA table_info(responses)").all();
  const hasDevice = cols.some(c => c.name === 'device_id');
  if (!hasDevice) {
    db.exec('ALTER TABLE responses ADD COLUMN device_id TEXT;');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_device_question ON responses(device_id, question_id);');
  // ensure correct_option_id exists on questions (older installs)
  const qcols = db.prepare("PRAGMA table_info(questions)").all();
  if (!qcols.some(c => c.name === 'correct_option_id')) {
    db.exec('ALTER TABLE questions ADD COLUMN correct_option_id INTEGER;');
  }
} catch (e) {
  console.warn('[quiz] Migration check for responses.device_id failed:', e.message);
}

// Seed data with versioning
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const currentSeed = getMeta.get('seed_version')?.value || '0';
if (currentSeed !== '4') {
  const deleteAll = db.transaction(() => {
    db.exec('DELETE FROM responses; DELETE FROM options; DELETE FROM questions;');
  });
  deleteAll();

  const insertQuestion = db.prepare('INSERT INTO questions (text) VALUES (?)');
  const insertOption = db.prepare('INSERT INTO options (question_id, text) VALUES (?, ?)');
  const setCorrect = db.prepare('UPDATE questions SET correct_option_id = ? WHERE id = ?');
  const seedV4 = db.transaction(() => {
    const q1 = insertQuestion.run('When was Alef launched?').lastInsertRowid;
    const q1o1 = insertOption.run(q1, '2012').lastInsertRowid;
    const q1o2 = insertOption.run(q1, '2013').lastInsertRowid;
    const q1o3 = insertOption.run(q1, '2014').lastInsertRowid;
    // set correct if known later via admin; leaving null by default

    const q2 = insertQuestion.run('How many units are there approximately in Al Mamsha?').lastInsertRowid;
    insertOption.run(q2, '1500');
    insertOption.run(q2, '5000');
    insertOption.run(q2, '10000');

    const q3 = insertQuestion.run("What was Alef's first project?").lastInsertRowid;
    insertOption.run(q3, 'Al Mamsha');
    insertOption.run(q3, '06 Mall');
    insertOption.run(q3, 'Olfah');

    const q4 = insertQuestion.run('How large is the swimmable area in Hayyan?').lastInsertRowid;
    insertOption.run(q4, '30,000 sq.ft');
    insertOption.run(q4, '55,000 sq.ft');
    insertOption.run(q4, '80,000 sq.ft');
  });
  seedV4();
  setMeta.run('seed_version', '4');
}

// Initialize poll state defaults
if (!getMeta.get('poll_status')) setMeta.run('poll_status', 'idle');
if (!getMeta.get('active_question_index')) setMeta.run('active_question_index', '0');
if (!getMeta.get('reveal_correct')) setMeta.run('reveal_correct', '0');

// API: get questions with options
app.get('/api/questions', (req, res) => {
  const questions = db.prepare('SELECT id, text FROM questions').all();
  const optionsStmt = db.prepare('SELECT id, text FROM options WHERE question_id = ?');
  const payload = questions.map(q => ({
    id: q.id,
    text: q.text,
    options: optionsStmt.all(q.id)
  }));
  res.json({ questions: payload });
});

// API: current poll state
app.get('/api/state', (req, res) => {
  const status = getMeta.get('poll_status')?.value || 'idle';
  const activeIndex = Number(getMeta.get('active_question_index')?.value || '0');
  const totalQuestions = db.prepare('SELECT COUNT(1) as c FROM questions').get().c;
  const revealCorrect = getMeta.get('reveal_correct')?.value === '1';
  res.json({ status, activeIndex, totalQuestions, revealCorrect });
});

// API: submit answers [{questionId, optionId}, ...]
app.post('/api/submit', (req, res) => {
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  if (answers.length === 0) {
    return res.status(400).json({ error: 'No answers provided' });
  }
  const insert = db.prepare('INSERT INTO responses (question_id, option_id) VALUES (?, ?)');
  const save = db.transaction((rows) => {
    for (const row of rows) {
      if (!row.questionId || !row.optionId) continue;
      insert.run(row.questionId, row.optionId);
    }
  });
  save(answers);
  io.emit('statsUpdated');
  res.json({ ok: true });
});

// API: single vote (recommended for live poll)
app.post('/api/vote', (req, res) => {
  const questionId = Number(req.body?.questionId);
  const optionId = Number(req.body?.optionId);
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!questionId || !optionId || !deviceId) return res.status(400).json({ error: 'Invalid vote' });
  const existing = db.prepare('SELECT id FROM responses WHERE device_id = ? AND question_id = ?').get(deviceId, questionId);
  if (existing) {
    return res.status(409).json({ error: 'ALREADY_VOTED' });
  }
  db.prepare('INSERT INTO responses (question_id, option_id, device_id) VALUES (?, ?, ?)').run(questionId, optionId, deviceId);
  io.emit('statsUpdated');
  res.json({ ok: true });
});

app.post('/api/vote/reset', (req, res) => {
  const questionId = Number(req.body?.questionId);
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!questionId || !deviceId) return res.status(400).json({ error: 'Invalid reset' });
  const info = db.prepare('DELETE FROM responses WHERE device_id = ? AND question_id = ?').run(deviceId, questionId);
  if (info.changes > 0) io.emit('statsUpdated');
  res.json({ ok: true, removed: info.changes });
});

// API: stats per question/option
app.get('/api/stats', (req, res) => {
  const qid = req.query.questionId ? Number(req.query.questionId) : null;
  const questions = qid
    ? db.prepare('SELECT id, text, correct_option_id FROM questions WHERE id = ?').all(qid)
    : db.prepare('SELECT id, text, correct_option_id FROM questions').all();
  const optionsStmt = db.prepare('SELECT id, text FROM options WHERE question_id = ?');
  const countStmt = db.prepare('SELECT COUNT(1) as c FROM responses WHERE option_id = ?');
  const payload = questions.map(q => {
    const opts = optionsStmt.all(q.id).map(o => ({
      id: o.id,
      text: o.text,
      count: countStmt.get(o.id).c
    }));
    const total = opts.reduce((s, o) => s + o.count, 0);
    return { id: q.id, text: q.text, total, options: opts, correctOptionId: q.correct_option_id };
  });
  res.json({ stats: payload });
});

// Admin: set/unset correct option on a question
app.post('/api/admin/correct', (req, res) => {
  const questionId = Number(req.body?.questionId);
  const optionId = req.body?.optionId === null ? null : Number(req.body?.optionId);
  if (!questionId) return res.status(400).json({ error: 'questionId required' });
  const stmt = db.prepare('UPDATE questions SET correct_option_id = ? WHERE id = ?');
  stmt.run(optionId, questionId);
  io.emit('statsUpdated');
  res.json({ ok: true });
});

// API: admin controls
app.post('/api/admin/start', (req, res) => {
  // reset responses to start fresh
  db.exec('DELETE FROM responses;');
  setMeta.run('active_question_index', '0');
  setMeta.run('poll_status', 'running');
  io.emit('stateChanged');
  res.json({ ok: true });
});

app.post('/api/admin/next', (req, res) => {
  const total = db.prepare('SELECT COUNT(1) as c FROM questions').get().c;
  const current = Number(getMeta.get('active_question_index')?.value || '0');
  const next = Math.min(current + 1, Math.max(0, total - 1));
  setMeta.run('active_question_index', String(next));
  setMeta.run('poll_status', 'running');
  io.emit('stateChanged');
  res.json({ ok: true, index: next });
});

app.post('/api/admin/end', (req, res) => {
  setMeta.run('poll_status', 'ended');
  io.emit('stateChanged');
  res.json({ ok: true });
});

// Admin toggle to reveal/hide correct answers on displays
app.post('/api/admin/reveal-correct', (req, res) => {
  const reveal = Boolean(req.body?.reveal);
  const val = reveal ? '1' : '0';
  setMeta.run('reveal_correct', val);
  io.emit('stateChanged');
  res.json({ ok: true, reveal });
});

// Q&A API
app.post('/api/qna/submit', (req, res) => {
  const text = (req.body?.text || '').trim();
  const user = (req.body?.user || 'Anonymous').trim() || 'Anonymous';
  if (!text) return res.status(400).json({ error: 'Text required' });
  const id = db.prepare('INSERT INTO qna_submissions (user, text) VALUES (?, ?)').run(user, text).lastInsertRowid;
  io.emit('qnaSubmitted');
  res.json({ ok: true, id });
});

app.get('/api/qna/list', (req, res) => {
  const rows = db.prepare('SELECT id, user, text, created_at FROM qna_submissions ORDER BY id DESC LIMIT 200').all();
  res.json({ qna: rows });
});

app.post('/api/qna/highlight', (req, res) => {
  const id = Number(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id required' });
  setMeta.run('qna_highlight_id', String(id));
  io.emit('qnaHighlighted', { id });
  res.json({ ok: true });
});

app.get('/api/qna/highlight', (req, res) => {
  const id = Number(getMeta.get('qna_highlight_id')?.value || '0');
  res.json({ id });
});

// answering removed per spec

// Q&A reject (soft delete)
app.post('/api/qna/reject', (req, res) => {
  const id = Number(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id required' });
  db.prepare('DELETE FROM qna_submissions WHERE id = ?').run(id);
  io.emit('qnaRejected', { id });
  res.json({ ok: true });
});

// Q&A unhighlight
app.post('/api/qna/unhighlight', (req, res) => {
  setMeta.run('qna_highlight_id', '0');
  io.emit('qnaHighlighted', { id: 0 });
  res.json({ ok: true });
});

// Serve pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// QR endpoints: simple landing and image serving
app.get('/qr', (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Scan to Start Quiz</title><style>:root{--accent:#b76a5b;}body{background:#0a0b0f;color:var(--accent);font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:rgba(255,255,255,.06);backdrop-filter:blur(12px) saturate(140%);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.6);text-align:center}img{width:320px;height:320px;border-radius:12px;border:2px solid var(--accent);box-shadow:0 0 30px rgba(183,106,91,.35)}h1{margin:0 0 12px 0;font-weight:700;letter-spacing:.5px}</style></head><body><div class="card"><h1>Scan to Start Quiz</h1><img src="/qr-image" alt="Quiz QR"/></div></body></html>`);
});
app.get('/qr-image', (req, res) => {
  const imgPath = path.join(__dirname, 'Quiz.png');
  if (fs.existsSync(imgPath)) {
    return res.sendFile(imgPath);
  }
  res.status(404).send('QR image not found');
});

// Q&A QR landing and QR image (dynamic)
app.get('/qr-qna', async (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const target = `${origin}/qna.html`;
  const dataUrl = await QRCode.toDataURL(target, { margin: 1, scale: 8, color: { dark: '#b76a5b', light: '#0a0b0f' } });
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Ask Your Question</title><style>:root{--accent:#b76a5b;}body{background:#0a0b0f;color:var(--accent);font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:rgba(255,255,255,.06);backdrop-filter:blur(12px) saturate(140%);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.6);text-align:center}img{width:320px;height:320px;border-radius:12px;border:2px solid var(--accent);box-shadow:0 0 30px rgba(183,106,91,.35)}h1{margin:0 0 12px 0;font-weight:700;letter-spacing:.5px}</style></head><body><div class="card"><h1>Ask Your Question</h1><img src="${dataUrl}" alt="Q&A QR"/><div style="margin-top:10px;">Scan to open Q&A</div></div></body></html>`);
});

io.on('connection', (socket) => {
  // no-op; clients listen for broadcasts
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


