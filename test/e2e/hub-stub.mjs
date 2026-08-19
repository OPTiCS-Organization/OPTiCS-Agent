// OPTiCS Hub의 /agent 네임스페이스를 흉내내는 로컬 스텁.
// 외부로 나가는 요청이 전혀 없고, 에이전트가 emit하는 모든 이벤트를 JSONL로 기록한다.
import { createRequire } from 'module';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname);

// socket.io는 에이전트의 node_modules에서 가져온다.
const require = createRequire(path.join(HERE, '../../'));
const { Server } = require('socket.io');

const PORT = Number(process.env.STUB_PORT ?? 5599);
const EVENTS = process.env.E2E_EVENTS ?? path.join(HERE, 'events.jsonl');

fs.writeFileSync(EVENTS, '');
const record = (event, payload) => {
  fs.appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), event, payload }) + '\n');
};

let agentSocket = null;

const httpServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/cmd') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!agentSocket) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('agent not connected');
        return;
      }
      let command;
      try {
        command = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`bad json: ${String(error)}`);
        return;
      }
      record('>> command (stub→agent)', command);
      agentSocket.emit('command', command);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('sent');
    });
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ connected: Boolean(agentSocket) }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

io.of('/agent').on('connection', (socket) => {
  agentSocket = socket;
  console.log(`[stub] agent connected | id=${socket.id} | auth=${JSON.stringify(socket.handshake.auth)}`);
  record('CONNECT', { id: socket.id, auth: socket.handshake.auth });

  socket.on('register', (payload) => {
    console.log(`[stub] register received | ${JSON.stringify(payload)}`);
    socket.emit('register', {
      agentCode: 'E2E-STUB',
      agentUuid: payload?.agentUuid ?? 'e2e-stub-uuid-0001',
      agentIp: '127.0.0.1',
    });
  });

  socket.onAny((event, ...args) => {
    record(event, args.length <= 1 ? args[0] : args);
    if (event === 'service-status') {
      console.log(`[stub] service-status | ${JSON.stringify(args[0])}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[stub] agent disconnected | ${reason}`);
    record('DISCONNECT', { reason });
    agentSocket = null;
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}  (namespace /agent)`);
  console.log(`[stub] events -> ${EVENTS}`);
});
