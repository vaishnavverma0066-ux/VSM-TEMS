const router  = require('express').Router();
const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const { authenticate, ownerOrManager } = require('../middleware/auth');

router.use(authenticate, ownerOrManager);

// ─── GET /api/export/attendance ── Download attendance as .xlsx ───────────────
// Query params: hub_id, from_date, to_date, emp_type, status
router.get('/attendance', async (req, res) => {
  try {
    const { hub_id, from_date, to_date, emp_type, status } = req.query;

    let sql = `
      SELECT
        e.employee_code   AS "Employee Code",
        e.full_name       AS "Employee Name",
        e.emp_type        AS "Type",
        h.hub_name        AS "Hub",
        ar.attendance_date AS "Date",
        ar.status         AS "Status",
        ar.marked_at      AS "Marked At",
        u.full_name       AS "Marked By",
        ar.reason_code    AS "Reason Code",
        ar.reason_text    AS "Reason",
        ar.location_address AS "Location",
        ar.latitude       AS "Latitude",
        ar.longitude      AS "Longitude",
        CASE WHEN ar.is_outside_geofence THEN 'Yes' ELSE 'No' END AS "Outside Geofence",
        CASE WHEN ar.is_low_accuracy     THEN 'Yes' ELSE 'No' END AS "Low GPS Accuracy"
      FROM attendance_records ar
      JOIN employees e ON e.emp_id = ar.emp_id
      JOIN hubs h ON h.hub_id = ar.hub_id
      LEFT JOIN users u ON u.user_id = ar.marked_by
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (hub_id)    { sql += ` AND ar.hub_id = $${idx++}`;          params.push(hub_id); }
    if (emp_type)  { sql += ` AND e.emp_type = $${idx++}`;         params.push(emp_type); }
    if (status)    { sql += ` AND ar.status = $${idx++}`;          params.push(status); }
    if (from_date) { sql += ` AND ar.attendance_date >= $${idx++}`; params.push(from_date); }
    if (to_date)   { sql += ` AND ar.attendance_date <= $${idx++}`; params.push(to_date); }

    sql += ' ORDER BY ar.attendance_date DESC, e.full_name';

    const { rows } = await query(sql, params);

    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance');

    if (rows.length) {
      worksheet.columns = Object.keys(rows[0]).map(key => ({
        header: key, key, width: 20
      }));

      // Style header row
      worksheet.getRow(1).font      = { bold: true };
      worksheet.getRow(1).fill      = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: 'FF1D4E89' }
      };
      worksheet.getRow(1).font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).alignment = { horizontal: 'center' };

      rows.forEach(row => worksheet.addRow(row));

      // Color-code status column
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const statusCell = row.getCell('Status');
        if (statusCell.value === 'present') statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        if (statusCell.value === 'late')    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
        if (statusCell.value === 'absent')  statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
      });
    } else {
      worksheet.addRow(['No records found for the selected filters']);
    }

    const filename = `attendance_${from_date || 'all'}_to_${to_date || 'today'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// ─── GET /api/export/duty-sessions ── Download duty sessions as .xlsx ─────────
router.get('/duty-sessions', async (req, res) => {
  try {
    const { hub_id, from_date, to_date, approval_status } = req.query;

    let sql = `
      SELECT
        e.employee_code      AS "Employee Code",
        e.full_name          AS "Employee Name",
        h.hub_name           AS "Hub",
        ds.duty_date         AS "Duty Date",
        ds.duty_code         AS "Duty Code",
        ds.start_time        AS "Start Time",
        ds.end_time          AS "End Time",
        ds.hours_worked      AS "Hours Worked",
        ds.early_late_flag   AS "Early/Late",
        ds.reason_code       AS "Reason Code",
        ds.reason_text       AS "Reason",
        ds.approval_status   AS "Approval Status",
        a.full_name          AS "Approved By",
        ds.rejection_note    AS "Rejection Note",
        ds.start_address     AS "Start Location",
        ds.end_address       AS "End Location",
        CASE WHEN ds.start_outside_geo THEN 'Yes' ELSE 'No' END AS "Start Outside Geofence",
        CASE WHEN ds.end_outside_geo   THEN 'Yes' ELSE 'No' END AS "End Outside Geofence"
      FROM duty_sessions ds
      JOIN employees e ON e.emp_id = ds.emp_id
      JOIN hubs h ON h.hub_id = ds.hub_id
      LEFT JOIN users a ON a.user_id = ds.approved_by
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (hub_id)          { sql += ` AND ds.hub_id = $${idx++}`;          params.push(hub_id); }
    if (approval_status) { sql += ` AND ds.approval_status = $${idx++}`; params.push(approval_status); }
    if (from_date)       { sql += ` AND ds.duty_date >= $${idx++}`;       params.push(from_date); }
    if (to_date)         { sql += ` AND ds.duty_date <= $${idx++}`;       params.push(to_date); }

    sql += ' ORDER BY ds.duty_date DESC, ds.start_time DESC';

    const { rows } = await query(sql, params);

    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Duty Sessions');

    if (rows.length) {
      worksheet.columns = Object.keys(rows[0]).map(key => ({
        header: key, key, width: 22
      }));
      worksheet.getRow(1).font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F6E56' } };
      worksheet.getRow(1).alignment = { horizontal: 'center' };

      rows.forEach(row => worksheet.addRow(row));
    } else {
      worksheet.addRow(['No sessions found for the selected filters']);
    }

    const filename = `duty_sessions_${from_date || 'all'}_to_${to_date || 'today'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
