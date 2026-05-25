const http = require('http');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const MAX_EVENTS = 10000;

const db = new Database('app.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    session_id TEXT,
    user_id TEXT,
    deploy_version TEXT,
    app_name TEXT,
    event_url TEXT,
    route TEXT,
    data_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  )
`).run();

db.prepare('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_events_deploy_version ON events(deploy_version)').run();
db.prepare('CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at)').run();

const insertEventStmt = db.prepare(`
  INSERT INTO events (
    type, timestamp, session_id, user_id, deploy_version, app_name,
    event_url, route, data_json, received_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const deleteOverflowStmt = db.prepare(`
  DELETE FROM events
  WHERE id IN (
    SELECT id FROM events
    ORDER BY id ASC
    LIMIT ?
  )
`);

const countEventsStmt = db.prepare('SELECT COUNT(*) AS count FROM events');

/**
 * Sends a JSON response with standard CORS headers.
 * @param {import('http').ServerResponse} res - HTTP response object.
 * @param {number} status - HTTP status code.
 * @param {unknown} data - JSON-serializable response payload.
 * @returns {void}
 */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  res.end(JSON.stringify(data));
}

/**
 * Parses the request body as JSON.
 * @param {import('http').IncomingMessage} req - HTTP request object.
 * @returns {Promise<unknown>} Parsed JSON payload.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Checks whether a value is a plain object (not null, not array).
 * @param {unknown} value - Value to inspect.
 * @returns {boolean}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a non-empty string after trimming.
 * @param {unknown} value - Value to inspect.
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates that a value is a parseable timestamp string.
 * @param {unknown} value - Candidate timestamp.
 * @returns {boolean}
 */
function isValidTimestamp(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

/**
 * Validates optional context fields on an event envelope.
 * @param {Record<string, unknown>} event - Event object to validate.
 * @returns {string|null} Error message on failure, otherwise null.
 */
function validateOptionalContext(event) {
  if (event.sessionId !== undefined && typeof event.sessionId !== 'string') {
    return 'sessionId must be a string when provided';
  }

  if (event.userId !== undefined && event.userId !== null && typeof event.userId !== 'string') {
    return 'userId must be a string or null when provided';
  }

  if (event.deployVersion !== undefined && typeof event.deployVersion !== 'string') {
    return 'deployVersion must be a string when provided';
  }

  if (event.appName !== undefined && typeof event.appName !== 'string') {
    return 'appName must be a string when provided';
  }

  if (event.url !== undefined && typeof event.url !== 'string') {
    return 'url must be a string when provided';
  }

  if (event.route !== undefined && typeof event.route !== 'string') {
    return 'route must be a string when provided';
  }

  return null;
}

/**
 * Validates required event envelope fields and optional context fields.
 * @param {unknown} event - Event payload to validate.
 * @returns {string|null} Error message on failure, otherwise null.
 */
function validateEvent(event) {
  if (!isObject(event)) {
    return 'Event must be a non-null object';
  }

  if (!isNonEmptyString(event.type)) {
    return 'type is required and must be a non-empty string';
  }

  if (!isValidTimestamp(event.timestamp)) {
    return 'timestamp is required and must be a valid ISO-8601 string';
  }

  if (!isObject(event.data)) {
    return 'data is required and must be a non-null object';
  }

  return validateOptionalContext(event);
}

/**
 * Maps a database row into API event shape.
 * @param {{
 *   type: string,
 *   timestamp: string,
 *   session_id: string|null,
 *   user_id: string|null,
 *   deploy_version: string|null,
 *   app_name: string|null,
 *   event_url: string|null,
 *   route: string|null,
 *   data_json: string,
 *   received_at: string
 * }} row - Row fetched from the events table.
 * @returns {{
 *   type: string,
 *   timestamp: string,
 *   sessionId: string|null,
 *   userId: string|null,
 *   deployVersion: string|null,
 *   appName: string|null,
 *   url: string|null,
 *   route: string|null,
 *   data: Record<string, unknown>,
 *   receivedAt: string
 * }}
 */
function rowToEvent(row) {
  return {
    type: row.type,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    userId: row.user_id,
    deployVersion: row.deploy_version,
    appName: row.app_name,
    url: row.event_url,
    route: row.route,
    data: JSON.parse(row.data_json),
    receivedAt: row.received_at
  };
}

/**
 * Enforces the configured event cap by removing oldest rows first.
 * @returns {void}
 */
function pruneIfNeeded() {
  const total = countEventsStmt.get().count;

  if (total > MAX_EVENTS) {
    deleteOverflowStmt.run(total - MAX_EVENTS);
  }
}

/**
 * Computes a percentile value from an ascending-sorted numeric array.
 * @param {number[]} sortedValues - Values sorted ascending.
 * @param {number} p - Percentile in range [0, 100].
 * @returns {number}
 */
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const index = Math.min(Math.max(rank, 0), sortedValues.length - 1);
  return sortedValues[index];
}

