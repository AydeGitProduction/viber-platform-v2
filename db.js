'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data.sqlite');

let db = null;

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function insert(sql, params) {
  db.run(sql, params);
  const r = db.exec('SELECT last_insert_rowid() AS id');
  const id = r[0]?.values[0][0] ?? null;
  save();
  return id;
}

function run(sql, params) {
  db.run(sql, params);
  save();
}

function query(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params) {
  const rows = query(sql, params);
  return rows[0] || null;
}

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      tags TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      message_template TEXT NOT NULL,
      total_contacts INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      delivered INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      opened INTEGER DEFAULT 0,
      clicked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      status TEXT DEFAULT 'pending',
      sent_at TEXT,
      delivered_at TEXT,
      error_message TEXT
    )
  `);

  // Seed settings
  const existingSettings = query('SELECT key FROM settings WHERE key IN (?, ?)', ['viber_service_id', 'viber_auth_token']);
  if (existingSettings.length === 0) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('viber_service_id', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('viber_auth_token', '')`);
  }

  // Seed contacts
  const contactCount = queryOne('SELECT COUNT(*) as cnt FROM contacts');
  if (!contactCount || contactCount.cnt === 0) {
    const contacts = [
      ['Alice Johnson', '+14155551001', 'alice@example.com', 'vip,lead'],
      ['Bob Smith', '+14155551002', 'bob@example.com', 'lead'],
      ['Carol White', '+14155551003', 'carol@example.com', 'customer'],
      ['David Lee', '+14155551004', 'david@example.com', 'vip'],
      ['Eva Martinez', '+14155551005', 'eva@example.com', 'prospect'],
    ];
    for (const [name, phone, email, tags] of contacts) {
      db.run(`INSERT INTO contacts (name, phone, email, tags) VALUES (?, ?, ?, ?)`, [name, phone, email, tags]);
    }
  }

  // Seed campaigns
  const campaignCount = queryOne('SELECT COUNT(*) as cnt FROM campaigns');
  if (!campaignCount || campaignCount.cnt === 0) {
    db.run(`INSERT INTO campaigns (name, description, status, message_template, total_contacts, sent, delivered, failed, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Summer Sale 2024', 'Promotional campaign for summer discounts', 'draft', 'Hi {name}, check out our summer deals!', 0, 0, 0, 0, 0]);

    db.run(`INSERT INTO campaigns (name, description, status, message_template, total_contacts, sent, delivered, failed, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Product Launch', 'Announcing new product launch', 'active', 'Hello {name}, our new product is here! Tap to explore.', 2, 2, 1, 0, 1]);

    db.run(`INSERT INTO campaigns (name, description, status, message_template, total_contacts, sent, delivered, failed, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['Welcome Series', 'Onboarding messages for new users', 'completed', 'Welcome {name}! We are excited to have you on board.', 5, 5, 4, 1, 3]);
  }

  // Seed campaign_contacts for campaign 2 (active)
  const ccCount = queryOne('SELECT COUNT(*) as cnt FROM campaign_contacts');
  if (!ccCount || ccCount.cnt === 0) {
    const campaigns2 = queryOne('SELECT id FROM campaigns WHERE name=?', ['Product Launch']);
    const contact1 = queryOne('SELECT id FROM contacts WHERE name=?', ['Alice Johnson']);
    const contact2 = queryOne('SELECT id FROM contacts WHERE name=?', ['Bob Smith']);
    if (campaigns2 && contact1) {
      db.run(`INSERT INTO campaign_contacts (campaign_id, contact_id, status, sent_at, delivered_at) VALUES (?, ?, ?, ?, ?)`,
        [campaigns2.id, contact1.id, 'delivered', datetime(), datetime()]);
    }
    if (campaigns2 && contact2) {
      db.run(`INSERT INTO campaign_contacts (campaign_id, contact_id, status, sent_at) VALUES (?, ?, ?, ?)`,
        [campaigns2.id, contact2.id, 'sent', datetime()]);
    }
  }

  save();
  console.log('Database initialized');
}

function datetime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = { init, insert, run, query, queryOne, save, datetime };
