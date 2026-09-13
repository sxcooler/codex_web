import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const pending = [];
let initialized = false;
let initializeResponded = false;
let calls = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    send({ method: 'replySeen', params: message });
    return;
  }
  switch (message.method) {
    case 'environment':
      send({ id: message.id, result: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')])) });
      break;
    case 'initialize':
      setTimeout(() => { send({ id: message.id, result: message.params }); initializeResponded = true; }, 10);
      break;
    case 'initialized': initialized = initializeResponded; break;
    case 'ready': send({ id: message.id, result: initialized }); break;
    case 'pair':
      pending.push(message);
      if (pending.length === 2) {
        send({ id: pending[1].id, result: 'second' });
        const bytes = Buffer.from(JSON.stringify({ id: pending[0].id, result: '中文🙂' }) + '\n');
        const cut = bytes.indexOf(Buffer.from('中')) + 1;
        process.stdout.write(bytes.subarray(0, cut));
        setTimeout(() => process.stdout.write(bytes.subarray(cut)), 10);
      }
      break;
    case 'events':
      send({ method: 'notice', params: { value: 1 } });
      send({ id: 0, method: 'approval', params: {} });
      send({ id: '0', method: 'approval', params: {} });
      send({ id: 'stale', method: 'approval', params: {} });
      send({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'stale' } });
      send({ id: message.id, result: null });
      break;
    case 'ignore': calls++; break;
    case 'count': send({ id: message.id, result: calls }); break;
    case 'rpcError': send({ id: message.id, error: { code: -32000, message: 'denied', data: { reason: 'fixture' } } }); break;
    case 'exit': process.exit(7); break;
    case 'malformed': process.stdout.write('{broken\n'); break;
    case 'sensitiveMalformed': process.stdout.write('secret-protocol-sentinel\n'); break;
    case 'invalid': send({ id: message.id, method: false }); break;
    case 'invalidUtf8': process.stdout.write(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])); break;
    case 'partial': process.stdout.write('{"id":0', () => process.exit(0)); break;
    case 'typedId': send({ id: String(message.id), result: 'wrong' }); send({ id: message.id, result: 'right' }); break;
    case 'duplicate': send({ id: 'same', method: 'approval' }); send({ id: 'same', method: 'approval' }); break;
    case 'oversize': process.stdout.write('中'.repeat(400)); break;
    case 'stderr': process.stderr.write('diagnostic'.repeat(10000)); send({ id: message.id, result: true }); break;
    case 'hang': setInterval(() => {}, 1000); send({ id: message.id, result: true }); break;
    default: send({ id: message.id, result: message.params });
  }
});
