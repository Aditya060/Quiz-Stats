## Quiz-Stats

Interactive, real-time quiz + Q&A for events. Built with Node.js, Express, Socket.IO, and SQLite (persistent disk). Includes:
- Participant quiz (phone)
- LED-wall live dashboard (poll)
- Admin (start/next/end, mark correct, reveal toggle)
- Q&A submit (audience), Q&A admin (highlight/reject), Q&A display (overlay)

### Run locally

```bash
npm install
npm run dev
# Server: http://localhost:3000
# Quiz: http://localhost:3000/
# Dashboard: http://localhost:3000/dashboard
# Admin (poll): http://localhost:3000/admin.html
# Q&A submit: http://localhost:3000/qna.html
# Q&A admin: http://localhost:3000/qna-admin.html
# Q&A display: http://localhost:3000/qna-display.html
```

### Tech
- Express 5 for HTTP + static hosting
- Socket.IO for realtime broadcasts (state/stats/qna)
- better-sqlite3 (WAL) for embedded DB on persistent disk
- Vanilla HTML/CSS/JS (glassmorphic UI)
- `qrcode` for dynamic Q&A QR page

### Notes
- Database uses a Persistent Disk. Set `DB_FILE=/var/data/quiz.db`. Without it (or on `/tmp`) data is ephemeral.
- Seeded questions are recreated when `seed_version` changes in `server.js` (clears questions/options/responses).
- Per-device vote lock enforced via `responses(device_id, question_id)` unique index; a device can reset its vote.
- Admin can mark a correct option and toggle reveal; dashboard only highlights when reveal is on.

### Deploy to Render
1. Push this repo to GitHub.
2. In Render, create a new Web Service from the repo.
3. Render will detect Node. Use:
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Add a Persistent Disk:
   - Name: `data`, Size: 1GB, Mount Path: `/var/data`
5. Add env var `DB_FILE=/var/data/quiz.db`.
6. (Optional) Autoscaling: multiple instances are fine for reads; writes are serialized by SQLite. For 1000+ rps voting, migrate to Postgres + Redis.
7. Deploy; your app will be available at the Render URL.

### Stress testing (quick)
- Lightweight: `npx autocannon -d 30 -c 50 https://<service>/api/stats?questionId=1`
- Votes (k6): simulate deviceId and post to `/api/vote` (see `k6-votes.js` snippet in docs or conversation).

