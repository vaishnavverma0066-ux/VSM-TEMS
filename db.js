const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate, ownerOnly } = require('../middleware/auth');

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { rows } = await query(
      'SELECT * FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been deactivated. Contact the owner.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update last login
    await query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]);

    const token = jwt.sign(
      { user_id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // For markers — fetch their assigned hub
    let hubInfo = null;
    if (user.role === 'marker') {
      const hubRes = await query(
        `SELECT h.hub_id, h.hub_name, h.marking_window_open, h.marking_window_close
         FROM markers_hubs mh
         JOIN hubs h ON h.hub_id = mh.hub_id
         WHERE mh.marker_id = $1`,
        [user.user_id]
      );
      hubInfo = hubRes.rows[0] || null;
    }

    // For supervisors — fetch their employee record and hub
    let empInfo = null;
    if (user.role === 'supervisor') {
      const empRes = await query(
        `SELECT e.emp_id, e.employee_code, e.full_name, e.hub_id, h.hub_name,
                ts.shift_start, ts.shift_end, ts.min_duty_hours, ts.max_duty_hours
         FROM employees e
         JOIN hubs h ON h.hub_id = e.hub_id
         LEFT JOIN time_schemes ts ON ts.emp_id = e.emp_id
         WHERE e.user_id = $1`,
        [user.user_id]
      );
      empInfo = empRes.rows[0] || null;
    }

    return res.json({
      token,
      user: {
        user_id:   user.user_id,
        username:  user.username,
        full_name: user.full_name,
        role:      user.role,
      },
      hub:      hubInfo,
      employee: empInfo,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

// ─── POST /api/auth/change-password ─────────────────────────────────────────
// Any authenticated user can change their own password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const { rows } = await query(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [req.user.user_id]
    );

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
      [newHash, req.user.user_id]
    );

    return res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/auth/reset-password ─── Owner only ───────────────────────────
// Owner resets anyone's password
router.post('/reset-password', authenticate, ownerOnly, async (req, res) => {
  try {
    const { user_id, new_password } = req.body;

    if (!user_id || !new_password) {
      return res.status(400).json({ error: 'user_id and new_password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    const result = await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2 RETURNING user_id',
      [newHash, user_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  return res.json({ user: req.user });
});

module.exports = router;
