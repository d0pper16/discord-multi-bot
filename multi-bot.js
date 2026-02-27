const { fork } = require('child_process');
const express = require('express');
const http = require('http');
const os = require('os');
const socketio = require('socket.io');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// ==========================================
// CONST & CONFIGURATION
// ==========================================
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 27916;
const CHECK_INTERVAL = 2000; // Check stats setiap 2 detik

// ═══════════════════════════════════════════
// RAM THRESHOLDS (Updated)
// ═══════════════════════════════════════════
const RAM_THRESHOLDS = {
  LOW: 49,           // < 49%
  NORMAL: 60,        // 50-60%
  HIGH: 75,          // 60-75%
  VERY_HIGH: 89,     // 75-89% (preparing restart)
  CRITICAL: 100      // 90+% (critical auto restart)
};

// ═══════════════════════════════════════════
// CPU THRESHOLDS (New)
// ═══════════════════════════════════════════
const CPU_THRESHOLDS = {
  LOW: 40,           // < 40%
  NORMAL: 59,        // 40-59%
  HIGH: 75,          // 60-75%
  VERY_HIGH: 85,     // 75-85% (preparing restart)
  CRITICAL: 100      // 85+% (critical auto restart)
};

const BOTS = [
  { name: 'music', script: './index_music.js', port: 3001 },
  { name: 'voice', script: './index_voice.js', port: 3002 }
];

// ==========================================
// CHILD PROCESS MANAGEMENT
// ==========================================
let children = {};
let botStats = {};

