// src/utils/robot_controller.js
export class RobotController {
  constructor(robotIP = process.env.ROBOT_IP || '192.168.1.100', port = 8081, opts = {}) {
    this.baseUrl = `http://${robotIP}:${port}`;
    this.timeoutMs = opts.timeoutMs ?? 1200;
    this.retries = opts.retries ?? 1;
    this.debug = opts.debug ?? false;
  }

  // ---- 내부 유틸: fetch + 타임아웃/재시도 ----
  async _get(path, tm = this.timeoutMs) {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Request timeout')), tm);
    
    try {
      if (this.debug) console.log(`🤖 Robot API: ${url}`);
      
      const res = await fetch(url, { 
        method: 'GET', 
        signal: ac.signal,
        headers: {
          'User-Agent': 'RobotController/1.0'
        }
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      return res;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${tm}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async _retry(fn, label = '') {
    let lastErr;
    for (let i = 0; i <= this.retries; i++) {
      try { 
        return await fn(); 
      } catch (e) { 
        lastErr = e; 
        if (i < this.retries) {
          if (this.debug) console.log(`🤖 Retry ${i + 1}/${this.retries} for ${label}`);
          await new Promise(r => setTimeout(r, 150 * (i + 1))); // 백오프 증가
        }
      }
    }
    throw new Error(`${label} failed: ${lastErr?.message || lastErr}`);
  }

  // ---- Blink API ----
  async toggleBlink() {
    await this._retry(() => this._get('/?blink=toggle'), 'toggleBlink');
    if (this.debug) console.log('🤖 Robot blink toggled');
  }

  async setBlink(on) {
    const state = on ? 'on' : 'off';
    try {
      // 먼저 직접 on/off 시도
      await this._retry(() => this._get(`/?blink=${state}`), 'setBlink');
      if (this.debug) console.log(`🤖 Robot blink ${state}`);
    } catch (error) {
      // 서버가 on/off 미지원시 토글로 폴백
      if (this.debug) console.log('🤖 Falling back to blink toggle');
      await this.toggleBlink();
    }
  }

  // 기존 API 호환성 유지
  async blink() { 
    return this.toggleBlink(); 
  }

  // ---- Tracking API ----
  async toggleTrack() {
    await this._retry(() => this._get('/?track=toggle'), 'toggleTrack');
    if (this.debug) console.log('🤖 Robot tracking toggled');
  }

  async setTrack(on) {
    const state = on ? 'on' : 'off';
    try {
      // 먼저 직접 on/off 시도
      await this._retry(() => this._get(`/?track=${state}`), 'setTrack');
      if (this.debug) console.log(`🤖 Robot tracking ${state}`);
    } catch (error) {
      // 서버가 on/off 미지원시 토글로 폴백
      if (this.debug) console.log('🤖 Falling back to track toggle');
      await this.toggleTrack();
    }
  }

  // 이제 enable 파라미터가 실제로 반영됨
  async track(enable = true) { 
    return this.setTrack(enable); 
  }

  // ---- 상태 확인 ----
  async getStatus() {
    try {
      const res = await this._retry(() => this._get('/status'), 'getStatus');
      const text = await res.text();
      
      // JSON 응답 시도, 실패시 텍스트 반환
      try {
        return JSON.parse(text);
      } catch {
        return { status: text.trim() };
      }
    } catch (error) {
      if (this.debug) console.log('🤖 Status endpoint not available');
      return { error: 'Status not available' };
    }
  }

  // ---- 헬스체크 ----
  async ping() {
    try {
      await this._get('/', 500); // 짧은 타임아웃으로 빠른 체크
      return true;
    } catch {
      return false;
    }
  }

  // ---- 음성 연동용 편의 메서드 ----
  async onSpeechStart() {
    await this.setBlink(true);
    if (this.debug) console.log('🎤 Speech started - blink ON');
  }

  async onSpeechEnd() {
    await this.setBlink(false);
    if (this.debug) console.log('🎤 Speech ended - blink OFF');
  }
}

// 사용 예시:
// const robot = new RobotController('192.168.1.100', 8081, { debug: true });
// await robot.onSpeechStart();  // 말할 때
// await robot.onSpeechEnd();    // 말 끝날 때
