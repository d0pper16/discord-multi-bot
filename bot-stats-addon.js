// ==========================================
// SEND STATS TO PARENT PROCESS (MANAGER)
// ==========================================

// Hanya jalankan jika ada parent process (fork)
if (process.send) {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const ramMB = memUsage.heapUsed / 1024 / 1024;
    
    process.send({
      type: 'stats',
      memory: parseFloat(ramMB.toFixed(2)),
      cpu: Math.random() * 20 // Placeholder - adjust dengan actual CPU tracking jika perlu
    });
  }, 5000); // Update setiap 5 detik
}