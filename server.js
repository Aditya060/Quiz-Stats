const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
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
  text TEXT NOT NULL
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(question_id) REFERENCES questions(id),
  FOREIGN KEY(option_id) REFERENCES options(id)
);
`);

// Seed data if empty
const questionCount = db.prepare('SELECT COUNT(1) as c FROM questions').get().c;
if (questionCount === 0) {
  const insertQuestion = db.prepare('INSERT INTO questions (text) VALUES (?)');
  const insertOption = db.prepare('INSERT INTO options (question_id, text) VALUES (?, ?)');
  const seed = db.transaction(() => {
    const q1 = insertQuestion.run('What is your favorite programming language?').lastInsertRowid;
    insertOption.run(q1, 'JavaScript');
    insertOption.run(q1, 'Python');
    insertOption.run(q1, 'Java');
    insertOption.run(q1, 'C++');

    const q2 = insertQuestion.run('Which frontend framework do you prefer?').lastInsertRowid;
    insertOption.run(q2, 'React');
    insertOption.run(q2, 'Vue');
    insertOption.run(q2, 'Angular');
    insertOption.run(q2, 'Svelte');

    const q3 = insertQuestion.run('What is your preferred database?').lastInsertRowid;
    insertOption.run(q3, 'PostgreSQL');
    insertOption.run(q3, 'MySQL');
    insertOption.run(q3, 'SQLite');
    insertOption.run(q3, 'MongoDB');
  });
  seed();
}

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
  res.json({ ok: true });
});

// API: stats per question/option
app.get('/api/stats', (req, res) => {
  const questions = db.prepare('SELECT id, text FROM questions').all();
  const optionsStmt = db.prepare('SELECT id, text FROM options WHERE question_id = ?');
  const countStmt = db.prepare('SELECT COUNT(1) as c FROM responses WHERE option_id = ?');
  const payload = questions.map(q => {
    const opts = optionsStmt.all(q.id).map(o => ({
      id: o.id,
      text: o.text,
      count: countStmt.get(o.id).c
    }));
    return { id: q.id, text: q.text, options: opts };
  });
  res.json({ stats: payload });
});

// Serve pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


