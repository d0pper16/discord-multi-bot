const os = require('os');

if (process.send) {
  let previousCpuUsage = process.cpuUsage();

  setInterval(() => {
    const memUsage = process.memoryUsage();
    const ramMB = memUsage.heapUsed / 1024 / 1024;
    
    // CPU usage lebih akurat
    const cpuUsage = process.cpuUsage(previousCpuUsage);
    const totalCpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to milliseconds
    previousCpuUsage = process.cpuUsage();
    
    process.send({
      type: 'stats',
      memory: parseFloat(ramMB.toFixed(2)),
      cpu: parseFloat(totalCpuUsage.toFixed(2))
    });
  }, 5000);
}