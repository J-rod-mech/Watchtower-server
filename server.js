const http = require('http');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;

// Create/open SQLite DB
const db = new Database('app.db');

// Create table
db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`).run();

// Helper function
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',

    // CORS
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  res.end(JSON.stringify(data));
}

// Create server
const server = http.createServer((req, res) => {

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    return res.end();
  }

  // GET /messages
  if (req.method === 'GET' && req.url === '/messages') {

    const rows = db.prepare(`
      SELECT * FROM messages
      ORDER BY id DESC
    `).all();

    return sendJson(res, 200, rows);
  }

  // POST /messages
  if (req.method === 'POST' && req.url === '/messages') {

    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {

      try {

        const data = JSON.parse(body);

        if (!data.text) {
          return sendJson(res, 400, {
            error: 'Text is required'
          });
        }

        const stmt = db.prepare(`
          INSERT INTO messages (text, created_at)
          VALUES (?, ?)
        `);

        const result = stmt.run(
          data.text,
          new Date().toISOString()
        );

        return sendJson(res, 200, {
          success: true,
          id: result.lastInsertRowid
        });

      } catch (err) {

        return sendJson(res, 400, {
          error: 'Invalid JSON'
        });
      }
    });

    return;
  }

  // 404
  sendJson(res, 404, {
    error: 'Route not found'
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});