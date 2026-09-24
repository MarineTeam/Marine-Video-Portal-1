// A throwaway redis-server for tests that must run real Redis semantics —
// today, the Lua scripts in lib/ratingScripts.js, whose whole point is what
// Redis does with them and which a mock could only echo back.
//
// Production talks to Upstash over REST; this talks RESP over a socket to a
// local server. The SCRIPT is the unit under test, and Redis runs it the same
// way whichever protocol delivered it. What this cannot prove is Upstash's own
// wire handling of EVAL — that stays on the post-deploy smoke list.
//
// If redis-server is not installed, callers skip — locally. A skipped suite
// is visible in the run summary, but nobody reads CI summaries for a missing
// count, so under CI (the CI env var GitHub Actions sets) `shouldSkip` is
// always false: a runner without redis-server FAILS the suite in startRedis()
// instead of passing it by omission. .github/workflows/ci.yml installs it.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

export const available =
  spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;

export const shouldSkip = !available && !process.env.CI;

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// Parses one RESP value from buf at pos. Returns [value, nextPos] or null when
// the buffer does not yet hold a whole reply.
function parse(buf, pos) {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, eol);
  const after = eol + 2;
  if (type === '+') return [line, after];
  if (type === '-') return [new Error(line), after];
  if (type === ':') return [Number(line), after];
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return [null, after];
    if (buf.length < after + len + 2) return null;
    return [buf.toString('utf8', after, after + len), after + len + 2];
  }
  if (type === '*') {
    const count = Number(line);
    if (count < 0) return [null, after];
    const items = [];
    let p = after;
    for (let i = 0; i < count; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      items.push(r[0]);
      p = r[1];
    }
    return [items, p];
  }
  throw new Error(`Unexpected RESP type ${type}`);
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let buf = Buffer.alloc(0);
    const pending = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parse(buf, 0);
        if (!r) break;
        buf = buf.subarray(r[1]);
        const waiter = pending.shift();
        if (r[0] instanceof Error) waiter.reject(r[0]);
        else waiter.resolve(r[0]);
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      resolve({
        call: (...args) =>
          new Promise((res, rej) => {
            pending.push({ resolve: res, reject: rej });
            socket.write(encode(args));
          }),
        close: () => socket.end(),
      });
    });
  });
}

// Starts a server with no persistence on a random high port and returns a
// client plus stop(). Retries the port a few times in case one is taken.
export async function startRedis() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(
      'redis-server',
      ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'],
      { stdio: 'ignore' }
    );
    // A missing binary arrives as an 'error' event, which would otherwise be
    // unhandled and take the whole run down instead of failing this suite.
    let spawnFailed = false;
    proc.on('error', () => {
      spawnFailed = true;
    });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (spawnFailed || proc.exitCode !== null) break;
      try {
        const client = await connect(port);
        await client.call('PING');
        return {
          client,
          stop: async () => {
            client.close();
            proc.kill();
          },
        };
      } catch {
        // not listening yet
      }
    }
    proc.kill();
  }
  throw new Error('Could not start a local redis-server');
}

// EVAL in the shape Upstash's client takes it: script, keys, args.
export function evalScript(client, script, keys, args) {
  return client.call('EVAL', script, keys.length, ...keys, ...args);
}