/**
 * Parses a positive integer query value with fallback.
 * @param {string|null} value - Raw query parameter value.
 * @param {number} fallback - Default value if parse fails.
 * @returns {number}
 */
function parseLimit(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
}

/**
 * Main HTTP request handler for the WatchTower event API.
 * @param {import('http').IncomingMessage} req - HTTP request object.
 * @param {import('http').ServerResponse} res - HTTP response object.
 * @returns {Promise<void>}
 */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = requestUrl.pathname;

  if (req.method === 'POST' && path === '/api/events') {
    try {
      const payload = await parseBody(req);
      const events = Array.isArray(payload?.events) ? payload.events : [payload];

      if (events.length === 0) {
        return sendJson(res, 400, { error: 'events array must not be empty' });
      }

      for (let i = 0; i < events.length; i += 1) {
        const err = validateEvent(events[i]);
        if (err) {
          return sendJson(res, 400, {
            error: `Invalid event at index ${i}: ${err}`
          });
        }
      }

      const receivedAt = new Date().toISOString();

      for (const event of events) {
        insertEventStmt.run(
          event.type,
          event.timestamp,
          event.sessionId ?? null,
          event.userId ?? null,
          event.deployVersion ?? null,
          event.appName ?? null,
          event.url ?? null,
          event.route ?? null,
          JSON.stringify(event.data),
          receivedAt
        );
      }

      pruneIfNeeded();
      return sendJson(res, 200, { accepted: events.length });
    } catch (err) {
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (req.method === 'GET' && path === '/api/events') {
    const type = requestUrl.searchParams.get('type');
    const version = requestUrl.searchParams.get('version');
    const limit = parseLimit(requestUrl.searchParams.get('limit'), 100);

    const conditions = [];
    const params = [];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    if (version) {
      conditions.push('deploy_version = ?');
      params.push(version);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT * FROM events
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params, limit);

    return sendJson(res, 200, { events: rows.map(rowToEvent) });
  }

  if (req.method === 'GET' && path === '/api/stats') {
    const totalEvents = countEventsStmt.get().count;

    const activeUsersRows = db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS count
      FROM events
      WHERE session_id IS NOT NULL
      AND received_at >= ?
    `).get(new Date(Date.now() - 5 * 60 * 1000).toISOString());

    const errorsByVersionRows = db.prepare(`
      SELECT COALESCE(deploy_version, 'unknown') AS deploy_version, COUNT(*) AS count
      FROM events
      WHERE type = 'error'
      GROUP BY COALESCE(deploy_version, 'unknown')
    `).all();

    const recentErrorRows = db.prepare(`
      SELECT * FROM events
      WHERE type = 'error'
      ORDER BY id DESC
      LIMIT 50
    `).all();

    const pageloadRows = db.prepare(`
      SELECT route, timestamp, data_json
      FROM events
      WHERE type = 'pageload'
      ORDER BY id DESC
      LIMIT 5000
    `).all();

    const latencyByRoute = {};

    for (const row of pageloadRows) {
      const data = JSON.parse(row.data_json);
      const route = row.route || 'unknown';
      const duration = Number(data.duration);
      const ttfb = Number(data.ttfb);

      if (!Number.isFinite(duration)) {
        continue;
      }

      if (!latencyByRoute[route]) {
        latencyByRoute[route] = {
          durations: [],
          ttfbValues: [],
          points: []
        };
      }

      latencyByRoute[route].durations.push(duration);
      if (Number.isFinite(ttfb)) {
        latencyByRoute[route].ttfbValues.push(ttfb);
      }

      if (latencyByRoute[route].points.length < 100) {
        latencyByRoute[route].points.push({
          duration: Math.round(duration),
          ttfb: Number.isFinite(ttfb) ? Math.round(ttfb) : 0,
          timestamp: row.timestamp
        });
      }
    }

    const outputLatencyByRoute = {};

    for (const [route, values] of Object.entries(latencyByRoute)) {
      const sorted = [...values.durations].sort((a, b) => a - b);
      const avg = Math.round(values.durations.reduce((sum, d) => sum + d, 0) / values.durations.length);

      outputLatencyByRoute[route] = {
        count: values.durations.length,
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        avg,
        points: values.points
      };
    }

    const errorsByVersion = {};
    for (const row of errorsByVersionRows) {
      errorsByVersion[row.deploy_version] = row.count;
    }

    return sendJson(res, 200, {
      activeUsers: activeUsersRows.count,
      totalEvents,
      totalErrors: recentErrorRows.length,
      errorsByVersion,
      latencyByRoute: outputLatencyByRoute,
      recentErrors: recentErrorRows.map(rowToEvent)
    });
  }

  if (req.method === 'GET' && path === '/api/events/stream') {
    res.writeHead(501, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ error: 'SSE stream not implemented in this server build' }));
  }

  return sendJson(res, 404, { error: 'Route not found' });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
