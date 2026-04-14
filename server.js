'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Stats ───────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  try {
    const totalContacts = db.queryOne('SELECT COUNT(*) as cnt FROM contacts WHERE status=?', ['active']);
    const totalCampaigns = db.queryOne('SELECT COUNT(*) as cnt FROM campaigns');
    const sentRow = db.queryOne('SELECT SUM(sent) as total FROM campaigns');
    const deliveredRow = db.queryOne('SELECT SUM(delivered) as total FROM campaigns');

    const sent = sentRow?.total || 0;
    const delivered = deliveredRow?.total || 0;
    const deliveryRate = sent > 0 ? Math.round((delivered / sent) * 100) : 0;

    res.json({
      total_contacts: totalContacts?.cnt || 0,
      total_campaigns: totalCampaigns?.cnt || 0,
      messages_sent: sent,
      messages_delivered: delivered,
      delivery_rate: deliveryRate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  try {
    const rows = db.query('SELECT key, value FROM settings');
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const { viber_service_id, viber_auth_token } = req.body;
    const now = db.datetime();
    if (viber_service_id !== undefined) {
      db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('viber_service_id', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [viber_service_id, now]);
    }
    if (viber_auth_token !== undefined) {
      db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('viber_auth_token', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [viber_auth_token, now]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/test', async (req, res) => {
  try {
    const settings = db.query('SELECT key, value FROM settings');
    const cfg = {};
    for (const row of settings) cfg[row.key] = row.value;

    if (!cfg.viber_auth_token) {
      return res.status(400).json({ error: 'Viber Auth Token not configured' });
    }

    const response = await fetch('https://chatapi.viber.com/pa/get_account_info', {
      method: 'POST',
      headers: {
        'X-Viber-Auth-Token': cfg.viber_auth_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (data.status === 0) {
      res.json({ success: true, name: data.name });
    } else {
      res.status(400).json({ error: data.status_message || 'Connection failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Contacts ─────────────────────────────────────────────────────────────────

app.get('/api/contacts', (req, res) => {
  try {
    const contacts = db.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts', (req, res) => {
  try {
    const { name, phone, email, tags } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
    const id = db.insert(
      'INSERT INTO contacts (name, phone, email, tags) VALUES (?, ?, ?, ?)',
      [name, phone, email || null, tags || null]
    );
    const contact = db.queryOne('SELECT * FROM contacts WHERE id=?', [id]);
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id', (req, res) => {
  try {
    const { name, phone, email, tags, status } = req.body;
    const existing = db.queryOne('SELECT * FROM contacts WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    db.run(
      'UPDATE contacts SET name=?, phone=?, email=?, tags=?, status=? WHERE id=?',
      [name || existing.name, phone || existing.phone, email ?? existing.email, tags ?? existing.tags, status || existing.status, req.params.id]
    );
    const updated = db.queryOne('SELECT * FROM contacts WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:id', (req, res) => {
  try {
    const existing = db.queryOne('SELECT * FROM contacts WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    db.run('DELETE FROM contacts WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const content = req.file.buffer.toString('utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header and data rows' });

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const nameIdx = headers.indexOf('name');
    const phoneIdx = headers.indexOf('phone');
    const emailIdx = headers.indexOf('email');
    const tagsIdx = headers.indexOf('tags');

    if (nameIdx === -1 || phoneIdx === -1) {
      return res.status(400).json({ error: 'CSV must have name and phone columns' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const name = cols[nameIdx];
      const phone = cols[phoneIdx];
      if (!name || !phone) { skipped++; continue; }

      try {
        db.insert('INSERT INTO contacts (name, phone, email, tags) VALUES (?, ?, ?, ?)', [
          name,
          phone,
          emailIdx !== -1 ? (cols[emailIdx] || null) : null,
          tagsIdx !== -1 ? (cols[tagsIdx] || null) : null,
        ]);
        imported++;
      } catch (e) {
        errors.push(`Row ${i + 1}: ${e.message}`);
        skipped++;
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

app.get('/api/campaigns', (req, res) => {
  try {
    const campaigns = db.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', (req, res) => {
  try {
    const { name, description, message_template } = req.body;
    if (!name || !message_template) return res.status(400).json({ error: 'name and message_template are required' });
    const now = db.datetime();
    const id = db.insert(
      'INSERT INTO campaigns (name, description, message_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [name, description || null, message_template, now, now]
    );
    const campaign = db.queryOne('SELECT * FROM campaigns WHERE id=?', [id]);
    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:id', (req, res) => {
  try {
    const existing = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    const { name, description, message_template, status } = req.body;
    const now = db.datetime();
    db.run(
      'UPDATE campaigns SET name=?, description=?, message_template=?, status=?, updated_at=? WHERE id=?',
      [name || existing.name, description ?? existing.description, message_template || existing.message_template, status || existing.status, now, req.params.id]
    );
    const updated = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', (req, res) => {
  try {
    const existing = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Campaign not found' });
    db.run('DELETE FROM campaign_contacts WHERE campaign_id=?', [req.params.id]);
    db.run('DELETE FROM campaigns WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/contacts', (req, res) => {
  try {
    const rows = db.query(`
      SELECT cc.id as cc_id, cc.status as cc_status, cc.sent_at, cc.delivered_at, cc.error_message,
             c.id, c.name, c.phone, c.email, c.tags
      FROM campaign_contacts cc
      JOIN contacts c ON cc.contact_id = c.id
      WHERE cc.campaign_id=?
      ORDER BY cc.id
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/contacts', (req, res) => {
  try {
    const { contact_id } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });

    const existing = db.queryOne('SELECT id FROM campaign_contacts WHERE campaign_id=? AND contact_id=?', [req.params.id, contact_id]);
    if (existing) return res.status(409).json({ error: 'Contact already in campaign' });

    const id = db.insert('INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES (?, ?)', [req.params.id, contact_id]);

    // Update total_contacts
    const cnt = db.queryOne('SELECT COUNT(*) as cnt FROM campaign_contacts WHERE campaign_id=?', [req.params.id]);
    db.run('UPDATE campaigns SET total_contacts=?, updated_at=? WHERE id=?', [cnt?.cnt || 0, db.datetime(), req.params.id]);

    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id/contacts/:contactId', (req, res) => {
  try {
    db.run('DELETE FROM campaign_contacts WHERE campaign_id=? AND contact_id=?', [req.params.id, req.params.contactId]);
    const cnt = db.queryOne('SELECT COUNT(*) as cnt FROM campaign_contacts WHERE campaign_id=?', [req.params.id]);
    db.run('UPDATE campaigns SET total_contacts=?, updated_at=? WHERE id=?', [cnt?.cnt || 0, db.datetime(), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/send', async (req, res) => {
  try {
    const campaign = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const settings = db.query('SELECT key, value FROM settings');
    const cfg = {};
    for (const row of settings) cfg[row.key] = row.value;

    if (!cfg.viber_service_id || !cfg.viber_auth_token) {
      return res.status(400).json({ error: 'Viber API credentials not configured. Go to Settings.' });
    }

    const pendingContacts = db.query(`
      SELECT cc.id as cc_id, c.name, c.phone
      FROM campaign_contacts cc
      JOIN contacts c ON cc.contact_id = c.id
      WHERE cc.campaign_id=? AND cc.status='pending'
    `, [req.params.id]);

    let sent = 0;
    let failed = 0;

    for (const cc of pendingContacts) {
      try {
        const response = await fetch('https://chatapi.viber.com/pa/send_message', {
          method: 'POST',
          headers: {
            'X-Viber-Auth-Token': cfg.viber_auth_token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            receiver: cc.phone,
            min_api_version: 1,
            sender: { name: 'Outreach Platform' },
            tracking_data: `cc_${cc.cc_id}`,
            type: 'text',
            text: campaign.message_template.replace('{name}', cc.name),
          }),
        });
        const data = await response.json();
        const now = db.datetime();
        if (data.status_message === 'ok' || data.status === 0) {
          db.run('UPDATE campaign_contacts SET status=?, sent_at=? WHERE id=?', ['sent', now, cc.cc_id]);
          sent++;
        } else {
          db.run('UPDATE campaign_contacts SET status=?, error_message=? WHERE id=?', ['failed', data.status_message, cc.cc_id]);
          failed++;
        }
      } catch (e) {
        db.run('UPDATE campaign_contacts SET status=?, error_message=? WHERE id=?', ['failed', e.message, cc.cc_id]);
        failed++;
      }
    }

    const now = db.datetime();
    db.run(
      'UPDATE campaigns SET sent=sent+?, failed=failed+?, status=?, updated_at=? WHERE id=?',
      [sent, failed, 'active', now, req.params.id]
    );

    const updated = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    res.json({ sent, failed, campaign: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/analytics', (req, res) => {
  try {
    const campaign = db.queryOne('SELECT * FROM campaigns WHERE id=?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const statusCounts = db.query(`
      SELECT status, COUNT(*) as cnt
      FROM campaign_contacts
      WHERE campaign_id=?
      GROUP BY status
    `, [req.params.id]);

    const breakdown = {};
    for (const row of statusCounts) {
      breakdown[row.status] = row.cnt;
    }

    res.json({
      campaign,
      breakdown,
      total: campaign.total_contacts,
      sent: campaign.sent,
      delivered: campaign.delivered,
      failed: campaign.failed,
      opened: campaign.opened,
      clicked: campaign.clicked,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

app.post('/api/webhooks/viber', (req, res) => {
  try {
    const { event, tracking_data } = req.body;

    if (tracking_data && tracking_data.startsWith('cc_')) {
      const ccId = parseInt(tracking_data.replace('cc_', ''), 10);
      const now = db.datetime();

      if (event === 'delivered') {
        const cc = db.queryOne('SELECT * FROM campaign_contacts WHERE id=?', [ccId]);
        if (cc) {
          db.run('UPDATE campaign_contacts SET status=?, delivered_at=? WHERE id=?', ['delivered', now, ccId]);
          db.run('UPDATE campaigns SET delivered=delivered+1 WHERE id=?', [cc.campaign_id]);
        }
      } else if (event === 'seen') {
        const cc = db.queryOne('SELECT * FROM campaign_contacts WHERE id=?', [ccId]);
        if (cc) {
          db.run('UPDATE campaign_contacts SET status=? WHERE id=?', ['opened', ccId]);
          db.run('UPDATE campaigns SET opened=opened+1 WHERE id=?', [cc.campaign_id]);
        }
      }
    }

    res.json({ status: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3000;

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Viber Platform v2 running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
