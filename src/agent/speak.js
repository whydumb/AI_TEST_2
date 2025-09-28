import { exec, spawn } from 'child_process';
import { sendAudioRequest } from '../models/pollinations.js';
import { EventEmitter } from 'events';

export const ttsEvents = new EventEmitter();

let speakingQueue = [];
let isSpeaking = false;

// --- Robot LED hooks (agent.js 수정 없이 전역 참조) ---
function getRobot() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : null);
    const agent = g?.agent;
    return agent?.robot ?? null;
  } catch { return null; }
}

async function safeSpeechStart() {
  const robot = getRobot();
  if (robot?.onSpeechStart) {
    try { await robot.onSpeechStart(); } catch (e) { console.warn('[speak] onSpeechStart failed:', e?.message || e); }
  }
}
async function safeSpeechEnd() {
  const robot = getRobot();
  if (robot?.onSpeechEnd) {
    try { await robot.onSpeechEnd(); } catch (e) { console.warn('[speak] onSpeechEnd failed:', e?.message || e); }
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
