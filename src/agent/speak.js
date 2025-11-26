// src/agent/speak.js
// ============================================================
// TTS MODULE - Uses centralized RobotService from mind_server
// ============================================================

import { exec, spawn } from 'child_process';
import { sendAudioRequest } from '../models/pollinations.js';
import textToSpeech from '@google-cloud/text-to-speech';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import fs from 'fs';

// Import centralized RobotService from mind_server
import { getRobotService } from '../server/mind_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ttsEvents = new EventEmitter();

let speakingQueue = [];
let isSpeaking = false;

// Google TTS client (singleton)
let googleTTSClient = null;

function getGoogleTTSClient() {
  if (!googleTTSClient) {
    try {
      const credentialsPath = path.resolve(process.cwd(), 'google-credentials.json');
      
      if (fs.existsSync(credentialsPath)) {
        console.log(`✅ [Google TTS] Loading credentials from: ${credentialsPath}`);
        googleTTSClient = new textToSpeech.TextToSpeechClient({
          keyFilename: credentialsPath
        });
      } else {
        console.warn(`⚠️ [Google TTS] Credentials file not found at: ${credentialsPath}`);
        console.warn(`⚠️ [Google TTS] Falling back to default credentials (environment variable)`);
        googleTTSClient = new textToSpeech.TextToSpeechClient();
      }
    } catch (error) {
      console.error(`❌ [Google TTS] Failed to initialize client:`, error.message);
      throw error;
    }
  }
  return googleTTSClient;
}

// ============================================================
// ROBOT LED CONTROL - Via Centralized RobotService
// Blink control does NOT require lock (TTS should always work)
// ============================================================

async function safeSpeechStart() {
  try {
    const robot = getRobotService();
    await robot.onSpeechStart();
    console.log(`🎤 [TTS] Speech started - robot blink ON`);
  } catch (e) {
    console.warn('[TTS] onSpeechStart failed:', e?.message || e);
  }
}

async function safeSpeechEnd() {
  try {
    const robot = getRobotService();
    await robot.onSpeechEnd();
    console.log(`🎤 [TTS] Speech ended - robot blink OFF`);
  } catch (e) {
    console.warn('[TTS] onSpeechEnd failed:', e?.message || e);
  }
}

/**
 * Google Cloud TTS
 * @param {string} text - Text to speak
 * @param {string} voice - Voice (ko-KR-Neural2-A, etc.)
 * @param {string} languageCode - Language code (ko-KR, en-US, etc.)
 * @returns {Promise<Buffer>} - MP3 audio data
 */
