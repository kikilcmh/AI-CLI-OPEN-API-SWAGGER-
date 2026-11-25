require('dotenv').config();

module.exports = {
  apps: [{
    name: 'agy-api',
    script: 'index.js',
    cwd: __dirname,
    env_file: '.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
