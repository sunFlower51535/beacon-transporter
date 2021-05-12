import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';

import type beaconType from '../src/';
import type { setRetryHeaderPath, setRetryQueueConfig } from '../src/';

declare global {
  interface Window {
    beacon: typeof beaconType;
    setRetryHeaderPath: typeof setRetryHeaderPath;
    setRetryQueueConfig: typeof setRetryQueueConfig;
  }
}

function defer(): [Promise<unknown>, (value: unknown) => void] {
  let resolver: (value: unknown) => void;
  const runningPromise = new Promise((res) => (resolver = res));
  return [runningPromise, resolver];
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.js'), 'utf8')}
self.beacon = beacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
self.setRetryHeaderPath = setRetryHeaderPath;
self.setRetryQueueConfig = setRetryQueueConfig;
`,
};

// FireFox doesn't cap sendBeacon / keepalive fetch string limit
// https://github.com/xg-wang/fetch-keepalive
describe.each(['chromium', 'webkit'].map((t) => [t]))(
  '[%s] beacon persistence',
  (browserName) => {
    const browserType: BrowserType<Browser> = playwright[browserName];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let pageClosed = false;
    let server: any;

    beforeAll(async () => {
      console.log(`Launch ${browserName}`);
      browser = await browserType.launch({});
    });

    afterAll(async () => {
      console.log(`Close ${browserName}`);
      await browser.close();
    });

    beforeEach(async () => {
      pageClosed = false;
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      server = await createTestServer();
      server.get('/', (request, response) => {
        response.end('hi');
      });
      page.on('console', async (msg) => {
        const msgs = [];
        for (let i = 0; i < msg.args().length; ++i) {
          if (pageClosed) break;
          msgs.push(await msg.args()[i].jsonValue());
        }
        console.log(`[${msg.type()}]\t=> ${msg.text()}`);
      });
      await page.goto(server.sslUrl);
      await page.addScriptTag(script);
    });

    afterEach(async () => {
      pageClosed = true;
      await context.close();
      await server.close();
    });

    it('stores beacon data if network having issue, retry on next successful response', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 2) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      let numberOfBeacons = 0;
      await page.route('**/api/*', (route) => {
        // fetch will fallback to keepalive false and try 2nd time
        if (++numberOfBeacons >= 3) {
          console.log('Continue route request');
          return route.continue();
        } else {
          console.log('Abort route request');
          return route.abort();
        }
      });
      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.beacon(`${url}/api/200`, 'hi', {
            retry: { limit: 0, persist: true },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
        },
        [server.sslUrl]
      );
      await serverPromise;
      expect(numberOfBeacons).toBe(4);
      expect(results.length).toBe(2);
      expect(results[1].header).toEqual(JSON.stringify({ attempt: 0 }));
    });

    it('[payload>64kb] stores beacon data if network having issue, retry on next successful response', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 2) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      let numberOfBeacons = 0;
      await page.route('**/api/*', (route) => {
        if (++numberOfBeacons >= 3) {
          console.log('Continue route request');
          return route.continue();
        } else {
          console.log('Abort route request');
          return route.abort();
        }
      });
      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.beacon(`${url}/api/200`, 's'.repeat(65_000), {
            retry: { limit: 0, persist: true },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 's'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
        },
        [server.sslUrl]
      );
      await serverPromise;
      expect(numberOfBeacons).toBe(4);
      expect(results.length).toBe(2);
      expect(results[1].header).toEqual(JSON.stringify({ attempt: 0 }));
    });

    it('retry with reading IDB is throttled with every successful response', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 6) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 2000,
          });
          window.beacon(`${url}/api/429`, 'hi', {
            retry: { limit: 0, persist: true },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 500);
          // waiting, will not trigger retry
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
          // throttling finished, will trigger retry
          // 500 + 2000 (throttle wait) + grace period
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 2600);
        },
        [server.sslUrl]
      );
      await serverPromise;
      expect(results.length).toBe(6);
      expect(results[0].status).toBe(429);
      expect(results[0].header).toBeUndefined;
      expect(results[1].status).toBe(200);
      expect(results[2].header).toEqual(
        JSON.stringify({ attempt: 0, errorCode: 429 })
      );
      expect(results[5].header).toEqual(
        JSON.stringify({ attempt: 1, errorCode: 429 })
      );
    });

    it('[payload>64kb] retry with reading IDB is throttled with every successful response', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 6) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 2000,
          });
          window.beacon(`${url}/api/429`, 'h'.repeat(65_000), {
            retry: { limit: 0, persist: true },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 500);
          // waiting, will not trigger retry
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
          // throttling finished, will trigger retry
          // 500 + 2000 (throttle wait) + grace period
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 2600);
        },
        [server.sslUrl]
      );
      await serverPromise;
      expect(results.length).toBe(6);
      expect(results[0].status).toBe(429);
      expect(results[0].header).toBeUndefined;
      expect(results[1].status).toBe(200);
      expect(results[2].header).toEqual(
        JSON.stringify({ attempt: 0, errorCode: 429 })
      );
      expect(results[5].header).toEqual(
        JSON.stringify({ attempt: 1, errorCode: 429 })
      );
    });

    it('in memory retry statusCode response will not retry', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 3) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 1,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/502`, 'hi', {
            retry: {
              limit: 1,
              persist: true,
              inMemoryRetryStatusCodes: [502],
            },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 2500);
        },
        [server.sslUrl]
      );
      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(3);
      expect(results[0].status).toBe(502);
      expect(results[0].header).toBeUndefined;
      expect(results[1].status).toBe(502);
      expect(results[1].header).toBeUndefined;
      expect(results[2].status).toBe(200);
    });

    it('[payload>64kb] in memory retry statusCode response will not retry', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 3) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 1,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/502`, 'h'.repeat(65_000), {
            retry: {
              limit: 1,
              persist: true,
              inMemoryRetryStatusCodes: [502],
            },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 2500);
        },
        [server.sslUrl]
      );
      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(3);
      expect(results[0].status).toBe(502);
      expect(results[0].header).toBeUndefined;
      expect(results[1].status).toBe(502);
      expect(results[1].header).toBeUndefined;
      expect(results[2].status).toBe(200);
    });

    it('persisting retryable statusCode has attempt limitation', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 6) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/429`, 'hi', {
            retry: {
              limit: 0,
              persist: true,
              persistRetryStatusCodes: [429], // default is [429, 503]
            },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 2000);
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
          }, 3000);
        },
        [server.sslUrl]
      );
      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(6);
      expect(results.map((r) => r.status)).toEqual([
        429,
        200,
        429,
        200,
        429,
        200,
      ]);
    });

    it('[payload>64kb] persisting retryable statusCode has attempt limitation', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 6) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/429`, 'h'.repeat(65_000), {
            retry: {
              limit: 0,
              persist: true,
              persistRetryStatusCodes: [429], // default is [429, 503]
            },
          });
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 1000);
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 2000);
          setTimeout(() => {
            window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
              retry: { limit: 0, persist: true },
            });
          }, 3000);
        },
        [server.sslUrl]
      );
      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(6);
      expect(results.map((r) => r.status)).toEqual([
        429,
        200,
        429,
        200,
        429,
        200,
      ]);
    });

    it('persistent data can be retried on another page', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 3) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/429`, 'hi', {
            retry: {
              limit: 0,
              persist: true,
              persistRetryStatusCodes: [429], // default is [429, 503]
            },
          });
        },
        [server.sslUrl]
      );

      const page2 = await context.newPage();
      await page2.goto(server.sslUrl);
      await page2.addScriptTag(script);
      page2.on('console', async (msg) => {
        const msgs = [];
        for (let i = 0; i < msg.args().length; ++i) {
          if (pageClosed) break;
          msgs.push(await msg.args()[i].jsonValue());
        }
        console.log(`[page-2][${msg.type()}]\t=> ${msg.text()}`);
      });
      await page2.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/200`, 'hi', {
            retry: {
              limit: 0,
            },
          });
        },
        [server.sslUrl]
      );

      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(3);
      expect(results.map((r) => r.status)).toEqual([429, 200, 429]);
    });

    it('[payload>64kb] persistent data can be retried on another page', async () => {
      const [serverPromise, resolver] = defer();
      const results = [];
      let serverCount = 0;
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        console.log(`Received ${++serverCount} request`, payload);
        if (serverCount === 3) {
          resolver(null);
        }
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/429`, 'h'.repeat(65_000), {
            retry: {
              limit: 0,
              persist: true,
              persistRetryStatusCodes: [429], // default is [429, 503]
            },
          });
        },
        [server.sslUrl]
      );

      const page2 = await context.newPage();
      await page2.goto(server.sslUrl);
      await page2.addScriptTag(script);
      page2.on('console', async (msg) => {
        const msgs = [];
        for (let i = 0; i < msg.args().length; ++i) {
          if (pageClosed) break;
          msgs.push(await msg.args()[i].jsonValue());
        }
        console.log(`[page-2][${msg.type()}]\t=> ${msg.text()}`);
      });
      await page2.evaluate(
        ([url]) => {
          window.setRetryHeaderPath('x-retry-context');
          window.setRetryQueueConfig({
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          });
          window.beacon(`${url}/api/200`, 'h'.repeat(65_000), {
            retry: {
              limit: 0,
            },
          });
        },
        [server.sslUrl]
      );

      await serverPromise;
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(results.length).toBe(3);
      expect(results.map((r) => r.status)).toEqual([429, 200, 429]);
    });
  }
);
