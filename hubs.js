const router = require('express').Router();
const { query } = require('../config/db');
const { authenticate, ownerOnly, ownerOrManager } = require('../middleware/auth');

router.use(authenticate);

// ─── GET /api/hubs ── List all hubs ─────────────────────────────────────────
router.get('/', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT h.*,
             COUNT(e.emp_id) FILTER (WHERE e.is_active = true) AS employee_count
      FROM hubs h
      LEFT JOIN employees e ON e.hub_id = h.hub_id
      WHERE h.is_active = true
      GROUP BY h.hub_id
      ORDER BY h.hub_name
    `);
    return res.json({ hubs: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/hubs/:hub_id ── Single hub with employees and marker ───────────
router.get('/:hub_id', ownerOrManager, async (req, res) => {
  try {
    const { rows: hubRows } = await query(
      'SELECT * FROM hubs WHERE hub_id = $1',
      [req.params.hub_id]
    );
    if (!hubRows.length) return res.status(404).json({ error: 'Hub not found' });

    const { rows: employees } = await query(
      `SELECT emp_id, employee_code, full_name, emp_type, is_active
       FROM employees WHERE hub_id = $1 ORDER BY full_name`,
      [req.params.hub_id]
    );

    const { rows: markerRows } = await query(
      `SELECT u.user_id, u.full_name, u.username
       FROM markers_hubs mh
       JOIN users u ON u.user_id = mh.marker_id
       WHERE mh.hub_id = $1`,
      [req.params.hub_id]
    );

    return res.json({
      hub:      hubRows[0],
      employees,
      markers:  markerRows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/hubs ── Create new hub — Owner only ──────────────────────────
router.post('/', ownerOnly, async (req, res) => {
  try {
    const {
      hub_name, hub_type, address, latitude, longitude, geofence_radius,
      default_shift_start, default_shift_end, default_grace_mins,
      default_working_days, marking_window_open, marking_window_close
    } = req.body;

    if (!hub_name || !hub_type) {
      return res.status(400).json({ error: 'hub_name and hub_type are required' });
    }

    const { rows } = await query(
      `INSERT INTO hubs (
         hub_name, hub_type, address, latitude, longitude, geofence_radius,
         default_shift_start, default_shift_end, default_grace_mins,
         default_working_days, marking_window_open, marking_window_close
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        hub_name, hub_type, address || null,
        latitude || null, longitude || null,
        geofence_radius || 200,
        default_shift_start || '09:00',
        default_shift_end   || '18:00',
        default_grace_mins  || 15,
        default_working_days || 'mon-sat',
        marking_window_open  || '08:00',
        marking_window_close || '10:30',
      ]
    );

    return res.status(201).json({ hub: rows[0], message: 'Hub created' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /api/hubs/:hub_id ── Update hub — Owner only ─────────────────────
router.patch('/:hub_id', ownerOnly, async (req, res) => {
  try {
    const fields = [
      'hub_name', 'hub_type', 'address', 'latitude', 'longitude',
      'geofence_radius', 'default_shift_start', 'default_shift_end',
      'default_grace_mins', 'default_working_days',
      'marking_window_open', 'marking_window_close', 'is_active'
    ];

    const updates = [];
    const values  = [];
    let   idx     = 1;

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        values.push(req.body[f]);
      }
    });

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.params.hub_id);

    const { rows } = await query(
      `UPDATE hubs SET ${updates.join(', ')} WHERE hub_id = $${idx} RETURNING *`,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'Hub not found' });
    return res.json({ hub: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/hubs/:hub_id/assign-marker ── Owner only ─────────────────────
router.post('/:hub_id/assign-marker', ownerOnly, async (req, res) => {
  try {
    const { marker_id } = req.body;
    if (!marker_id) return res.status(400).json({ error: 'marker_id required' });

    // Confirm user is a marker
    const { rows: userRows } = await query(
      'SELECT role FROM users WHERE user_id = $1',
      [marker_id]
    );
    if (!userRows.length || userRows[0].role !== 'marker') {
      return res.status(400).json({ error: 'User is not a marker' });
    }

    // Upsert — marker can only have one hub (UNIQUE on marker_id)
    const { rows } = await query(
      `INSERT INTO markers_hubs (marker_id, hub_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (marker_id)
       DO UPDATE SET hub_id = $2, assigned_by = $3, assigned_at = NOW()
       RETURNING *`,
      [marker_id, req.params.hub_id, req.user.user_id]
    );

    return res.json({ assignment: rows[0], message: 'Marker assigned to hub' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
