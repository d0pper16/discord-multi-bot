module.exports = {
  apps: [
    {
      name: 'multi-bot-manager',
      script: './multi-bot.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1800M',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: 27916
      },
      kill_timeout: 10000
    },
    {
      name: 'keepalive-service',
      script: './keepalive.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      error_file: './logs/keepalive-error.log',
      out_file: './logs/keepalive-out.log'
    }
  ],
  deploy: {
    production: {
      user: 'ubuntu',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:your-repo/your-project.git',
      path: '/var/www/your-project',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 start ecosystem.config.js --env production',
      'pre-deploy': 'git push origin main'
    }
  }
};