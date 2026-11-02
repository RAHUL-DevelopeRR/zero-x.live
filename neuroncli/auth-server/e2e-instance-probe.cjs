// Test-only preload for check-node-lifecycle.cjs's handover check, which runs two gateway
// instances as their own processes like systemd's zerox-gateway@0 and @1:
// `node --require ./e2e-instance-probe.cjs --import ./e2e-upstream-shim.mjs server.js`, with an IPC
// channel. It never ships: server.js does not require it.
//
// - Every request a listener of this process accepts is reported as { served: pid, port, path }
//   (port: the connection's local port), so the check can tell which of two instances sharing one
//   port answered it.
// - An IPC 'SIGTERM' message raises the signal's handlers, for platforms where a real SIGTERM
//   cannot be sent to a child (on Windows, kill() ends the process at once).
const http = require('node:http');

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function emitWithReport(event, ...args) {
  if (event === 'request' && process.connected) {
    const [req] = args;
    process.send({ served: process.pid, port: req.socket.localPort, path: req.url.split('?')[0] });
  }
  return emit.call(this, event, ...args);
};

process.on('message', message => {
  if (message === 'SIGTERM') process.emit('SIGTERM', 'SIGTERM');
});
