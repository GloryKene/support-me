import { createServer } from 'node:http';

// Browser route mocks cannot intercept Next.js's server-side profile lookup.
createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
    }).end();
    return;
  }

  if (req.url === '/api/creators/alice') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      username: 'alice',
      displayName: 'Alice Creator',
      bio: null,
      avatarUrl: null,
      donationGoal: 100,
    }));
    return;
  }

  res.writeHead(req.url === '/' ? 204 : 404).end();
}).listen(4400, '127.0.0.1');
