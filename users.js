const router = require('express').Router();
const bcrypt = require('bcrypt');
const { query } = require('../config/db');
const { authenticate, ownerOnly, ownerOrManager } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// ─── GET /api/users ── Owner sees all, Manager sees only supervisors ─────────
router.get('/', ownerOrManager, async (req, res) => {
  try {
    let sql = `
      SELECT user_id, username, role, full_name, phone, email,
             is_active, last_login, created_at
      FROM users
    `;
    const params = [];

    // Manager can only see supervisors they might manage
    if (req.user.role === 'manager') {
      sql += ' WHERE role = $1';
      params.push('supervisor');
    }

    sql += ' ORDER BY role, full_name';
    const { rows } = await query(sql, params);
    return res.json({ users: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/users ── Create a new login ───────────────────────────────────
// Owner can create any role
// Manager can only create supervisor logins
router.post('/', ownerOrManager, async (req, res) => {
  try {
    const { username, password, role, full_name, phone, email } = req.body;

    // Managers can only create supervisor accounts
    if (req.user.role === 'manager' && role !== 'supervisor') {
      return res.status(403).json({
        error: 'Managers can only create supervisor logins'
      });
    }

    // Validate role
    const validRoles = ['owner', 'manager', 'marker', 'supervisor'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!username || !password || !role || !full_name) {
      return res.status(400).json({ error: 'username, password, role, full_name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await query(
      `INSERT INTO users (username, password_hash, role, full_name, phone, email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING user_id, username, role, full_name, is_active, created_at`,
      [username.trim().toLowerCase(), passwordHash, role, full_name, phone || null, email || null, req.user.user_id]
    );

    return res.status(201).json({ user: rows[0], message: 'Login created successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /api/users/:user_id/status ── Activate / Deactivate ──────────────
router.patch('/:user_id/status', ownerOnly, async (req, res) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be true or false' });
    }

    // Prevent owner from deactivating themselves
    if (req.params.user_id === req.user.user_id && !is_active) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const { rows } = await query(
      `UPDATE users SET is_active = $1, updated_at = NOW()
       WHERE user_id = $2
       RETURNING user_id, username, role, full_name, is_active`,
      [is_active, req.params.user_id]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: rows[0], message: `Account ${is_active ? 'activated' : 'deactivated'}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /api/users/:user_id ── Edit user details ─────────────────────────
router.patch('/:user_id', ownerOnly, async (req, res) => {
  try {
    const { full_name, phone, email, username } = req.body;

    const { rows } = await query(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           phone     = COALESCE($2, phone),
           email     = COALESCE($3, email),
           username  = COALESCE($4, username),
           updated_at = NOW()
       WHERE user_id = $5
       RETURNING user_id, username, role, full_name, phone, email, is_active`,
      [full_name, phone, email, username, req.params.user_id]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
