// Preloaded into the gateway under test by loadtest.mjs (`node --import`). Answers the parent's
// IPC messages with this process's CPU time, event loop utilisation and delay, and memory since
// the last `mark`. Never loaded by the deployed gateway.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let since = { cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };

process.on('message', message => {
  if (message?.type === 'mark') {
    delay.reset();
    since = { cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };
    process.send({ type: 'marked' });
  } else if (message?.type === 'read') {
    const cpu = process.cpuUsage(since.cpu);
    process.send({
      type: 'reading',
      cpuMs: (cpu.user + cpu.system) / 1000,
      elu: performance.eventLoopUtilization(since.elu).utilization,
      lagP99Ms: delay.percentile(99) / 1e6,
      lagMaxMs: delay.max / 1e6,
      rssMb: process.memoryUsage.rss() / 1048576,
      maxRssMb: process.resourceUsage().maxRSS / 1024,
    });
  }
});
