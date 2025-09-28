import { exec, spawn } from 'child_process';
import { sendAudioRequest } from '../models/pollinations.js';
import { EventEmitter } from 'events';
import { createRobotController } from '../utils/robot_controller.js';

export const ttsEvents = new EventEmitter();

let speakingQueue = [];
let isSpeaking = false;

// --- 로봇 컨트롤러 인스턴스 관리 (speak.js에서 직접) ---
let robotController = null;
let robotInitialized = false;

async function initRobotController() {
  if (robotInitialized) return robotController;
  
  robotInitialized = true;
  
  try {
    robotController = createRobotController({ 
      debug: true,
      timeoutMs: 600,
      retries: 1 
    });
    
    // 헬스체크로 연결 확인
    const health = await robotController.healthCheck();
    if (health.online) {
      console.log(`🤖 [TTS] Robot controller connected (latency: ${health.latency}ms)`);
      return robotController;
    } else {
      console.warn(`🤖 [TTS] Robot controller offline: ${health.error || 'unknown error'}`);
      robotController = null;
      return null;
    }
  } catch (error) {
    console.warn(`🤖 [TTS] Failed to initialize robot controller:`, error.message);
    robotController = null;
    return null;
  }
}

// --- 로봇 LED 제어 함수들 ---
async function safeSpeechStart() {
  try {
    const robot = robotController || await initRobotController();
    if (robot?.onSpeechStart) {
      await robot.onSpeechStart();
      console.log(`🎤 [TTS] Speech started - robot blink ON`);
    }
  } catch (e) { 
    console.warn('[TTS] onSpeechStart failed:', e?.message || e); 
  }
}

async function safeSpeechEnd() {
  try {
    const robot = robotController || await initRobotController();
    if (robot?.onSpeechEnd) {
      await robot.onSpeechEnd();
      console.log(`🎤 [TTS] Speech ended - robot blink OFF`);
    }
  } catch (e) { 
    console.warn('[TTS] onSpeechEnd failed:', e?.message || e); 
  }
}

/**
 * Text-to-Speech with queue.
 * Keeps API compat with previous usage but now returns a Promise that resolves when playback finishes.
 * @param {string} text
 * @param {string|object} speak_model e.g. 'pollinations/openai-audio/echo'
 * @returns {Promise<void>}
 */
export function say(text, speak_model) {
  return new Promise((resolve, reject) => {
    speakingQueue.push({ text, speak_model, resolve, reject });
    if (!isSpeaking) processQueue();
  });
}

async function processQueue() {
  if (speakingQueue.length === 0) {
    isSpeaking = false;
    return;
  }
  isSpeaking = true;

  const job = speakingQueue.shift();
  const txt = job.text;
  const speak_model = job.speak_model;
  const resolve = job.resolve;
  const reject = job.reject;

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const model = speak_model || 'pollinations/openai-audio/echo';

  // 공통: 시작 이벤트/LED
  try { ttsEvents.emit('start', { text: txt, model }); } catch {}
  await safeSpeechStart();

  const finishOk = async () => {
    try { ttsEvents.emit('end', { text: txt, model }); } catch {}
    await safeSpeechEnd();
    resolve?.();
    processQueue();
  };
  const finishErr = async (err) => {
    try { ttsEvents.emit('error', err); } catch {}
    await safeSpeechEnd();
    reject?.(err);
    processQueue();
  };

  if (model === 'system') {
    // --- System TTS (Windows/macOS/Linux) ---
    const cmd = isWin
      ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; `
        + `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; `
        + `$s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
      : isMac
      ? `say "${txt.replace(/"/g,'\\"')}"`
      : `espeak "${txt.replace(/"/g,'\\"')}"`;

    exec(cmd, async (err) => {
      if (err) {
        console.error('TTS error', err);
        await finishErr(err);
      } else {
        await finishOk();
      }
    });

  } else {
    // --- Remote audio provider (Pollinations/OpenAI proxy) ---
    let prov, mdl, voice, url;
    if (typeof model === "string") {
      [prov, mdl, voice] = model.split('/');
      url = "https://text.pollinations.ai/openai";
    } else {
      prov  = model.api;
      mdl   = model.model;
      voice = model.voice;
      url   = model.url || "https://text.pollinations.ai/openai";
    }
    if (prov !== 'pollinations') {
      await finishErr(new Error(`Unknown provider: ${prov}`));
      return;
    }

    try {
      let audioData = await sendAudioRequest(txt, mdl, voice, url);
      if (!audioData) {
        // 0s silence fallback
        audioData = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA/+NAwAAAAAAAAAAAAEluZm8AAAAPAAAAAAAAANAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAExhdmM1OS4zNwAAAAAAAAAAAAAAAAAAAAAAAAAAAADQAAAeowAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
      }

      if (isWin) {
        const ps = `
          Add-Type -AssemblyName presentationCore;
          $p=New-Object System.Windows.Media.MediaPlayer;
          $p.Open([Uri]::new("data:audio/mp3;base64,${audioData}"));
          $p.Play();
          Start-Sleep -Seconds [math]::Ceiling($p.NaturalDuration.TimeSpan.TotalSeconds);
        `;
        const psProcess = spawn('powershell', ['-NoProfile','-Command', ps], {
          stdio: 'ignore', detached: true
        });
        psProcess.on('exit', async () => { await finishOk(); });

      } else {
        // ffplay 경로
        const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
          stdio: ['pipe','ignore','ignore']
        });
        player.stdin.write(Buffer.from(audioData, 'base64'));
        player.stdin.end();
        player.on('exit', async (code) => { 
          if (code === 0) await finishOk(); else await finishErr(new Error(`ffplay exit ${code}`));
        });
        player.on('error', async (e) => { 
          console.error('ffplay spawn error', e); 
          await finishErr(e); 
        });
      }

    } catch (e) {
      console.error('Audio error', e);
      await finishErr(e);
    }
  }
}

// --- 수동 로봇 제어 함수들 (외부에서 직접 호출 가능) ---
export async function robotBlinkOn() {
  try {
    const robot = robotController || await initRobotController();
    if (robot) {
      await robot.setBlink(true);
      console.log('🤖 [Manual] Robot blink ON');
    }
  } catch (e) {
    console.warn('[Manual] robotBlinkOn failed:', e?.message || e);
  }
}

export async function robotBlinkOff() {
  try {
    const robot = robotController || await initRobotController();
    if (robot) {
      await robot.setBlink(false);
      console.log('🤖 [Manual] Robot blink OFF');
    }
  } catch (e) {
    console.warn('[Manual] robotBlinkOff failed:', e?.message || e);
  }
}

export async function robotToggleBlink() {
  try {
    const robot = robotController || await initRobotController();
    if (robot) {
      await robot.toggleBlink();
      console.log('🤖 [Manual] Robot blink toggled');
    }
  } catch (e) {
    console.warn('[Manual] robotToggleBlink failed:', e?.message || e);
  }
}

export async function getRobotStatus() {
  try {
    const robot = robotController || await initRobotController();
    if (robot) {
      const status = await robot.getStatus();
      console.log('🤖 [Manual] Robot status:', status);
      return status;
    }
    return null;
  } catch (e) {
    console.warn('[Manual] getRobotStatus failed:', e?.message || e);
    return null;
  }
}