function startBots() {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 Starting all bots...');
  console.log('='.repeat(50) + '\n');

  BOTS.forEach(bot => {
    if (children[bot.name]) {
      children[bot.name].kill('SIGTERM');
    }

    children[bot.name] = fork(bot.script, {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    botStats[bot.name] = {
      status: 'starting',
      memory: 0,
      cpu: 0,
      uptime: Date.now(),
      restarts: 0
    };
    
    // Listen for messages from child process
    children[bot.name].on('message', (msg) => {
      if (msg.type === 'stats') {
        botStats[bot.name].memory = msg.memory;
        botStats[bot.name].cpu = msg.cpu;
        botStats[bot.name].status = 'online';
      }
    });

    children[bot.name].on('exit', (code) => {
      console.error(`❌ Bot ${bot.name} exited with code ${code}`);
      botStats[bot.name].status = 'offline';
    });

    children[bot.name].on('error', (err) => {
      console.error(`❌ Bot ${bot.name} error:`, err.message);
    });

    console.log(`✅ Started bot: ${bot.name} (PID: ${children[bot.name].pid})`);
  });
}

// ==========================================
// STATUS LEVEL FUNCTIONS
// ==========================================
function getRamStatus(ramPercentage) {
  if (ramPercentage < RAM_THRESHOLDS.LOW) {
    return 'low';
  } else if (ramPercentage <= RAM_THRESHOLDS.NORMAL) {
    return 'normal';
  } else if (ramPercentage <= RAM_THRESHOLDS.HIGH) {
    return 'high';
  } else if (ramPercentage <= RAM_THRESHOLDS.VERY_HIGH) {
    return 'veryhigh';
  } else {
    return 'critical';
  }
}

function getCpuStatus(cpuPercentage) {
  if (cpuPercentage < CPU_THRESHOLDS.LOW) {
    return 'low';
  } else if (cpuPercentage <= CPU_THRESHOLDS.NORMAL) {
    return 'normal';
  } else if (cpuPercentage <= CPU_THRESHOLDS.HIGH) {
    return 'high';
  } else if (cpuPercentage <= CPU_THRESHOLDS.VERY_HIGH) {
    return 'veryhigh';
  } else {
    return 'critical';
  }
}

function getOverallStatus(ramStatus, cpuStatus) {
  const statusPriority = {
    critical: 5,
    veryhigh: 4,
    high: 3,
    normal: 2,
    low: 1
  };

  const ramPriority = statusPriority[ramStatus] || 0;
  const cpuPriority = statusPriority[cpuStatus] || 0;

  const maxPriority = Math.max(ramPriority, cpuPriority);

  for (const [status, priority] of Object.entries(statusPriority)) {
    if (priority === maxPriority) {
      return status;
    }
  }

  return 'low';
}

// ==========================================
// RESOURCE MONITORING
// ==========================================
let statusHistory = [];
const MAX_HISTORY = 100;

function getSystemStats() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024; // MB
  const total = os.totalmem() / 1024 / 1024; // MB
  const ramPercentage = (used / total) * 100;

  // CPU calculation
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach((cpu) => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  const cpuUsage = 100 - ((totalIdle / totalTick) * 100);

  // Determine status
  const ramStatus = getRamStatus(ramPercentage);
  const cpuStatus = getCpuStatus(cpuUsage);
  const overallStatus = getOverallStatus(ramStatus, cpuStatus);

  const stats = {
    timestamp: new Date().toISOString(),
    ram: {
      used: parseFloat(used.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      percentage: parseFloat(ramPercentage.toFixed(2)),
      status: ramStatus,
      thresholds: RAM_THRESHOLDS
    },
    cpu: {
      percentage: parseFloat(cpuUsage.toFixed(2)),
      status: cpuStatus,
      thresholds: CPU_THRESHOLDS
    },
    status: overallStatus,
    bots: botStats,
    uptime: process.uptime()
  };

  // Keep history
  statusHistory.push(stats);
  if (statusHistory.length > MAX_HISTORY) {
    statusHistory.shift();
  }

  return stats;
}

// ==========================================
// EXPRESS SETUP
// ==========================================
const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: { origin: '*' }
});

// Static files
app.use(express.static(path.join(__dirname, 'dashboard')));
app.use(express.json());

// API Endpoints
app.get('/api/stats', (req, res) => {
  res.json(getSystemStats());
});

app.get('/api/history', (req, res) => {
  res.json(statusHistory);
});

app.get('/api/config', (req, res) => {
  res.json({
    ramThresholds: RAM_THRESHOLDS,
    cpuThresholds: CPU_THRESHOLDS
  });
});

app.post('/api/restart-bot', (req, res) => {
  const { botName } = req.body;
  
  if (!BOTS.find(b => b.name === botName)) {
    return res.status(400).json({ error: 'Bot not found' });
  }

  if (children[botName]) {
    children[botName].kill('SIGTERM');
    setTimeout(() => {
      children[botName] = fork(BOTS.find(b => b.name === botName).script);
      botStats[botName].restarts++;
      res.json({ success: true, message: `${botName} restarted` });
      io.emit('bot-restarted', { botName, timestamp: new Date() });
    }, 1000);
  } else {
    res.status(500).json({ error: 'Failed to restart bot' });
  }
});

app.post('/api/restart-all', (req, res) => {
  console.log('\n📥 Manual restart triggered for all bots');
  
  Object.entries(children).forEach(([name, child]) => {
    child.kill('SIGTERM');
    botStats[name].restarts++;
  });

  setTimeout(() => {
    startBots();
    res.json({ success: true, message: 'All bots restarted' });
    io.emit('all-restarted', { timestamp: new Date() });
  }, 2000);
});

// ==========================================
// WEBSOCKET EVENTS
// ==========================================
let clientCount = 0;

io.on('connection', (socket) => {
  clientCount++;
  console.log(`📊 Dashboard client connected (${clientCount} active)`);

  // Send current stats
  socket.emit('stats', getSystemStats());
  socket.emit('history', statusHistory);
  socket.emit('config', {
    ramThresholds: RAM_THRESHOLDS,
    cpuThresholds: CPU_THRESHOLDS
  });

  socket.on('request-restart', (botName) => {
    if (botName === 'all') {
      console.log(`\n🔄 Dashboard requested restart: ALL BOTS`);
      Object.entries(children).forEach(([name, child]) => {
        child.kill('SIGTERM');
        botStats[name].restarts++;
      });

      setTimeout(() => {
        startBots();
        io.emit('restart-done', { botName: 'all' });
      }, 2000);
    } else {
      console.log(`\n🔄 Dashboard requested restart: ${botName}`);
      if (children[botName]) {
        children[botName].kill('SIGTERM');
        botStats[botName].restarts++;

        setTimeout(() => {
          children[botName] = fork(BOTS.find(b => b.name === botName).script);
          io.emit('restart-done', { botName });
        }, 1000);
      }
    }
  });

  socket.on('disconnect', () => {
    clientCount--;
    console.log(`📊 Dashboard client disconnected (${clientCount} active)`);
  });
});

// ==========================================
// MONITORING LOOP
// ==========================================
let lastRestartTime = {};

setInterval(() => {
  const stats = getSystemStats();

  // Broadcast to all connected clients
  io.emit('stats', stats);

  // Log periodic status with RAM and CPU details
  console.log(
    `📊 [${stats.timestamp}] ` +
    `Overall: ${stats.status.toUpperCase()} | ` +
    `RAM: ${stats.ram.percentage.toFixed(1)}% (${stats.ram.used.toFixed(1)}/${stats.ram.total.toFixed(1)}MB) [${stats.ram.status.toUpperCase()}] | ` +
    `CPU: ${stats.cpu.percentage.toFixed(1)}% [${stats.cpu.status.toUpperCase()}] | ` +
    `Bots: ${Object.values(botStats).map(b => b.status).join(', ')}`
  );

  // ═══════════════════════════════════════════
  // AUTO-RESTART if RAM CRITICAL
  // ════════════════════════���══════════════════
  if (stats.ram.status === 'critical') {
    const now = Date.now();
    
    // Prevent multiple restart attempts dalam 30 detik
    if (!lastRestartTime.ramCritical || now - lastRestartTime.ramCritical > 30000) {
      console.error('\n' + '='.repeat(50));
      console.error('🚨 CRITICAL: RAM usage CRITICAL!');
      console.error('='.repeat(50));
      console.error(`⚠️  RAM: ${stats.ram.percentage.toFixed(1)}% > ${RAM_THRESHOLDS.VERY_HIGH + 1}% (threshold)`);
      console.error(`📥 Triggering auto-restart...\n`);

      lastRestartTime.ramCritical = now;

      Object.entries(children).forEach(([name, child]) => {
        child.kill('SIGTERM');
        botStats[name].restarts++;
      });

      setTimeout(() => {
        startBots();
        io.emit('critical-restart', { 
          reason: 'RAM critical',
          timestamp: new Date(),
          stats: stats,
          type: 'ram'
        });
      }, 3000);
    }
  }

  // ═══════════════════════════════════════════
  // AUTO-RESTART if CPU CRITICAL
  // ═══════════════════════════════════════════
  if (stats.cpu.status === 'critical') {
    const now = Date.now();
    
    // Prevent multiple restart attempts dalam 30 detik
    if (!lastRestartTime.cpuCritical || now - lastRestartTime.cpuCritical > 30000) {
      console.error('\n' + '='.repeat(50));
      console.error('🚨 CRITICAL: CPU usage CRITICAL!');
      console.error('='.repeat(50));
      console.error(`⚠️  CPU: ${stats.cpu.percentage.toFixed(1)}% > ${CPU_THRESHOLDS.VERY_HIGH + 1}% (threshold)`);
      console.error(`📥 Triggering auto-restart...\n`);

      lastRestartTime.cpuCritical = now;

      Object.entries(children).forEach(([name, child]) => {
        child.kill('SIGTERM');
        botStats[name].restarts++;
      });

      setTimeout(() => {
        startBots();
        io.emit('critical-restart', { 
          reason: 'CPU critical',
          timestamp: new Date(),
          stats: stats,
          type: 'cpu'
        });
      }, 3000);
    }
  }

}, CHECK_INTERVAL);

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function gracefulShutdown(signal) {
  console.log(`\n📥 Received ${signal}, shutting down gracefully...`);

  // Kill all child processes
  Object.entries(children).forEach(([name, child]) => {
    console.log(`💥 Killing ${name} (PID: ${child.pid})`);
    child.kill('SIGTERM');
  });

  // Close server
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('⚠️  Force exiting after 10 seconds');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==========================================
// STARTUP
// ==========================================
console.log('\n' + '='.repeat(50));
console.log('🎯 MULTI-BOT MANAGER');
console.log('='.repeat(50));
console.log(`Dashboard: http://localhost:${DASHBOARD_PORT}`);
console.log('\n📊 RAM Thresholds:');
console.log(`  • Low:           < ${RAM_THRESHOLDS.LOW}%`);
console.log(`  • Normal:        ${RAM_THRESHOLDS.LOW}-${RAM_THRESHOLDS.NORMAL}%`);
console.log(`  • High:          ${RAM_THRESHOLDS.NORMAL + 1}-${RAM_THRESHOLDS.HIGH}%`);
console.log(`  • Very High:     ${RAM_THRESHOLDS.HIGH + 1}-${RAM_THRESHOLDS.VERY_HIGH}% (Preparing Restart)`);
console.log(`  • Critical:      > ${RAM_THRESHOLDS.VERY_HIGH}% (Auto Restart)`);
console.log('\n⚙️  CPU Thresholds:');
console.log(`  • Low:           < ${CPU_THRESHOLDS.LOW}%`);
console.log(`  • Normal:        ${CPU_THRESHOLDS.LOW}-${CPU_THRESHOLDS.NORMAL}%`);
console.log(`  • High:          ${CPU_THRESHOLDS.NORMAL + 1}-${CPU_THRESHOLDS.HIGH}%`);
console.log(`  • Very High:     ${CPU_THRESHOLDS.HIGH + 1}-${CPU_THRESHOLDS.VERY_HIGH}% (Preparing Restart)`);
console.log(`  • Critical:      > ${CPU_THRESHOLDS.VERY_HIGH}% (Auto Restart)`);
console.log('='.repeat(50) + '\n');

// Start dashboard server
server.listen(DASHBOARD_PORT, () => {
  console.log(`✅ Dashboard server listening on port ${DASHBOARD_PORT}\n`);
});

// Start all bots
startBots();

// Keep the manager alive
setInterval(() => {
  // Manager health check
}, 60000);