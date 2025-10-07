// src/agent/vision/vision_interpreter.js
import fs from 'fs/promises';
import path from 'path';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ✅ settings.js 없어도 동작하도록 기본값
const defaultSettings = {
  use_real_camera: true,
  camera_device: 'Integrated Camera', // Windows dshow 기본 장치명 가정
};

export class VisionInterpreter {
  constructor(agent, vision_mode) {
    this.agent = agent;
    this.vision_mode = vision_mode;
    this.fp = `./bots/${agent.name}/screenshots`;

    this._ensureDirectory();

    if (this.vision_mode !== 'off') {
      this.camera = {
        capture: async () => {
          const settings = await this._getSettings();
          if (settings.use_real_camera) {
            return await this.captureFromWebcam(settings.camera_device || undefined);
          }
          return await this.getLatestImage();
        },
      };
      console.log('📸 Vision interpreter initialized with camera support');
    }
  }

  // ---------------- utils ----------------
  async _getSettings() {
    let settings = defaultSettings;
    try {
      const mod = await import('../../../settings.js');
      settings = { ...defaultSettings, ...(mod.default || mod) };
    } catch {
      console.warn('⚠️ settings.js not found; using defaults');
    }
    if (settings.use_real_camera == null) settings.use_real_camera = defaultSettings.use_real_camera;
    if (!settings.camera_device) settings.camera_device = defaultSettings.camera_device;
    return settings;
  }

  async _ensureDirectory() {
    try { await fs.mkdir(this.fp, { recursive: true }); }
    catch (e) { console.error('Failed to create screenshots directory:', e); }
  }

  async _which(cmd) {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    try { await execAsync(probe); return true; } catch { return false; }
  }

  async _ensureNonEmptyFile(filepath) {
    await fs.access(filepath);
    const stats = await fs.stat(filepath);
    if (!stats.isFile()) throw new Error('Captured path is not a file');
    if (stats.size === 0) throw new Error('Captured file is empty');
    return stats.size;
  }

  async _maybeCaptureIfEmpty() {
    const latest = await this.getLatestImage();
    if (latest) return latest;
    const settings = await this._getSettings();
    if (settings.use_real_camera) {
      console.log('📸 No images found. Capturing a new snapshot…');
      const shot = await this.captureFromWebcam(settings.camera_device);
      return shot ?? null;
    }
    return null;
  }

