/** RPC failures must never leak the endpoint URL (which often embeds an API key) and only transient ones are retried. */

import { once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isTransient, scrubSecrets } from '../../src/chain/client';
import { ConnectionError } from '../../src/common/errors';
import { loadConfig } from '../../src/config/load';
import { renderJson } from '../../src/output/json';
import { renderJUnit } from '../../src/output/junit';
import { renderText } from '../../src/output/text';
import { verify } from '../../src/verify';
import { tempDir } from '../helpers';

const SECRET = 'SUPERSECRETKEY0123456789';

type Handler = (method: string) => { status: number; result?: unknown };

async function rpcServer(handler: Handler) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body) as { id: number; method: string };
      requests.push(message.method);
      const { status, result } = handler(message.method);
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`error for key ${SECRET}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v2/${SECRET}?apikey=${SECRET}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BLOCK = {
  number: '0x10',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x65000000',
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  miner: `0x${'00'.repeat(20)}`,
  extraData: '0x',
  baseFeePerGas: '0x1',
  transactions: [],
};

const tmp = tempDir();
afterAll(() => tmp.cleanup());

function config(url: string, retries: number) {
  return loadConfig(
    tmp.write(
      `rpc-${Math.random().toString(36).slice(2)}.yaml`,
      `network:\n  rpc_url: "${url}"\n  chain_id: 1\n  max_retries: ${retries}\ncontracts:\n  T:\n    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3"\n    state:\n      - { type: function_call, function: "totalSupply() returns (uint256)", value: 1 }\n`,
    ),
    { env: {}, roots: [tmp.dir] },
  );
}

it('keeps the URL out of connection errors and does not retry a 401', async () => {
  const rpc = await rpcServer(() => ({ status: 401 }));
  try {
    const error = await verify(config(rpc.url, 3)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    const message = (error as Error).message;
    expect(message).toContain(rpc.host);
    expect(message).not.toContain(SECRET);
    expect((error as Error).stack ?? '').not.toContain(SECRET);
    expect(rpc.requests).toEqual(['eth_chainId']);
  } finally {
    await rpc.close();
  }
});

it('keeps the URL out of check errors in every report format and retries a 500', async () => {
  const rpc = await rpcServer((method) => {
    if (method === 'eth_chainId') return { status: 200, result: '0x1' };
    if (method === 'eth_getBlockByNumber') return { status: 200, result: BLOCK };
    if (method === 'eth_getCode') return { status: 200, result: '0x6000' };
    return { status: 500 };
  });
  try {
    const result = await verify(config(rpc.url, 1));
    expect(result.results[0].status).toBe('error');
    for (const report of [renderText(result), renderJson(result), renderJUnit(result)]) {
      expect(report).not.toContain(SECRET);
    }
    expect(rpc.requests.filter((m) => m === 'eth_call')).toHaveLength(2);
  } finally {
    await rpc.close();
  }
});

it('scrubs keys from URLs, query strings and credentials', () => {
  const url = `https://user:${SECRET}@rpc.example/v3/${SECRET}?key=${SECRET}`;
  const text = `failed (info={ "requestUrl": "${url}", "body": "bad key ${SECRET}" }) at ${url}`;
  const scrubbed = scrubSecrets(text, url);
  expect(scrubbed).not.toContain(SECRET);
  expect(scrubbed).toContain('"requestUrl": "rpc.example"');
});

it('treats client errors as permanent', () => {
  const serverError = (statusCode: number) =>
    Object.assign(new Error('x'), { code: 'SERVER_ERROR', response: { statusCode } });
  expect(isTransient(serverError(401))).toBe(false);
  expect(isTransient(serverError(403))).toBe(false);
  expect(isTransient(serverError(429))).toBe(true);
  expect(isTransient(serverError(503))).toBe(true);
});
