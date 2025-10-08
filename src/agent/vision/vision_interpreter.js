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
  camera_device: 'Integrated Camera', // Windows dshow 기본 장치명
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
    try { 
      await fs.mkdir(this.fp, { recursive: true }); 
      console.log(`📁 Screenshots directory ensured: ${this.fp}`);
    } catch (e) { 
      console.error('❌ Failed to create screenshots directory:', e); 
    }
  }

  async _which(cmd) {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    try { 
      await execAsync(probe); 
      return true; 
    } catch { 
      return false; 
    }
  }

  async _ensureNonEmptyFile(filepath) {
    try {
      await fs.access(filepath);
      const stats = await fs.stat(filepath);
      if (!stats.isFile()) throw new Error('Captured path is not a file');
      if (stats.size === 0) throw new Error('Captured file is empty');
      
      // ✅ 파일 시그니처도 확인 (JPEG 또는 PNG)
      const buffer = await fs.readFile(filepath);
      const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
      const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      
      if (!isJPEG && !isPNG) {
        throw new Error('File is not a valid image format');
      }
      
      console.log(`✅ Image validated: ${path.basename(filepath)} (${(stats.size/1024).toFixed(1)} KB, ${isJPEG ? 'JPEG' : 'PNG'})`);
      return stats.size;
    } catch (error) {
      console.error(`❌ File validation failed for ${filepath}:`, error.message);
      throw error;
    }
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
   * @param {string} deviceName - Camera device name (optional)
   * @returns {Promise<string|null>} saved filename or null
   */
  async captureFromWebcam(deviceName = null) {
    if (this.vision_mode === 'off') return 'Vision is disabled.';

    await this._ensureDirectory();
    const timestamp = Date.now();
    const filename = `webcam_${timestamp}.jpg`;
    const filepath = path.join(this.fp, filename);

    console.log(`📸 Starting webcam capture: ${filename}`);

    try {
      if (process.platform === 'win32') {
        await this._captureWebcamWindows(filepath, deviceName);
      } else if (process.platform === 'darwin') {
        await this._captureWebcamMac(filepath);
      } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }

      const bytes = await this._ensureNonEmptyFile(filepath);
      console.log(`✅ Webcam capture saved: ${filename} (${(bytes/1024).toFixed(1)} KB)`);
      return filename;

    } catch (error) {
      console.error('❌ Webcam capture failed:', error.message);
      
      // ✅ 실패한 파일이 있다면 삭제
      try {
        await fs.unlink(filepath);
        console.log(`🗑️ Cleaned up failed capture: ${filename}`);
      } catch (cleanupError) {
        // 파일이 없거나 삭제 실패는 무시
      }
      
      const latest = await this.getLatestImage();
      if (latest) {
        console.log(`📸 Using latest existing image: ${latest}`);
        return latest;
      }
      return null;
    }
  }

  // Windows 웹캠 캡처 (완전 개선 버전)
  async _captureWebcamWindows(filepath, deviceName = null) {
    const settings = await this._getSettings();
    const finalDeviceName = deviceName || settings.camera_device || 'Integrated Camera';
    
    console.log('📸 Starting Windows webcam capture...');
    
    const hasFFmpeg = await this._which('ffmpeg');
    if (!hasFFmpeg) {
      throw new Error('❌ ffmpeg is not available. Please install: https://ffmpeg.org/download.html');
    }

    // ✅ 1단계: 사용 가능한 카메라 장치 목록 확인
    let availableDevices = [];
    try {
      console.log('🔍 Detecting available cameras...');
      const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy', {
        timeout: 5000,
        windowsHide: true
      });
      
      // DirectShow 장치 목록 파싱
      const videoDevices = stderr.match(/\[dshow.*?"([^"]+)"\s*\(video\)/gi) || [];
      availableDevices = videoDevices.map(line => {
        const match = line.match(/"([^"]+)"/);
        return match ? match[1] : null;
      }).filter(Boolean);
      
      if (availableDevices.length > 0) {
        console.log(`✅ Found ${availableDevices.length} camera(s): ${availableDevices.join(', ')}`);
      } else {
        console.warn('⚠️ No cameras detected via DirectShow');
      }
    } catch (error) {
      console.warn('⚠️ Could not list devices:', error.message);
    }

    // ✅ 2단계: 시도할 설정들 (우선순위 순서)
    const configurations = [];

    // 설정 1: 지정된 장치명으로 시도
    if (availableDevices.length > 0) {
      const targetDevice = availableDevices.find(d => 
        d.toLowerCase().includes(finalDeviceName.toLowerCase())
      ) || availableDevices[0];
      
      configurations.push({
        name: `Device: "${targetDevice}"`,
        args: [
          '-f', 'dshow',
          '-video_size', '1280x720',
          '-framerate', '30',
          '-i', `video=${targetDevice}`,
          '-frames:v', '1',
          '-q:v', '2',
          '-f', 'image2',
          filepath
        ]
      });
    }

    // 설정 2: 간단한 장치명 방식
    configurations.push({
      name: `Simple device name`,
      args: [
        '-f', 'dshow',
        '-i', `video=${finalDeviceName}`,
        '-vframes', '1',
        '-q:v', '3',
        filepath
      ]
    });

    // 설정 3: 장치 인덱스 (0번)
    configurations.push({
      name: 'Device index 0',
      args: [
        '-f', 'dshow',
        '-i', 'video=0',
        '-vframes', '1',
        filepath
      ]
    });

    // 설정 4: VFW (Video for Windows) 폴백
    configurations.push({
      name: 'VFW backend',
      args: [
        '-f', 'vfwcap',
        '-i', '0',
        '-frames:v', '1',
        filepath
      ]
    });

    // ✅ 3단계: 각 설정 순차 시도
    let lastError;
    
    for (let i = 0; i < configurations.length; i++) {
      const { name, args } = configurations[i];
      
      try {
        console.log(`\n📸 Attempt ${i + 1}/${configurations.length}: ${name}`);
        console.log(`   Command: ffmpeg ${args.join(' ')}`);
        
        // 이전 실패 파일 제거
        try {
          await fs.unlink(filepath);
        } catch (e) {
          // 파일이 없으면 무시
        }

        // ffmpeg 실행
        await execAsync(`ffmpeg -y ${args.join(' ')}`, {
          timeout: 25000,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 10 // 10MB
        });

        // ✅ 파일 완성 대기 (중요!)
        await new Promise(resolve => setTimeout(resolve, 500));

        // ✅ 파일 검증
        try {
          const stats = await fs.stat(filepath);
          
          if (!stats.isFile()) {
            throw new Error('Not a file');
          }
          
          if (stats.size < 1000) {
            throw new Error(`File too small (${stats.size} bytes)`);
          }

          // 이미지 시그니처 검증
          const buffer = await fs.readFile(filepath);
          const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8;
          const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50;
          
          if (!isJPEG && !isPNG) {
            throw new Error('Invalid image format');
          }

          console.log(`✅ SUCCESS: ${name}`);
          console.log(`   File: ${(stats.size / 1024).toFixed(1)} KB, ${isJPEG ? 'JPEG' : 'PNG'}`);
          return; // 성공!

        } catch (validationError) {
          throw new Error(`Validation failed: ${validationError.message}`);
        }

      } catch (error) {
        lastError = error;
        const errorMsg = error.stderr || error.message;
        console.warn(`❌ Failed: ${errorMsg.substring(0, 200)}`);
        
        // 실패한 파일 정리
        try {
          await fs.unlink(filepath);
        } catch (e) {
          // 무시
        }

        // 다음 시도 전 대기
        if (i < configurations.length - 1) {
          console.log('   ⏳ Waiting 2s before next attempt...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    // ✅ 모든 시도 실패
    throw new Error(
      `All ${configurations.length} configurations failed.\n` +
      `Last error: ${lastError?.message || 'Unknown'}\n` +
      `Available cameras: ${availableDevices.length ? availableDevices.join(', ') : 'none detected'}\n` +
      `Please check:\n` +
      `1. Camera is connected and not in use\n` +
      `2. ffmpeg is properly installed\n` +
      `3. Camera permissions are granted`
    );
  }

  // macOS 웹캠 캡처
  async _captureWebcamMac(filepath) {
    const hasImageSnap = await this._which('imagesnap');
    if (!hasImageSnap) {
      throw new Error('❌ imagesnap is not installed on macOS (brew install imagesnap)');
    }
    
    console.log('📸 Using imagesnap for macOS...');
    try {
      await execFileAsync('imagesnap', [filepath], { timeout: 10000 });
      console.log('✅ imagesnap capture successful');
    } catch (error) {
      throw new Error(`❌ imagesnap failed: ${error.message}`);
    }
  }

  // ✅ 카메라 장치 목록 확인 메서드
  async listCameraDevices() {
    if (process.platform !== 'win32') {
      return 'This feature is only available on Windows';
    }

    try {
      const { stderr } = await execAsync('ffmpeg -list_devices true -f dshow -i dummy', {
        timeout: 5000,
        windowsHide: true
      });
      
      const lines = stderr.split('\n');
      const videoDevices = [];
      let inVideoSection = false;
      
      for (const line of lines) {
        if (line.includes('DirectShow video devices')) {
          inVideoSection = true;
          continue;
        }
        if (line.includes('DirectShow audio devices')) {
          break;
        }
        if (inVideoSection && line.includes('"')) {
          const match = line.match(/"([^"]+)"/);
          if (match) {
            videoDevices.push(match[1]);
          }
        }
      }
      
      return videoDevices.length > 0
        ? `Available cameras:\n${videoDevices.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`
        : 'No cameras detected';
        
    } catch (error) {
      return `Failed to list cameras: ${error.message}`;
    }
  }

  // ---------------- analysis ----------------
  async analyzeImage(filename, prompt = 'Describe what you see in this image.') {
    if (!filename) return 'Error: No filename provided.';
    const filepath = path.join(this.fp, filename);
    
    try {
      const buf = await fs.readFile(filepath);
      if (!buf || buf.length === 0) return `Error: Image file '${filename}' is empty.`;
      
      console.log(`🔍 Analyzing image: ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(buf, prompt);
    } catch (error) {
      if (error.code === 'ENOENT') return `Error: Image file '${filename}' not found in ${this.fp}`;
      console.error('❌ Failed to analyze image:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  async analyzeBuffer(imageBuffer, prompt = 'Describe what you see in this image.') {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    try {
      if (!imageBuffer || imageBuffer.length === 0) throw new Error('Empty image buffer');
      console.log(`🔍 Analyzing image buffer (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(imageBuffer, prompt);
    } catch (error) {
      console.error('❌ Failed to analyze image buffer:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  // ---------------- file helpers ----------------
  async listImages() {
    try {
      await this._ensureDirectory();
      const files = await fs.readdir(this.fp);
      const imageFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
      console.log(`📂 Found ${imageFiles.length} images in ${this.fp}`);
      return imageFiles;
    } catch (error) {
      console.error('❌ Failed to list images:', error);
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
          try {
            const stats = await fs.stat(path.join(this.fp, f));
            return { name: f, mtime: stats.mtime, size: stats.size };
          } catch (error) {
            console.warn(`⚠️ Could not stat file ${f}:`, error.message);
            return null;
          }
        })
      );
      
      const validFiles = filesWithStats.filter(f => f !== null && f.size > 0);
      if (validFiles.length === 0) {
        console.warn('📸 No valid image files found');
        return null;
      }
      
      validFiles.sort((a, b) => b.mtime - a.mtime);
      const latest = validFiles[0].name;
      console.log(`📸 Latest image: ${latest} (${(validFiles[0].size/1024).toFixed(1)} KB)`);
      return latest;
    } catch (error) {
      console.error('❌ Failed to get latest image:', error);
      return null;
    }
  }

  // ✅ 오래된 이미지 파일 정리
  async cleanupOldImages(maxFiles = 10) {
    try {
      const files = await this.listImages();
      if (files.length <= maxFiles) return;
      
      const filesWithStats = await Promise.all(
        files.map(async (f) => {
          const stats = await fs.stat(path.join(this.fp, f));
          return { name: f, mtime: stats.mtime };
        })
      );
      
      filesWithStats.sort((a, b) => b.mtime - a.mtime);
      const filesToDelete = filesWithStats.slice(maxFiles);
      
      for (const file of filesToDelete) {
        try {
          await fs.unlink(path.join(this.fp, file.name));
          console.log(`🗑️ Cleaned up old image: ${file.name}`);
        } catch (error) {
          console.warn(`⚠️ Failed to delete ${file.name}:`, error.message);
        }
      }
      
      if (filesToDelete.length > 0) {
        console.log(`🧹 Cleaned up ${filesToDelete.length} old images`);
      }
    } catch (error) {
      console.error('❌ Failed to cleanup old images:', error);
    }
  }

  // ---------------- high-level helpers ----------------
  async takeSnapshot() {
    const settings = await this._getSettings();
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    if (!settings?.use_real_camera) return 'Real camera is disabled in settings.';
    
    // ✅ 캡처 전 정리
    await this.cleanupOldImages(5);
    
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
      try {
        const analysis = await this.analyzeImage(latestImage, `Looking at player ${player_name}. Describe what you see.`);
        return result + `Image analysis: "${analysis}"`;
      } catch (error) {
        return result + `Analysis failed: ${error.message}`;
      }
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
      try {
        const analysis = await this.analyzeImage(latestImage, `Looking at position (${x}, ${y}, ${z}). Describe what you see.`);
        return result + `Image analysis: "${analysis}"`;
      } catch (error) {
        return result + `Analysis failed: ${error.message}`;
      }
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
      try {
        const analysis = await this.analyzeImage(latestImage);
        return result + `Image analysis: "${analysis}"`;
      } catch (error) {
        return result + `Analysis failed: ${error.message}`;
      }
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot reference stored for context.';
    }
    
    return 'Error: Unknown vision mode.';
  }
}
