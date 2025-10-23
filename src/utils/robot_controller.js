// src/utils/robot_controller.js

// (선택) settings를 동기로 읽고 싶다면 이렇게:
// import settings from '../../settings.js';
// const DEFAULT_BASE = (settings?.robot_base_url) || process.env.ROBOT_BASE_URL || 'http://220.119.231.6:8080';

// 외부에 settings가 없을 수도 있으니, 안전한 폴백만 사용:
const DEFAULT_BASE = process.env.ROBOT_BASE_URL || 'http://220.119.231.6:8080';

export class RobotController {
  constructor(baseUrl = DEFAULT_BASE, opts = {}) {
    // 슬래시 정리
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 800;
    this.retries   = opts.retries   ?? 2;
    this.debug     = opts.debug     ?? false;

    this.connected = false;
    this.lastError = null;

    // 로컬 상태
    this.blinkState = false;
    this.trackState = true;

    // 백오프
    this.consecutiveFailures   = 0;
    this.maxConsecutiveFailures = 3;
    this.backoffTime = 0;

    if (this.debug) console.log(`🤖 RobotController: ${this.baseUrl}`);
  }

  // ----------------- 내부 유틸 -----------------
  async _get(path, tm = this.timeoutMs) {
    // 연속 실패 백오프
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const backoffDelay = Math.min(
        1000 * Math.pow(2, this.consecutiveFailures - this.maxConsecutiveFailures),
        10000
      );
      if (Date.now() < this.backoffTime) {
        throw new Error(
          `Rate limited. Retry after ${Math.ceil((this.backoffTime - Date.now())/1000)}s`
        );
      } else {
        this.backoffTime = Date.now() + backoffDelay;
      }
    }

    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Request timeout')), tm);

    try {
      if (this.debug) console.log(`GET ${url}`);
      const res = await fetch(url, {
        method: 'GET',
        signal: ac.signal,
        headers: {
          'User-Agent': 'RobotController/2.0',
          'Accept': 'application/json, text/html, */*',
          'Cache-Control': 'no-cache',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.consecutiveFailures = 0;
      this.connected = true;
      this.lastError = null;
      return res;
    } catch (err) {
      this.consecutiveFailures++;
      this.connected = false;
      this.lastError = err.message;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.backoffTime =
          Date.now() + 1000 * Math.pow(2, this.consecutiveFailures - this.maxConsecutiveFailures);
      }
      if (err.name === 'AbortError') throw new Error(`Request timeout after ${tm}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _retry(fn, label = '') {
    let lastErr;
    for (let i = 0; i <= this.retries; i++) {
      try {
        const r = await fn();
        if (this.debug && i > 0) console.log(`✔ ${label} retry ${i} ok`);
        return r;
      } catch (e) {
        lastErr = e;
        if (i < this.retries) {
          if (this.debug) console.log(`↻ ${label} retry ${i+1}: ${e.message}`);
          await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
      }
    }
    throw new Error(`${label} failed: ${lastErr?.message || lastErr}`);
  }

  // ----------------- 연결/진단 -----------------
  async ping() { try { await this._get('/', 600); return true; } catch { return false; } }
  async ensureConnection() {
    if (!this.connected) {
      const ok = await this.ping();
      if (!ok) throw new Error(`Robot not reachable at ${this.baseUrl}`);
    }
    return true;
  }

  // 요구 코드가 기대하는 메서드 (복구)
  async healthCheck() {
    const t0 = Date.now();
    const online = await this.ping();
    return {
      online,
      latency: Date.now() - t0,
      status: { blinkMode: this.blinkState, trackMode: this.trackState },
      connection: {
        baseUrl: this.baseUrl,
        connected: this.connected,
        consecutiveFailures: this.consecutiveFailures,
        lastError: this.lastError,
        backoffMs: Math.max(0, this.backoffTime - Date.now()),
      },
    };
  }

  // ----------------- Blink / Track -----------------
  async toggleBlink() { await this.ensureConnection(); await this._retry(() => this._get('/?blink=toggle'), 'toggleBlink'); this.blinkState = !this.blinkState; }
  async setBlink(on)   { await this.ensureConnection(); if (this.blinkState !== on) await this.toggleBlink(); }

  async toggleTrack() { await this.ensureConnection(); await this._retry(() => this._get('/?track=toggle'), 'toggleTrack'); this.trackState = !this.trackState; }
  async setTrack(on)  { await this.ensureConnection(); if (this.trackState !== on) await this.toggleTrack(); }

  async getStatus() {
    try {
      await this.ensureConnection();
      return { blinkMode: this.blinkState, trackMode: this.trackState, connected: this.connected };
    } catch {
      return { error: 'Status not available', lastError: this.lastError, connected: this.connected,
               blinkMode: this.blinkState, trackMode: this.trackState };
    }
  }

  async onSpeechStart(){ try{ await this.setBlink(true);  if (this.debug) console.log('🎤 blink ON'); return true; } catch { return false; } }
  async onSpeechEnd(){   try{ await this.setBlink(false); if (this.debug) console.log('🎤 blink OFF'); return true; } catch { return false; } }

  // ----------------- 모션 -----------------
  async sendMotion(page){ await this.ensureConnection(); await this._retry(() => this._get(`/?motion=${page}`), `sendMotion(${page})`); }
  async waveHand(){ return this.sendMotion(38); }
  async applaud(){  return this.sendMotion(24); }
  async tiltHi(){   return this.sendMotion(4);  }
  async talk1(){    return this.sendMotion(6);  }
  async talk2(){    return this.sendMotion(29); }
  async rightKick(){return this.sendMotion(12); }
  async leftKick(){ return this.sendMotion(13); }
  async rightPass(){return this.sendMotion(70); }
  async leftPass(){ return this.sendMotion(71); }
  async nodYes(){   return this.sendMotion(2);  }
  async shakeNo(){  return this.sendMotion(3);  }
  async armYes(){   return this.sendMotion(23); }
  async armHeadYes(){return this.sendMotion(27);}
  async stretch(){  return this.sendMotion(31); }
  async jump(){     return this.sendMotion(237);}
  async quickJump(){return this.sendMotion(239);}

  // ----------------- /info & /camera -----------------
  async getInfo() {
    await this.ensureConnection();
    const res = await this._retry(() => this._get('/info', this.timeoutMs), 'getInfo');
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  }

  async fetchCameraBuffer({ timeoutMs } = {}) {
    await this.ensureConnection();
    const t = timeoutMs ?? this.timeoutMs;
    const res = await this._retry(() => this._get(`/camera?t=${Date.now()}`, t), 'fetchCameraBuffer');
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  async downloadFrame(filePath, opts = {}) {
    const buf = await this.fetchCameraBuffer(opts);
    const fs = await import('fs/promises');
    await fs.writeFile(filePath, buf);
    return { filePath, bytes: buf.length };
  }
}

// ✅ 동기 팩토리 (Promise 아님)
export function createRobotController(opts = {}) {
  const baseUrl =
    opts.baseUrl ||
    process.env.ROBOT_BASE_URL ||
    'http://220.119.231.6:8080';

  return new RobotController(baseUrl, {
    debug: opts.debug ?? (process.env.NODE_ENV === 'development'),
    timeoutMs: opts.timeoutMs ?? 800,
    retries:   opts.retries   ?? 2,
    ...opts,
  });
}

// ⚙️ 호환성: default export도 제공 (import rc from ... / rc.createRobotController())
const defaultExport = { RobotController, createRobotController };
export default defaultExport;
