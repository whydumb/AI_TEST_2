// src/utils/robot_controller.js
export class RobotController {
  constructor(robotIP = process.env.ROBOT_IP || 'localhost', port = process.env.ROBOT_PORT || 8081, opts = {}) {
    this.baseUrl = `http://${robotIP}:${port}`;
    this.timeoutMs = opts.timeoutMs ?? 800;
    this.retries = opts.retries ?? 2;
    this.debug = opts.debug ?? false;
    this.connected = false;
    this.lastError = null;
    
    // 상태 캐싱으로 불필요한 요청 방지
    this.cachedStatus = null;
    this.statusCacheTime = 0;
    this.statusCacheTTL = 5000; // 5초
    
    // 연속 실패 방지
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
    this.backoffTime = 0;
    
    if (this.debug) {
      console.log(`🤖 RobotController initialized: ${this.baseUrl}`);
    }
  }

  // ---- 내부 유틸: fetch + 타임아웃/재시도/백오프 ----
  async _get(path, tm = this.timeoutMs) {
    // 연속 실패 시 백오프
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const backoffDelay = Math.min(1000 * Math.pow(2, this.consecutiveFailures - this.maxConsecutiveFailures), 10000);
      if (Date.now() < this.backoffTime) {
        throw new Error(`Rate limited due to consecutive failures. Retry after ${Math.ceil((this.backoffTime - Date.now()) / 1000)}s`);
      }
    }

    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Request timeout')), tm);
    
    try {
      if (this.debug) console.log(`🤖 Robot API: ${url}`);
      
      const res = await fetch(url, { 
        method: 'GET', 
        signal: ac.signal,
        headers: {
          'User-Agent': 'RobotController/2.0',
          'Accept': 'application/json, text/html, */*',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      // 성공 시 실패 카운터 리셋
      this.consecutiveFailures = 0;
      this.connected = true;
      this.lastError = null;
      
      return res;
    } catch (error) {
      // 실패 처리
      this.consecutiveFailures++;
      this.connected = false;
      this.lastError = error.message;
      
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.backoffTime = Date.now() + (1000 * Math.pow(2, this.consecutiveFailures - this.maxConsecutiveFailures));
      }
      
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
        const result = await fn();
        if (this.debug && i > 0) {
          console.log(`🤖 ${label} succeeded on retry ${i}`);
        }
        return result;
      } catch (e) { 
        lastErr = e; 
        if (i < this.retries) {
          if (this.debug) console.log(`🤖 Retry ${i + 1}/${this.retries} for ${label}: ${e.message}`);
          await new Promise(r => setTimeout(r, 200 * (i + 1))); // 증가하는 백오프
        }
      }
    }
    if (this.debug) {
      console.warn(`🤖 ${label} failed after ${this.retries + 1} attempts: ${lastErr?.message}`);
    }
    throw new Error(`${label} failed: ${lastErr?.message || lastErr}`);
  }

  // ---- 연결 상태 관리 ----
  async ping() {
    try {
      await this._get('/', 600); // 짧은 타임아웃으로 빠른 체크
      return true;
    } catch {
      return false;
    }
  }

  async ensureConnection() {
    if (!this.connected) {
      const isOnline = await this.ping();
      if (!isOnline) {
        throw new Error(`Robot not reachable at ${this.baseUrl}`);
      }
    }
    return true;
  }

  // ---- Blink API (개선된 상태 관리) ----
  async toggleBlink() {
    await this.ensureConnection();
    await this._retry(() => this._get('/?blink=toggle'), 'toggleBlink');
    if (this.debug) console.log('🤖 Robot blink toggled');
    this._invalidateStatusCache(); // 상태 캐시 무효화
  }

  async setBlink(on) {
    await this.ensureConnection();
    const state = on ? 'on' : 'off';
    
    try {
      await this._retry(() => this._get(`/?blink=${state}`), 'setBlink');
      if (this.debug) console.log(`🤖 Robot blink ${state}`);
    } catch (error) {
      // 폴백: 토글 방식으로 시도
      if (this.debug) console.log('🤖 Direct blink control failed, trying toggle method');
      
      // 현재 상태 확인 후 필요시 토글
      try {
        const status = await this.getStatus();
        const currentBlink = status?.blinkMode ?? false;
        
        if (currentBlink !== on) {
          await this.toggleBlink();
        } else {
          if (this.debug) console.log(`🤖 Blink already in desired state: ${state}`);
        }
      } catch (statusError) {
        // 상태 확인도 실패하면 그냥 토글 시도
        if (this.debug) console.log('🤖 Status check failed, attempting blind toggle');
        await this.toggleBlink();
      }
    }
    
    this._invalidateStatusCache();
  }