  // ---------------- webcam (Windows/macOS 전용) ----------------
  /**
   * Capture one frame from webcam to JPEG
   * @returns {Promise<string|null>} saved filename or null
   */
  async captureFromWebcam() {
    if (this.vision_mode === 'off') return 'Vision is disabled.';

    await this._ensureDirectory();
    const timestamp = Date.now();
    const filename = `webcam_${timestamp}.jpg`;
    const filepath = path.join(this.fp, filename);

    try {
      if (process.platform === 'win32') {
        await this._captureWebcamWindows(filepath);
      } else if (process.platform === 'darwin') {
        await this._captureWebcamMac(filepath);
      } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }

      const bytes = await this._ensureNonEmptyFile(filepath);
      console.log(`📸 Webcam capture saved: ${filename} (${(bytes/1024).toFixed(1)} KB)`);
      return filename;

    } catch (error) {
      console.error('Webcam capture failed:', error.message);
      const latest = await this.getLatestImage();
      if (latest) return latest;
      return null;
    }
  }

  // Windows: node-webcam(가능하면) → ffmpeg(dshow, JPEG 강제)
  async _captureWebcamWindows(filepath) {
    // 1) node-webcam
    try {
      const nodeWebcam = await import('node-webcam').then(m => m.default ?? m);
      const Webcam = nodeWebcam.create({
        width: 1280, height: 720, quality: 100, saveShots: true, output: 'jpeg',
        device: false, callbackReturn: 'location', verbose: false,
      });
      await new Promise((resolve, reject) => {
        Webcam.capture(filepath, (err) => (err ? reject(err) : resolve()));
      });
      return;
    } catch (e) {
      console.warn('node-webcam not available on Windows, falling back to ffmpeg:', e?.message);
    }

    // 2) ffmpeg(dshow → JPEG 강제 인코딩)
    const hasFFmpeg = await this._which('ffmpeg');
    if (!hasFFmpeg) throw new Error('Neither node-webcam nor ffmpeg is available on Windows');

    const settings = await this._getSettings();
    const deviceName = settings?.camera_device || 'Integrated Camera';

    const args = [
      '-y',
      '-f', 'dshow',
      '-i', `video=${deviceName}`,
      '-frames:v', '1',
      '-f', 'image2',
      '-vcodec', 'mjpeg', // ✅ 실제 JPEG 보장
      '-q:v', '2',
      filepath,
    ];
    await execFileAsync('ffmpeg', args, { windowsHide: true });
  }

  // macOS: imagesnap (기본 JPG)
  async _captureWebcamMac(filepath) {
    const hasImageSnap = await this._which('imagesnap');
    if (!hasImageSnap) throw new Error('imagesnap is not installed on macOS (brew install imagesnap)');
    await execFileAsync('imagesnap', [filepath]);
  }

  // ---------------- analysis ----------------
  async analyzeImage(filename, prompt = 'Describe what you see in this image.') {
    if (!filename) return 'Error: No filename provided.';
    const filepath = path.join(this.fp, filename);
    try {
      const buf = await fs.readFile(filepath);
      if (!buf || buf.length === 0) return `Error: Image file '${filename}' is empty.`;
      console.log(`📸 Analyzing image: ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(buf, prompt);
    } catch (error) {
      if (error.code === 'ENOENT') return `Error: Image file '${filename}' not found in ${this.fp}`;
      console.error('Failed to analyze image:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  async analyzeBuffer(imageBuffer, prompt = 'Describe what you see in this image.') {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    try {
      if (!imageBuffer || imageBuffer.length === 0) throw new Error('Empty image buffer');
      console.log(`📸 Analyzing image buffer (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(imageBuffer, prompt);
    } catch (error) {
      console.error('Failed to analyze image buffer:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  // ---------------- file helpers ----------------
  async listImages() {
    try {
      await this._ensureDirectory();
      const files = await fs.readdir(this.fp);
      return files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    } catch (error) {
      console.error('Failed to list images:', error);
      return [];
    }
  }

  async getLatestImage() {
    try {
      const files = await this.listImages();
      if (files.length === 0) {
        console.warn(`📸 No images found in ${this.fp}`);
        return null;
      }
      const filesWithStats = await Promise.all(
        files.map(async (f) => {
          const stats = await fs.stat(path.join(this.fp, f));
          return { name: f, mtime: stats.mtime };
        }),
      );
      filesWithStats.sort((a, b) => b.mtime - a.mtime);
      return filesWithStats[0].name || null;
    } catch (error) {
      console.error('Failed to get latest image:', error);
      return null;
    }
  }

  // ---------------- high-level helpers ----------------
  async takeSnapshot() {
    const settings = await this._getSettings();
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    if (!settings?.use_real_camera) return 'Real camera is disabled in settings.';
    const fname = await this.captureFromWebcam();
    return fname ? `Captured: ${fname}` : 'Capture failed (no device or tool).';
  }

  async lookAtPlayer(player_name, direction) {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    const latestImage = await this._maybeCaptureIfEmpty();
    if (!latestImage) {
      return 'No images available and webcam capture failed or disabled. Enable use_real_camera or put an image in the screenshots folder.';
    }
    this.agent.latestScreenshotPath = latestImage;
    let result = `Using latest image: ${latestImage}\n`;
    if (this.vision_mode === 'prompted') {
      const analysis = await this.analyzeImage(latestImage, `Looking at player ${player_name}. Describe what you see.`);
      return result + `Image analysis: "${analysis}"`;
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot reference stored for context.';
    }
    return 'Error: Unknown vision mode.';
  }

  async lookAtPosition(x, y, z) {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    const latestImage = await this._maybeCaptureIfEmpty();
    if (!latestImage) {
      return 'No images available and webcam capture failed or disabled. Enable use_real_camera or put an image in the screenshots folder.';
    }
    this.agent.latestScreenshotPath = latestImage;
    let result = `Using latest image: ${latestImage}\n`;
    if (this.vision_mode === 'prompted') {
      const analysis = await this.analyzeImage(latestImage, `Looking at position (${x}, ${y}, ${z}). Describe what you see.`);
      return result + `Image analysis: "${analysis}"`;
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot reference stored for context.';
    }
    return 'Error: Unknown vision mode.';
  }

  async captureFullView() {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    const latestImage = await this._maybeCaptureIfEmpty();
    if (!latestImage) {
      return 'No images available and webcam capture failed or disabled. Enable use_real_camera or put an image in the screenshots folder.';
    }
    this.agent.latestScreenshotPath = latestImage;
    let result = `Using latest image: ${latestImage}\n`;
    if (this.vision_mode === 'prompted') {
      const analysis = await this.analyzeImage(latestImage);
      return result + `Image analysis: "${analysis}"`;
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot reference stored for context.';
    }
    return 'Error: Unknown vision mode.';
  }
}


// -----------------------------------------
// src/models/prompter.js 내 promptVision 구현 예시
//  - 항상 JPEG로 정규화(sharp) → media_type: image/jpeg
// -----------------------------------------

import sharp from 'sharp';

export async function promptVision(imageBuffer, prompt) {
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error('Empty image buffer');
  }

  // ✅ 포맷 강제: 어떤 입력이 와도 JPEG로 변환하여 보냄
  const jpegBuffer = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();
  const base64 = jpegBuffer.toString('base64');

  const content = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'input_image',
          image: {
            source: {
              type: 'base64',
              media_type: 'image/jpeg', // ← 실제 JPEG
              data: base64,              // ← 줄바꿈/따옴표 추가 금지
            },
          },
        },
      ],
    },
  ];

  // ... Anthropic SDK 호출 로직을 여기에 맞게 연결하세요 ...
  // 예: await claudeClient.messages.create({ model: 'claude-3-5-sonnet', messages: content, ...})
}
