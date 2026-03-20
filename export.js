const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// ─── Verify JWT token ────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm user still exists and is active
    const { rows } = await query(
      'SELECT user_id, username, role, full_name, is_active FROM users WHERE user_id = $1',
      [decoded.user_id]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ─── Role guard factory ──────────────────────────────────────────────────────
// Usage: requireRole('owner')  or  requireRole('owner', 'manager')
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      error: `Access denied. Required role: ${roles.join(' or ')}`
    });
  }
  next();
};

// ─── Shorthand role guards ───────────────────────────────────────────────────
const ownerOnly       = requireRole('owner');
const ownerOrManager  = requireRole('owner', 'manager');
const markerOnly      = requireRole('marker');
const supervisorOnly  = requireRole('supervisor');

module.exports = {
  authenticate,
  requireRole,
  ownerOnly,
  ownerOrManager,
  markerOnly,
  supervisorOnly,
};
