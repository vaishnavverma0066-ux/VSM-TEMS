const cron  = require('node-cron');
const { query } = require('../config/db');

// ─── Run at 11:59 PM every day ───────────────────────────────────────────────
// Auto-marks all unmarked office employees as absent for today
const autoMarkAbsent = cron.schedule('59 23 * * *', async () => {
  console.log('[CRON] Running auto-mark absent job...');
  try {
    // Find all active office employees who have no attendance record for today
    const { rows: unmarked } = await query(`
      SELECT e.emp_id, e.hub_id
      FROM employees e
      WHERE e.emp_type = 'office' AND e.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM attendance_records ar
          WHERE ar.emp_id = e.emp_id AND ar.attendance_date = CURRENT_DATE
        )
    `);

    if (!unmarked.length) {
      console.log('[CRON] No unmarked employees — all done.');
      return;
    }

    // Bulk insert absent records
    for (const emp of unmarked) {
      await query(
        `INSERT INTO attendance_records (emp_id, hub_id, attendance_date, status, auto_marked)
         VALUES ($1, $2, CURRENT_DATE, 'absent', TRUE)
         ON CONFLICT (emp_id, attendance_date) DO NOTHING`,
        [emp.emp_id, emp.hub_id]
      );
    }

    console.log(`[CRON] Auto-marked ${unmarked.length} employees as absent.`);
  } catch (err) {
    console.error('[CRON] Auto-mark absent failed:', err);
  }
}, { timezone: 'Asia/Kolkata' });

// ─── Run every hour ──────────────────────────────────────────────────────────
// Cleans expired, unused duty codes
const cleanExpiredCodes = cron.schedule('0 * * * *', async () => {
  try {
    const { rowCount } = await query(
      `DELETE FROM duty_codes WHERE expires_at < NOW() AND is_used = FALSE`
    );
    if (rowCount > 0) {
      console.log(`[CRON] Cleaned ${rowCount} expired duty codes.`);
    }
  } catch (err) {
    console.error('[CRON] Duty code cleanup failed:', err);
  }
});

module.exports = { autoMarkAbsent, cleanExpiredCodes };
