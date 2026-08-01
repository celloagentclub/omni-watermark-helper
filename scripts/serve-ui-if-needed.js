import { spawn } from 'node:child_process';
import net from 'node:net';

const port = 4173;

const alreadyServing = await canConnect(port);
if (alreadyServing) {
  console.log(`UI server already running on ${port}`);
  process.exit(0);
}

const server = spawn('python3', ['-m', 'http.server', String(port), '-d', 'ui'], {
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.kill(signal);
    process.exit(0);
  });
}

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

function canConnect(targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: targetPort, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
