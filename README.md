const router  = require('express').Router();
const { query, getClient } = require('../config/db');
const { authenticate, ownerOrManager, supervisorOnly } = require('../middleware/auth');
const { uploadPhoto } = require('../config/cloudinary');

router.use(authenticate);

// ─── Helper: generate a unique duty code ────────────────────────────────────
const generateDutyCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'DC-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

// ─── Helper: calculate hours between two timestamps ─────────────────────────
const calcHours = (start, end) => {
  const diff = (new Date(end) - new Date(start)) / (1000 * 60 * 60);
  return Math.round(diff * 100) / 100;
};

// ─── Helper: geofence check (same as attendance.js) ─────────────────────────
const checkGeofence = (empLat, empLng, hubLat, hubLng, radiusM) => {
  if (!hubLat || !hubLng || !empLat || !empLng) return { inside: true };
  const R  = 6371000;
  const φ1 = empLat * Math.PI / 180;
  const φ2 = hubLat * Math.PI / 180;
  const Δφ = (hubLat - empLat) * Math.PI / 180;
  const Δλ = (hubLng - empLng) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const d  = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return { inside: d <= radiusM, distance: Math.round(d) };
};

// ─── POST /api/duty/generate-code ── Supervisor requests a duty code ─────────
router.post('/generate-code', supervisorOnly, async (req, res) => {
  try {
    // Get supervisor's employee record
    const { rows: empRows } = await query(
      'SELECT emp_id FROM employees WHERE user_id = $1 AND is_active = TRUE',
      [req.user.user_id]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee record not found' });
    const emp_id = empRows[0].emp_id;

    // Check no active unused code exists
    const { rows: existing } = await query(
      `SELECT code_id FROM duty_codes
       WHERE emp_id = $1 AND is_used = FALSE AND expires_at > NOW()`,
      [emp_id]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'You already have an active duty code. Use it before generating a new one.' });
    }

    // Generate unique code
    let duty_code;
    let unique = false;
    while (!unique) {
      duty_code = generateDutyCode();
      const { rows: check } = await query(
        'SELECT code_id FROM duty_codes WHERE duty_code = $1',
        [duty_code]
      );
      unique = check.length === 0;
    }

    const expiryHours = parseInt(process.env.DUTY_CODE_EXPIRY_HOURS || '2');
    const { rows } = await query(
      `INSERT INTO duty_codes (duty_code, emp_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '${expiryHours} hours')
       RETURNING duty_code, expires_at`,
      [duty_code, emp_id]
    );

    return res.status(201).json({
      duty_code:  rows[0].duty_code,
      expires_at: rows[0].expires_at,
      message:    `Code valid for ${expiryHours} hours`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/duty/start ── Mark duty start with code + photo + GPS ─────────
router.post('/start', supervisorOnly, async (req, res) => {
  const client = await getClient();
  try {
    const {
      duty_code,
      photo_base64,
      latitude, longitude, gps_accuracy_m, location_address,
    } = req.body;

    if (!duty_code || !photo_base64) {
      return res.status(400).json({ error: 'duty_code and photo_base64 are required' });
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'GPS location is required to mark duty start' });
    }

    await client.query('BEGIN');

    // Validate duty code
    const { rows: codeRows } = await client.query(
      `SELECT dc.*, e.hub_id, e.emp_id,
              h.geofence_radius, h.latitude AS hub_lat, h.longitude AS hub_lng,
              ts.min_duty_hours, ts.max_duty_hours, ts.shift_start, ts.shift_end
       FROM duty_codes dc
       JOIN employees e ON e.emp_id = dc.emp_id
       JOIN hubs h ON h.hub_id = e.hub_id
       LEFT JOIN time_schemes ts ON ts.emp_id = e.emp_id
       WHERE dc.duty_code = $1 AND dc.is_used = FALSE AND dc.expires_at > NOW()`,
      [duty_code]
    );

    if (!codeRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid, expired, or already used duty code' });
    }

    const codeData = codeRows[0];

    // Confirm this code belongs to the logged-in supervisor
    const { rows: empRows } = await client.query(
      'SELECT emp_id FROM employees WHERE user_id = $1',
      [req.user.user_id]
    );
    if (!empRows.length || empRows[0].emp_id !== codeData.emp_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This duty code does not belong to your account' });
    }

    // Geofence check
    const geo = checkGeofence(
      parseFloat(latitude), parseFloat(longitude),
      parseFloat(codeData.hub_lat), parseFloat(codeData.hub_lng),
      codeData.geofence_radius
    );
    const isLowAccuracy = gps_accuracy_m && parseFloat(gps_accuracy_m) > 500;

    // Upload photo
    const uploaded = await uploadPhoto(photo_base64, 'duty-photos');

    // Create duty session
    const { rows: sessionRows } = await client.query(
      `INSERT INTO duty_sessions (
         emp_id, hub_id, duty_code,
         start_time, start_photo_url,
         start_latitude, start_longitude, start_gps_accuracy,
         start_address, start_outside_geo
       ) VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        codeData.emp_id, codeData.hub_id, duty_code,
        uploaded.url,
        latitude, longitude, gps_accuracy_m || null,
        location_address || null, !geo.inside,
      ]
    );

    // Mark code as used
    await client.query(
      `UPDATE duty_codes SET is_used = TRUE, used_at = NOW(), used_in_session = $1
       WHERE duty_code = $2`,
      [sessionRows[0].session_id, duty_code]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      session:          sessionRows[0],
      flagged_geofence: !geo.inside,
      flagged_accuracy: isLowAccuracy,
      message:          'Duty started successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── POST /api/duty/end ── Mark duty end ─────────────────────────────────────
router.post('/end', supervisorOnly, async (req, res) => {
  const client = await getClient();
  try {
    const {
      session_id,
      photo_base64,
      latitude, longitude, gps_accuracy_m, location_address,
      reason_code, reason_text,
    } = req.body;

    if (!session_id || !photo_base64) {
      return res.status(400).json({ error: 'session_id and photo_base64 are required' });
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'GPS location is required to mark duty end' });
    }

    await client.query('BEGIN');

    // Get session
    const { rows: sessRows } = await client.query(
      `SELECT ds.*, ts.min_duty_hours, ts.max_duty_hours,
              h.geofence_radius, h.latitude AS hub_lat, h.longitude AS hub_lng
       FROM duty_sessions ds
       JOIN employees e ON e.emp_id = ds.emp_id
       LEFT JOIN time_schemes ts ON ts.emp_id = e.emp_id
       JOIN hubs h ON h.hub_id = ds.hub_id
       WHERE ds.session_id = $1 AND ds.session_status = 'started'`,
      [session_id]
    );

    if (!sessRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active duty session not found' });
    }

    const sess = sessRows[0];

    // Verify ownership
    const { rows: empRows } = await client.query(
      'SELECT emp_id FROM employees WHERE user_id = $1',
      [req.user.user_id]
    );
    if (!empRows.length || empRows[0].emp_id !== sess.emp_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This session does not belong to your account' });
    }

    const hoursWorked = calcHours(sess.start_time, new Date());
    const minH = sess.min_duty_hours;
    const maxH = sess.max_duty_hours;

    // Determine early/late flag
    let earlyLateFlag = 'on_time';
    if (minH && hoursWorked < minH) earlyLateFlag = 'early';
    else if (maxH && hoursWorked > maxH) earlyLateFlag = 'late';

    // Reason required if early or late
    if ((earlyLateFlag === 'early' || earlyLateFlag === 'late') && !reason_code) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:          `Duty ended ${earlyLateFlag}. A reason is required.`,
        early_late_flag: earlyLateFlag,
        hours_worked:    hoursWorked,
        min_hours:       minH,
        max_hours:       maxH,
      });
    }

    // Geofence + accuracy
    const geo = checkGeofence(
      parseFloat(latitude), parseFloat(longitude),
      parseFloat(sess.hub_lat), parseFloat(sess.hub_lng),
      sess.geofence_radius
    );
    const isLowAccuracy = gps_accuracy_m && parseFloat(gps_accuracy_m) > 500;

    // Upload end photo
    const uploaded = await uploadPhoto(photo_base64, 'duty-photos');

    // Update session
    const { rows: updated } = await client.query(
      `UPDATE duty_sessions SET
         end_time          = NOW(),
         end_photo_url     = $1,
         end_latitude      = $2,
         end_longitude     = $3,
         end_gps_accuracy  = $4,
         end_address       = $5,
         end_outside_geo   = $6,
         hours_worked      = $7,
         early_late_flag   = $8,
         reason_code       = $9,
         reason_text       = $10,
         session_status    = 'completed',
         updated_at        = NOW()
       WHERE session_id = $11
       RETURNING *`,
      [
        uploaded.url,
        latitude, longitude, gps_accuracy_m || null,
        location_address || null, !geo.inside,
        hoursWorked, earlyLateFlag,
        reason_code || null, reason_text || null,
        session_id,
      ]
    );

    await client.query('COMMIT');
    return res.json({
      session:          updated[0],
      flagged_geofence: !geo.inside,
      flagged_accuracy: isLowAccuracy,
      message:          'Duty ended. Pending manager approval.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── GET /api/duty/my-sessions ── Supervisor views own duty history ───────────
router.get('/my-sessions', supervisorOnly, async (req, res) => {
  try {
    const { rows: empRows } = await query(
      'SELECT emp_id FROM employees WHERE user_id = $1',
      [req.user.user_id]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee not found' });

    const { rows } = await query(
      `SELECT ds.*, h.hub_name
       FROM duty_sessions ds
       JOIN hubs h ON h.hub_id = ds.hub_id
       WHERE ds.emp_id = $1
       ORDER BY ds.duty_date DESC, ds.start_time DESC
       LIMIT 60`,
      [empRows[0].emp_id]
    );
    return res.json({ sessions: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/duty/pending ── Manager/Owner sees all pending approvals ────────
router.get('/pending', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM v_pending_duties');
    return res.json({ pending: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/duty/:session_id/approve ── Approve a duty ────────────────────
router.post('/:session_id/approve', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE duty_sessions
       SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE session_id = $2 AND approval_status = 'pending'
       RETURNING *`,
      [req.user.user_id, req.params.session_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending session not found' });
    return res.json({ session: rows[0], message: 'Duty approved' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/duty/:session_id/reject ── Reject a duty ─────────────────────
router.post('/:session_id/reject', ownerOrManager, async (req, res) => {
  try {
    const { rejection_note } = req.body;
    const { rows } = await query(
      `UPDATE duty_sessions
       SET approval_status = 'rejected', approved_by = $1, approved_at = NOW(),
           rejection_note = $2, updated_at = NOW()
       WHERE session_id = $3 AND approval_status = 'pending'
       RETURNING *`,
      [req.user.user_id, rejection_note || null, req.params.session_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending session not found' });
    return res.json({ session: rows[0], message: 'Duty rejected' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
