const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { authenticate, ownerOnly, ownerOrManager } = require('../middleware/auth');

router.use(authenticate);

// ─── GET /api/employees ─────────────────────────────────────────────────────
router.get('/', ownerOrManager, async (req, res) => {
  try {
    const { hub_id, emp_type, search, is_active } = req.query;
    let sql = `
      SELECT e.emp_id, e.employee_code, e.full_name, e.emp_type,
             e.phone, e.email, e.joining_date, e.is_active,
             h.hub_name, h.hub_id,
             ts.shift_start, ts.shift_end, ts.grace_mins,
             ts.min_duty_hours, ts.max_duty_hours,
             u.username AS login_username
      FROM employees e
      JOIN hubs h ON h.hub_id = e.hub_id
      LEFT JOIN time_schemes ts ON ts.emp_id = e.emp_id
      LEFT JOIN users u ON u.user_id = e.user_id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (hub_id)   { sql += ` AND e.hub_id = $${idx++}`;   params.push(hub_id); }
    if (emp_type) { sql += ` AND e.emp_type = $${idx++}`; params.push(emp_type); }
    if (is_active !== undefined) {
      sql += ` AND e.is_active = $${idx++}`;
      params.push(is_active === 'true');
    }
    if (search) {
      sql += ` AND (e.full_name ILIKE $${idx} OR e.employee_code ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    sql += ' ORDER BY e.full_name';
    const { rows } = await query(sql, params);
    return res.json({ employees: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/employees/:emp_id ─── Full profile ────────────────────────────
router.get('/:emp_id', ownerOrManager, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM v_employee_profile WHERE emp_id = $1',
      [req.params.emp_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });

    // Transfer history
    const { rows: transfers } = await query(
      `SELECT ht.transfer_date, ht.reason,
              hf.hub_name AS from_hub, ht2.hub_name AS to_hub,
              u.full_name AS transferred_by
       FROM hub_transfers ht
       JOIN hubs hf  ON hf.hub_id  = ht.from_hub_id
       JOIN hubs ht2 ON ht2.hub_id = ht.to_hub_id
       LEFT JOIN users u ON u.user_id = ht.transferred_by
       WHERE ht.emp_id = $1
       ORDER BY ht.transfer_date DESC`,
      [req.params.emp_id]
    );

    return res.json({ employee: rows[0], transfer_history: transfers });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/employees ── Add new employee ─────────────────────────────────
router.post('/', ownerOrManager, async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const {
      full_name, employee_code, emp_type, hub_id,
      phone, email, joining_date,
      // Time scheme
      shift_start, shift_end, grace_mins,
      works_mon, works_tue, works_wed, works_thu, works_fri, works_sat, works_sun,
      min_duty_hours, max_duty_hours,
      // Login (supervisors only)
      user_id,
    } = req.body;

    if (!full_name || !emp_type || !hub_id || !joining_date) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'full_name, emp_type, hub_id, joining_date are required' });
    }

    // Auto-generate employee code if not provided
    let code = employee_code;
    if (!code) {
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM employees'
      );
      const num = parseInt(countRows[0].count) + 1;
      code = `EMP-${String(num).padStart(4, '0')}`;
    }

    // Insert employee
    const { rows: empRows } = await client.query(
      `INSERT INTO employees
         (employee_code, full_name, emp_type, hub_id, phone, email, joining_date, user_id, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [code, full_name, emp_type, hub_id, phone || null, email || null,
       joining_date, user_id || null, req.user.user_id]
    );

    const emp = empRows[0];

    // Insert time scheme if provided
    if (shift_start && shift_end) {
      await client.query(
        `INSERT INTO time_schemes (
           emp_id, shift_start, shift_end, grace_mins,
           works_mon, works_tue, works_wed, works_thu, works_fri, works_sat, works_sun,
           min_duty_hours, max_duty_hours, set_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          emp.emp_id, shift_start, shift_end, grace_mins || 15,
          works_mon !== false, works_tue !== false, works_wed !== false,
          works_thu !== false, works_fri !== false, works_sat !== false,
          works_sun === true,
          min_duty_hours || null, max_duty_hours || null,
          req.user.user_id
        ]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ employee: emp, message: 'Employee added successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Employee code already exists' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/employees/:emp_id ── Edit employee details ───────────────────
router.patch('/:emp_id', ownerOrManager, async (req, res) => {
  try {
    const fields = ['full_name', 'phone', 'email', 'is_active', 'user_id'];
    const updates = [];
    const values  = [];
    let   idx     = 1;

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        values.push(req.body[f]);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push('updated_at = NOW()');
    values.push(req.params.emp_id);

    const { rows } = await query(
      `UPDATE employees SET ${updates.join(', ')} WHERE emp_id = $${idx} RETURNING *`,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    return res.json({ employee: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/employees/:emp_id/transfer ── Move to another hub ─────────────
router.post('/:emp_id/transfer', ownerOrManager, async (req, res) => {
  const client = await getClient();
  try {
    const { to_hub_id, reason } = req.body;
    if (!to_hub_id) return res.status(400).json({ error: 'to_hub_id is required' });

    await client.query('BEGIN');

    // Get current hub
    const { rows: empRows } = await client.query(
      'SELECT hub_id FROM employees WHERE emp_id = $1',
      [req.params.emp_id]
    );
    if (!empRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const from_hub_id = empRows[0].hub_id;
    if (from_hub_id === to_hub_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Employee is already in that hub' });
    }

    // Log transfer
    await client.query(
      `INSERT INTO hub_transfers (emp_id, from_hub_id, to_hub_id, reason, transferred_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.emp_id, from_hub_id, to_hub_id, reason || null, req.user.user_id]
    );

    // Update employee's hub
    const { rows } = await client.query(
      'UPDATE employees SET hub_id = $1, updated_at = NOW() WHERE emp_id = $2 RETURNING *',
      [to_hub_id, req.params.emp_id]
    );

    await client.query('COMMIT');
    return res.json({ employee: rows[0], message: 'Employee transferred successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── PUT /api/employees/:emp_id/time-scheme ── Set or update time scheme ─────
router.put('/:emp_id/time-scheme', ownerOnly, async (req, res) => {
  const client = await getClient();
  try {
    const {
      shift_start, shift_end, grace_mins,
      works_mon, works_tue, works_wed, works_thu, works_fri, works_sat, works_sun,
      min_duty_hours, max_duty_hours,
      change_reason
    } = req.body;

    if (!shift_start || !shift_end) {
      return res.status(400).json({ error: 'shift_start and shift_end are required' });
    }

    await client.query('BEGIN');

    // Save old scheme to history
    const { rows: oldScheme } = await client.query(
      'SELECT * FROM time_schemes WHERE emp_id = $1',
      [req.params.emp_id]
    );

    if (oldScheme.length) {
      const o = oldScheme[0];
      await client.query(
        `INSERT INTO time_scheme_history (
           emp_id, changed_by,
           old_shift_start, old_shift_end, old_grace_mins,
           old_min_duty_hours, old_max_duty_hours,
           new_shift_start, new_shift_end, new_grace_mins,
           new_min_duty_hours, new_max_duty_hours, change_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          req.params.emp_id, req.user.user_id,
          o.shift_start, o.shift_end, o.grace_mins,
          o.min_duty_hours, o.max_duty_hours,
          shift_start, shift_end, grace_mins || 15,
          min_duty_hours || null, max_duty_hours || null,
          change_reason || null
        ]
      );
    }

    // Upsert time scheme
    const { rows } = await client.query(
      `INSERT INTO time_schemes (
         emp_id, shift_start, shift_end, grace_mins,
         works_mon, works_tue, works_wed, works_thu, works_fri, works_sat, works_sun,
         min_duty_hours, max_duty_hours, effective_from, set_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_DATE,$14)
       ON CONFLICT (emp_id) DO UPDATE SET
         shift_start = $2, shift_end = $3, grace_mins = $4,
         works_mon = $5, works_tue = $6, works_wed = $7,
         works_thu = $8, works_fri = $9, works_sat = $10, works_sun = $11,
         min_duty_hours = $12, max_duty_hours = $13,
         effective_from = CURRENT_DATE, set_by = $14, updated_at = NOW()
       RETURNING *`,
      [
        req.params.emp_id, shift_start, shift_end, grace_mins || 15,
        works_mon !== false, works_tue !== false, works_wed !== false,
        works_thu !== false, works_fri !== false, works_sat !== false,
        works_sun === true,
        min_duty_hours || null, max_duty_hours || null,
        req.user.user_id
      ]
    );

    await client.query('COMMIT');
    return res.json({ time_scheme: rows[0], message: 'Time scheme updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── GET /api/employees/:emp_id/time-scheme/history ─────────────────────────
router.get('/:emp_id/time-scheme/history', ownerOnly, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tsh.*, u.full_name AS changed_by_name
       FROM time_scheme_history tsh
       LEFT JOIN users u ON u.user_id = tsh.changed_by
       WHERE tsh.emp_id = $1
       ORDER BY tsh.changed_at DESC`,
      [req.params.emp_id]
    );
    return res.json({ history: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
