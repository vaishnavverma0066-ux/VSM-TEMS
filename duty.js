# ─── Database ───────────────────────────────────────────────
# Copy the connection string from Railway → PostgreSQL → Connect
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE

# ─── JWT ────────────────────────────────────────────────────
# Generate a long random string — keep this secret
JWT_SECRET=replace_with_a_long_random_secret_string_min_32_chars
JWT_EXPIRES_IN=8h

# ─── Cloudinary ─────────────────────────────────────────────
# Get from cloudinary.com → Dashboard
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ─── Server ─────────────────────────────────────────────────
PORT=4000
NODE_ENV=development

# ─── App settings ───────────────────────────────────────────
DUTY_CODE_EXPIRY_HOURS=2
GPS_LOW_ACCURACY_THRESHOLD_M=500