async function sendGoogleTTS(text, voice = 'ko-KR-Neural2-A', languageCode = 'ko-KR') {
  try {
    const client = getGoogleTTSClient();
    
    console.log(`🎤 [Google TTS] Generating speech (voice: ${voice}, language: ${languageCode})`);
    
    const request = {
      input: { text: text },
      voice: {
        languageCode: languageCode,
        name: voice,
        ssmlGender: voice.includes('-A') || voice.includes('-B') ? 'FEMALE' : 'MALE'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
        pitch: 0.0,
        volumeGainDb: 0.0
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    const audioBuffer = Buffer.from(response.audioContent);
    
    console.log(`✅ [Google TTS] Generated ${audioBuffer.length} bytes`);
    return audioBuffer;
    
  } catch (err) {
    console.error('[Google TTS] Error:', err.message);
    throw err;
  }
}

/**
 * Text-to-Speech with queue.
 * Commands (!로 시작하는 부분) are filtered out
 * @param {string} text
 * @param {string|object} speak_model e.g. 'google/ko-KR-Neural2-A' or 'pollinations/openai-audio/echo'
 * @returns {Promise<void>}
 */
export function say(text, speak_model) {
  return new Promise((resolve, reject) => {
    // Filter out commands (!로 시작하는 부분)
    const cleanText = text.replace(/![\w]+\([^)]*\)/g, '').trim();
    
    // Empty text = done
    if (!cleanText) {
      console.log(`🔇 [TTS] No text to speak after command filtering`);
      resolve();
      return;
    }
    
    console.log(`🎤 [TTS] Original: "${text}"`);
    console.log(`🎤 [TTS] Speaking: "${cleanText}"`);
    
    speakingQueue.push({ text: cleanText, speak_model, resolve, reject });
    if (!isSpeaking) processQueue();
  });
}

async function processQueue() {
  if (speakingQueue.length === 0) {
    isSpeaking = false;
    global.isTTSPlaying = false;
    ttsEvents.emit('speaking-ended');
    return;
  }
  isSpeaking = true;
  
  global.isTTSPlaying = true;
  ttsEvents.emit('speaking-started');

  const job = speakingQueue.shift();
  const txt = job.text;
  const speak_model = job.speak_model;
  const resolve = job.resolve;
  const reject = job.reject;

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const model = speak_model || 'google/ko-KR-Neural2-A';

  // Start event & LED
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
    // --- Parse model string ---
    let prov, voice, languageCode, url;
    if (typeof model === "string") {
      const parts = model.split('/');
      prov = parts[0];
      voice = parts[1];
      languageCode = parts[2] || (voice ? voice.split('-').slice(0, 2).join('-') : 'ko-KR');
    } else {
      prov = model.api;
      voice = model.voice;
      languageCode = model.languageCode || 'ko-KR';
      url = model.url;
    }

    // --- Google Cloud TTS ---
    if (prov === 'google') {
      try {
        const audioBuffer = await sendGoogleTTS(txt, voice, languageCode);
        
        const tempFile = path.join(__dirname, `tts_temp_${Date.now()}.mp3`);
        
        try {
          fs.writeFileSync(tempFile, audioBuffer);
          
          const player = spawn('ffplay', [
            '-nodisp',
            '-autoexit',
            '-loglevel', 'quiet',
            tempFile
          ], {
            stdio: 'ignore'
          });
          
          player.on('exit', async (code) => { 
            try { fs.unlinkSync(tempFile); } catch {}
            if (code === 0) await finishOk();
            else await finishErr(new Error(`ffplay exit ${code}`));
          });
          
          player.on('error', async (e) => { 
            console.error('[TTS] ffplay error:', e.message);
            try { fs.unlinkSync(tempFile); } catch {}
            await finishErr(e); 
          });
          
        } catch (e) {
          try { fs.unlinkSync(tempFile); } catch {}
          await finishErr(e);
        }

      } catch (e) {
        console.error('Google TTS error', e);
        await finishErr(e);
      }

    // --- Pollinations TTS ---
    } else if (prov === 'pollinations') {
      url = url || "https://text.pollinations.ai/openai";
      
      try {
        let audioData = await sendAudioRequest(txt, voice, null, url);
        if (!audioData) {
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
          const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
            stdio: ['pipe','ignore','ignore']
          });
          player.stdin.write(Buffer.from(audioData, 'base64'));
          player.stdin.end();
          player.on('exit', async (code) => { 
            if (code === 0) await finishOk(); 
            else await finishErr(new Error(`ffplay exit ${code}`));
          });
          player.on('error', async (e) => { 
            console.error('ffplay spawn error', e); 
            await finishErr(e); 
          });
        }

      } catch (e) {
        console.error('Pollinations TTS error', e);
        await finishErr(e);
      }

    } else {
      await finishErr(new Error(`Unknown TTS provider: ${prov}`));
    }
  }
}

// ============================================================
// MANUAL ROBOT CONTROL FUNCTIONS (via centralized RobotService)
// These are for external direct calls, not TTS-related
// ============================================================

export async function robotBlinkOn() {
  try {
    const robot = getRobotService();
    await robot.setBlink(true);
    console.log('🤖 [Manual] Robot blink ON');
  } catch (e) {
    console.warn('[Manual] robotBlinkOn failed:', e?.message || e);
  }
}

export async function robotBlinkOff() {
  try {
    const robot = getRobotService();
    await robot.setBlink(false);
    console.log('🤖 [Manual] Robot blink OFF');
  } catch (e) {
    console.warn('[Manual] robotBlinkOff failed:', e?.message || e);
  }
}

export async function robotToggleBlink() {
  try {
    const robot = getRobotService();
    await robot.toggleBlink();
    console.log('🤖 [Manual] Robot blink toggled');
  } catch (e) {
    console.warn('[Manual] robotToggleBlink failed:', e?.message || e);
  }
}

export async function getRobotStatus() {
  try {
    const robot = getRobotService();
    const status = await robot.getStatus();
    console.log('🤖 [Manual] Robot status:', status);
    return status;
  } catch (e) {
    console.warn('[Manual] getRobotStatus failed:', e?.message || e);
    return null;
  }
}
