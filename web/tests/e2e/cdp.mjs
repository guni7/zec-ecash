// Minimal Chrome DevTools Protocol driver for the devnet browser tests (Node 20:
// node --experimental-websocket; Node >= 22 has WebSocket built in). Uses the local Chrome
// (CHROME=/path overrides), headless, with the devnet's mDNS name mapped to 127.0.0.1.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(profileDir, port = 9333) {
  const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} already has a browser (stale run?)`);
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=420,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let ver;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!ver) throw new Error('chrome did not start');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const browser = new Browser(ws, proc);
  return browser;
}

class Browser {
  constructor(ws, proc) {
    this.ws = ws;
    this.proc = proc;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { res, rej } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else for (const l of this.listeners) l(msg);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  /** Emulate this device in every page opened from now on ('phone' 360x780 or 'desktop' 1280x860). */
  setDevice(device) {
    this.device = device;
  }
  async newContext() {
    return (await this.send('Target.createBrowserContext')).browserContextId;
  }
  async open(url, browserContextId, name = 'page') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', ...(browserContextId && { browserContextId }) });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, name);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    if (this.device) await page.emulate(this.device);
    await page.goto(url);
    return page;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
    this.proc.kill();
  }
}

class Page {
  constructor(browser, sessionId, name) {
    this.b = browser;
    this.s = sessionId;
    this.name = name;
    this.errors = [];
    browser.listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        this.errors.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
    });
  }
  send(method, params) {
    return this.b.send(method, params, this.s);
  }
  async emulate(device) {
    const phone = device === 'phone';
    await this.send('Emulation.setDeviceMetricsOverride', phone ? { width: 360, height: 780, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: phone });
    if (phone) await this.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
  }
  async offline(on) {
    await this.send('Network.enable');
    await this.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30000);
  }
  async reload() {
    await this.send('Page.reload', { ignoreCache: false });
    await sleep(500);
    await this.waitFor('document.readyState === "complete"', 30000);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name} eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, timeout = 60000, onTick) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      if (onTick) await onTick();
      await sleep(500);
    }
    throw new Error(`${this.name}: timed out waiting for ${expression} (last: ${JSON.stringify(last)}); message: ${await this.message()}`);
  }
  message() {
    return this.eval('document.getElementById("message").textContent').catch(() => '?');
  }
  balance() {
    return this.eval('Number(document.getElementById("balance").textContent)');
  }
  async screenshot(path, full = true) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
  }
}
