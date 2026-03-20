const router  = require('express').Router();
const { query, getClient } = require('../config/db');
const { authenticate, ownerOnly, ownerOrManager, markerOnly } = require('../middleware/auth');
const { uploadPhoto } = require('../config/cloudinary');

router.use(authenticate);

// ─── Helper: check if current time is within marking window ─────────────────
const checkMarkingWindow = (windowOpen, windowClose) => {
  const now   = new Date();
  const hhmm  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  return hhmm >= windowOpen && hhmm <= windowClose;
};

// ─── Helper: check if employee is within hub geofence ───────────────────────
const checkGeofence = (empLat, empLng, hubLat, hubLng, radiusM) => {
  if (!hubLat || !hubLng || !empLat || !empLng) return { inside: true, distance: null };
  const R  = 6371000; // Earth radius in metres
  const φ1 = empLat * Math.PI / 180;
  const φ2 = hubLat * Math.PI / 180;
  const Δφ = (hubLat - empLat) * Math.PI / 180;
  const Δλ = (hubLng - empLng) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return { inside: distance <= radiusM, distance: Math.round(distance) };
};

// ─── GET /api/attendance/today ── Today's attendance for a hub ───────────────
// Markers see their own hub. Owner/Manager can pass ?hub_id=
router.get('/today', async (req, res) => {
  try {
    let hub_id = req.query.hub_id;

    if (req.user.role === 'marker') {
      const { rows } = await query(
        'SELECT hub_id FROM markers_hubs WHERE marker_id = $1',
        [req.user.user_id]
      );
      if (!rows.length) return res.status(403).json({ error: 'No hub assigned to this marker' });
      hub_id = rows[0].hub_id;
    }

    if (!hub_id) return res.status(400).json({ error: 'hub_id is required' });

    // Get hub info (for window times)
    const { rows: hubRows } = await query(
      'SELECT * FROM hubs WHERE hub_id = $1',
      [hub_id]
    );
    if (!hubRows.length) return res.status(404).json({ error: 'Hub not found' });
    const hub = hubRows[0];

    const windowOpen   = hub.marking_window_open.slice(0, 5);
    const windowClose  = hub.marking_window_close.slice(0, 5);
    const windowIsOpen = checkMarkingWindow(windowOpen, windowClose);

    // Get all active office employees for this hub with today's record
    const { rows: employees } = await query(
      `SELECT e.emp_id, e.employee_code, e.full_name,
              ar.record_id, ar.status, ar.marked_at, ar.reason_code, ar.reason_text,
              ar.is_outside_geofence, ar.is_low_accuracy
       FROM employees e
       LEFT JOIN attendance_records ar
         ON ar.emp_id = e.emp_id AND ar.attendance_date = CURRENT_DATE
       WHERE e.hub_id = $1 AND e.emp_type = 'office' AND e.is_active = TRUE
       ORDER BY e.full_name`,
      [hub_id]
    );

    return res.json({
      hub_id, hub_name: hub.hub_name,
      window_open:    windowOpen,
      window_close:   windowClose,
      window_is_open: windowIsOpen,
      date: new Date().toISOString().split('T')[0],
      employees,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/attendance/mark ── Mark an employee ───────────────────────────
// Markers use this. Status: present | late | absent
router.post('/mark', authenticate, async (req, res) => {
  if (!['marker', 'owner', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not authorised to mark attendance' });
  }

  const client = await getClient();
  try {
    const {
      emp_id, status,
      reason_code, reason_text,
      latitude, longitude, gps_accuracy_m, location_address,
      photo_base64,
    } = req.body;

    if (!emp_id || !status) {
      return res.status(400).json({ error: 'emp_id and status are required' });
    }
    if (!['present', 'late', 'absent'].includes(status)) {
      return res.status(400).json({ error: 'status must be present, late, or absent' });
    }

    // Get employee and their hub
    const { rows: empRows } = await client.query(
      `SELECT e.*, h.marking_window_open, h.marking_window_close,
              h.geofence_radius, h.latitude AS hub_lat, h.longitude AS hub_lng
       FROM employees e
       JOIN hubs h ON h.hub_id = e.hub_id
       WHERE e.emp_id = $1 AND e.is_active = TRUE`,
      [emp_id]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = empRows[0];

    if (emp.emp_type !== 'office') {
      return res.status(400).json({ error: 'Only office employees are marked via this endpoint' });
    }

    // For markers — enforce they only mark their own hub's employees
    if (req.user.role === 'marker') {
      const { rows: mhRows } = await client.query(
        'SELECT hub_id FROM markers_hubs WHERE marker_id = $1',
        [req.user.user_id]
      );
      if (!mhRows.length || mhRows[0].hub_id !== emp.hub_id) {
        return res.status(403).json({ error: 'You can only mark employees in your assigned hub' });
      }
    }

    const windowOpen  = emp.marking_window_open.slice(0, 5);
    const windowClose = emp.marking_window_close.slice(0, 5);
    const inWindow    = checkMarkingWindow(windowOpen, windowClose);

    // After window — Present is not allowed
    if (!inWindow && status === 'present') {
      return res.status(400).json({
        error: 'Marking window is closed. Only Late or Absent can be marked now.'
      });
    }

    // After window — reason is mandatory for Late or Absent
    if (!inWindow && (status === 'late' || status === 'absent')) {
      if (!reason_code) {
        return res.status(400).json({
          error: 'A reason is required when marking Late or Absent after the window closes.'
        });
      }
    }

    // GPS geofence check
    let isOutsideGeo = false;
    let isLowAccuracy = false;
    if (latitude && longitude) {
      const geo = checkGeofence(
        parseFloat(latitude), parseFloat(longitude),
        parseFloat(emp.hub_lat), parseFloat(emp.hub_lng),
        emp.geofence_radius
      );
      isOutsideGeo  = !geo.inside;
      isLowAccuracy = gps_accuracy_m && parseFloat(gps_accuracy_m) > parseFloat(process.env.GPS_LOW_ACCURACY_THRESHOLD_M || 500);
    }

    // Upload photo if provided
    let photo_url      = null;
    let photo_taken_at = null;
    if (photo_base64) {
      const uploaded  = await uploadPhoto(photo_base64, 'attendance-photos');
      photo_url       = uploaded.url;
      photo_taken_at  = new Date();
    }

    await client.query('BEGIN');

    // Upsert attendance record (one per employee per day)
    const { rows } = await client.query(
      `INSERT INTO attendance_records (
         emp_id, hub_id, attendance_date, status, marked_at, marked_by,
         reason_code, reason_text, reason_given_by,
         latitude, longitude, gps_accuracy_m, location_address,
         is_outside_geofence, is_low_accuracy,
         photo_url, photo_taken_at
       ) VALUES ($1,$2,CURRENT_DATE,$3,NOW(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (emp_id, attendance_date) DO UPDATE SET
         status           = $3,
         marked_at        = NOW(),
         marked_by        = $4,
         reason_code      = $5,
         reason_text      = $6,
         reason_given_by  = $7,
         latitude         = $8,
         longitude        = $9,
         gps_accuracy_m   = $10,
         location_address = $11,
         is_outside_geofence = $12,
         is_low_accuracy  = $13,
         photo_url        = COALESCE($14, attendance_records.photo_url),
         photo_taken_at   = COALESCE($15, attendance_records.photo_taken_at)
       RETURNING *`,
      [
        emp_id, emp.hub_id, status, req.user.user_id,
        reason_code || null, reason_text || null,
        reason_code ? req.user.user_id : null,
        latitude || null, longitude || null,
        gps_accuracy_m || null, location_address || null,
        isOutsideGeo, isLowAccuracy,
        photo_url, photo_taken_at,
      ]
    );

    await client.query('COMMIT');
    return res.json({
      record:             rows[0],
      flagged_geofence:   isOutsideGeo,
      flagged_accuracy:   isLowAccuracy,
      message:            `Attendance marked as ${status}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── GET /api/attendance/employee/:emp_id ── Full attendance history ─────────
router.get('/employee/:emp_id', ownerOrManager, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const { rows } = await query(
      `SELECT ar.*, u.full_name AS marked_by_name
       FROM attendance_records ar
       LEFT JOIN users u ON u.user_id = ar.marked_by
       WHERE ar.emp_id = $1
         AND ar.attendance_date >= COALESCE($2::date, ar.attendance_date - INTERVAL '90 days')
         AND ar.attendance_date <= COALESCE($3::date, CURRENT_DATE)
       ORDER BY ar.attendance_date DESC`,
      [req.params.emp_id, from_date || null, to_date || null]
    );
    return res.json({ records: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/attendance/summary ── Hub-wise daily summary ───────────────────
router.get('/summary', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM v_today_attendance');
    return res.json({ summary: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/attendance/flagged ── All flagged records ──────────────────────
router.get('/flagged', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ar.*, e.full_name, e.employee_code, h.hub_name
       FROM attendance_records ar
       JOIN employees e ON e.emp_id = ar.emp_id
       JOIN hubs h ON h.hub_id = ar.hub_id
       WHERE ar.is_outside_geofence = TRUE OR ar.is_low_accuracy = TRUE
       ORDER BY ar.attendance_date DESC, ar.marked_at DESC
       LIMIT 100`
    );
    return res.json({ flagged: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