  // ---- Tracking API ----
  async toggleTrack() {
    await this.ensureConnection();
    await this._retry(() => this._get('/?track=toggle'), 'toggleTrack');
    if (this.debug) console.log('🤖 Robot tracking toggled');
    this._invalidateStatusCache();
  }

  async setTrack(on) {
    await this.ensureConnection();
    const state = on ? 'on' : 'off';
    
    try {
      await this._retry(() => this._get(`/?track=${state}`), 'setTrack');
      if (this.debug) console.log(`🤖 Robot tracking ${state}`);
    } catch (error) {
      // 폴백: 토글 방식
      if (this.debug) console.log('🤖 Direct track control failed, trying toggle method');
      
      try {
        const status = await this.getStatus();
        const currentTrack = status?.trackMode ?? false;
        
        if (currentTrack !== on) {
          await this.toggleTrack();
        } else {
          if (this.debug) console.log(`🤖 Tracking already in desired state: ${state}`);
        }
      } catch (statusError) {
        if (this.debug) console.log('🤖 Status check failed, attempting blind toggle');
        await this.toggleTrack();
      }
    }
    
    this._invalidateStatusCache();
  }

  // ---- 상태 확인 (캐싱 포함) ----
  _invalidateStatusCache() {
    this.cachedStatus = null;
    this.statusCacheTime = 0;
  }

  async getStatus(useCache = true) {
    // 캐시 확인
    if (useCache && this.cachedStatus && (Date.now() - this.statusCacheTime) < this.statusCacheTTL) {
      return this.cachedStatus;
    }

    try {
      await this.ensureConnection();
      const res = await this._retry(() => this._get('/status'), 'getStatus');
      const text = await res.text();
      
      let status;
      try {
        status = JSON.parse(text);
      } catch {
        status = { status: text.trim(), raw: true };
      }
      
      // 캐시 업데이트
      this.cachedStatus = status;
      this.statusCacheTime = Date.now();
      
      return status;
    } catch (error) {
      if (this.debug) console.log('🤖 Status endpoint not available:', error.message);
      return { 
        error: 'Status not available', 
        lastError: this.lastError,
        connected: this.connected 
      };
    }
  }

  // ---- 음성 연동용 편의 메서드 (안전한 실행) ----
  async onSpeechStart() {
    try {
      await this.setBlink(true);
      if (this.debug) console.log('🎤 Speech started - blink ON');
      return true;
    } catch (error) {
      if (this.debug) console.warn('🎤 Failed to set blink ON:', error.message);
      return false;
    }
  }

  async onSpeechEnd() {
    try {
      await this.setBlink(false);
      if (this.debug) console.log('🎤 Speech ended - blink OFF');
      return true;
    } catch (error) {
      if (this.debug) console.warn('🎤 Failed to set blink OFF:', error.message);
      return false;
    }
  }

  // ---- 유틸리티 메서드 ----
  getConnectionInfo() {
    return {
      baseUrl: this.baseUrl,
      connected: this.connected,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      backoffTime: this.backoffTime > Date.now() ? this.backoffTime - Date.now() : 0
    };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      const isOnline = await this.ping();
      const latency = Date.now() - start;
      
      let status = null;
      if (isOnline) {
        try {
          status = await this.getStatus(false); // 캐시 무시하고 새로 가져오기
        } catch (e) {
          // 상태 가져오기 실패해도 ping은 성공했으므로 기본 연결은 OK
        }
      }
      
      return {
        online: isOnline,
        latency: latency,
        status: status,
        connection: this.getConnectionInfo()
      };
    } catch (error) {
      return {
        online: false,
        latency: Date.now() - start,
        error: error.message,
        connection: this.getConnectionInfo()
      };
    }
  }

  // ---- 레거시 API 호환성 ----
  async blink() { 
    return this.toggleBlink(); 
  }

  async track(enable = true) { 
    return this.setTrack(enable); 
  }
}

// 팩토리 함수: 환경에 맞는 기본 인스턴스 생성
export function createRobotController(opts = {}) {
  const robotIP = opts.robotIP || process.env.ROBOT_IP || 'localhost';
  const robotPort = opts.robotPort || process.env.ROBOT_PORT || 8081;
  const debug = opts.debug ?? (process.env.NODE_ENV === 'development');
  
  return new RobotController(robotIP, robotPort, { 
    debug,
    timeoutMs: 800,
    retries: 2,
    ...opts 
  });
}
