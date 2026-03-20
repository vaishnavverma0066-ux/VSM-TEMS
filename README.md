# Logistics Attendance System — Backend API

## Folder structure
```
attendance-backend/
├── server.js              ← Entry point
├── package.json
├── .env.example           ← Copy to .env and fill in your values
├── .gitignore
├── config/
│   ├── db.js              ← PostgreSQL connection pool
│   └── cloudinary.js      ← Photo upload config
├── middleware/
│   └── auth.js            ← JWT verify + role guards
├── routes/
│   ├── auth.js            ← Login, change password, reset password
│   ├── users.js           ← Create/manage logins (Owner + Manager)
│   ├── hubs.js            ← Hub CRUD, assign markers
│   ├── employees.js       ← Add employees, transfer, time schemes
│   ├── attendance.js      ← Mark attendance, view records, flagged entries
│   ├── duty.js            ← Supervisor duty start/end, approvals
│   └── export.js          ← Excel downloads
└── utils/
    └── cron.js            ← Auto-mark absent at 11:59pm, clean expired codes
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, Cloudinary keys
```

### 3. Run the database schema
- Open Railway → your PostgreSQL DB → Query tab
- Run the contents of schema.sql (provided separately)

### 4. Start the server
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | /api/auth/login | All | Login, returns JWT token |
| GET  | /api/auth/me | All | Get current user |
| POST | /api/auth/change-password | All | Change own password |
| POST | /api/auth/reset-password | Owner | Reset any user's password |
| GET  | /api/users | Owner/Manager | List all users |
| POST | /api/users | Owner/Manager | Create new login |
| PATCH| /api/users/:id/status | Owner | Activate/deactivate login |
| GET  | /api/hubs | Owner/Manager | List all hubs |
| POST | /api/hubs | Owner | Create hub |
| PATCH| /api/hubs/:id | Owner | Update hub |
| POST | /api/hubs/:id/assign-marker | Owner | Assign marker to hub |
| GET  | /api/employees | Owner/Manager | List employees (filterable) |
| POST | /api/employees | Owner/Manager | Add new employee |
| PATCH| /api/employees/:id | Owner/Manager | Edit employee |
| POST | /api/employees/:id/transfer | Owner/Manager | Transfer to another hub |
| PUT  | /api/employees/:id/time-scheme | Owner | Set/update time scheme |
| GET  | /api/attendance/today | Marker/Owner/Manager | Today's attendance for hub |
| POST | /api/attendance/mark | Marker/Owner/Manager | Mark attendance |
| GET  | /api/attendance/employee/:id | Owner/Manager | Employee history |
| GET  | /api/attendance/summary | Owner/Manager | Hub-wise summary |
| GET  | /api/attendance/flagged | Owner/Manager | GPS-flagged records |
| POST | /api/duty/generate-code | Supervisor | Get duty code |
| POST | /api/duty/start | Supervisor | Start duty (photo + GPS) |
| POST | /api/duty/end | Supervisor | End duty (photo + GPS + reason) |
| GET  | /api/duty/pending | Owner/Manager | Pending approvals |
| POST | /api/duty/:id/approve | Owner/Manager | Approve duty |
| POST | /api/duty/:id/reject | Owner/Manager | Reject duty |
| GET  | /api/export/attendance | Owner/Manager | Download attendance Excel |
| GET  | /api/export/duty-sessions | Owner/Manager | Download duty Excel |

## Deploying to Railway
1. Push this folder to a GitHub repo
2. In Railway: New Project → Deploy from GitHub repo
3. Add all environment variables from .env.example
4. Railway auto-detects Node.js and runs `npm start`
5. Add a PostgreSQL plugin to the same project
6. Copy the DATABASE_URL from PostgreSQL plugin into your env vars
