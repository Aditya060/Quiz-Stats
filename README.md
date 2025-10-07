## Quiz-Stats

Simple two-page quiz app with live dashboard using Node.js, Express, and SQLite.

### Run locally

```bash
npm install
npm run dev
# Server: http://localhost:3000
# Quiz: http://localhost:3000/
# Dashboard: http://localhost:3000/dashboard
```

### Tech
- Express for server and static hosting
- better-sqlite3 for embedded DB
- Vanilla HTML/JS for UI

### Notes
- Database file `quiz.db` is created automatically with 3 seeded questions.
- Dashboard auto-refreshes every 2 seconds to reflect new submissions.

### Deploy to Render
1. Push this repo to GitHub.
2. In Render, create a new Web Service from the repo.
3. Render will detect Node. Use:
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Add a Persistent Disk:
   - Name: `data`, Size: 1GB, Mount Path: `/var/data`
5. Add env var `DB_FILE=/var/data/quiz.db`.
6. Deploy; your app will be available at the Render URL.

