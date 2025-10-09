// src/agent/vision/vision_interpreter.js
import fs from 'fs/promises';
import path from 'path';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const defaultSettings = {
  use_real_camera: true,
  camera_device: '0',  // VFW 인덱스
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
            return await this.captureFromWebcam();
          }
          return await this.getLatestImage();
        },
      };
      console.log('📸 Vision interpreter initialized');
    }
  }

  // ===================== 설정 & 유틸 =====================

  async _getSettings() {
    let settings = defaultSettings;
    try {
      const mod = await import('../../../settings.js');
      settings = { ...defaultSettings, ...(mod.default || mod) };
    } catch {
      console.warn('⚠️ settings.js not found; using defaults');
    }
    return settings;
  }

  async _ensureDirectory() {
    try { 
      await fs.mkdir(this.fp, { recursive: true }); 
      console.log(`📁 Screenshots directory: ${this.fp}`);
    } catch (e) { 
      console.error('❌ Failed to create directory:', e); 
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

  // ===================== 검증 함수들 =====================

  async _ensureNonEmptyFile(filepath) {
    try {
      await fs.access(filepath);
      const stats = await fs.stat(filepath);
      
      if (!stats.isFile()) throw new Error('Not a file');
      if (stats.size === 0) throw new Error('Empty file');
      if (stats.size < 1000) throw new Error(`File too small: ${stats.size} bytes`);
      
      // JPEG 시그니처 확인
      const buffer = await fs.readFile(filepath);
      const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
      const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      
      if (!isJPEG && !isPNG) {
        throw new Error('Not a valid image format');
      }
      
      console.log(`✅ Image validated: ${path.basename(filepath)} (${(stats.size/1024).toFixed(1)} KB)`);
      return stats.size;
    } catch (error) {
      console.error(`❌ File validation failed:`, error.message);
      throw error;
    }
  }

  // ✅ JPEG EOI 검사
  async _ensureJPEGMarkers(filepath) {
    try {
      const fd = await fs.open(filepath, 'r');
      const buf = Buffer.alloc(2);
      
      // SOI 마커 (FF D8)
      await fd.read(buf, 0, 2, 0);
      const head = buf.toString('hex');
      
      // EOI 마커 (FF D9)
      const size = (await fd.stat()).size;
      await fd.read(buf, 0, 2, size - 2);
      const tail = buf.toString('hex');
      
      await fd.close();
      
      if (head !== 'ffd8') {
        throw new Error('JPEG SOI marker missing');
      }
      
      if (tail !== 'ffd9') {
        throw new Error('JPEG EOI marker missing');
      }
      
      console.log('✅ JPEG markers verified');
      return true;
      
    } catch (error) {
      console.error('❌ JPEG marker check failed:', error.message);
      throw error;
    }
  }

  // ✅ Sharp 검증
  async _validateImageWithSharp(filepath) {
    try {
      const sharp = (await import('sharp')).default;
      
      const metadata = await sharp(filepath).metadata();
      console.log(`🔍 Sharp: ${metadata.format}, ${metadata.width}x${metadata.height}`);
      
      if (!metadata.format || !['jpeg', 'jpg', 'png'].includes(metadata.format)) {
        throw new Error(`Invalid format: ${metadata.format}`);
      }
      
      if (metadata.width < 100 || metadata.height < 100) {
        throw new Error(`Too small: ${metadata.width}x${metadata.height}`);
      }
      
      // 픽셀 읽기 테스트 (손상 감지)
      await sharp(filepath).raw().toBuffer();
      
      console.log('✅ Sharp validation passed');
      return true;
      
    } catch (error) {
      console.error(`❌ Sharp validation failed:`, error.message);
      return false;
    }
  }

  // ===================== 📷 Webcam (VFW) =====================

  async _captureWebcamWindows(filepath, deviceName = null) {
    console.log('📸 VFW capture starting...');
    
    const hasFFmpeg = await this._which('ffmpeg');
    if (!hasFFmpeg) {
      throw new Error('❌ ffmpeg not available');
    }

    // VFW만 사용 (카메라 0, 1 시도)
    const cameraIndices = [0, 1];
    let lastError;
    
    for (const index of cameraIndices) {
      try {
        console.log(`📸 Trying VFW camera ${index}...`);
        
        // 이전 파일 삭제
        try { 
          await fs.unlink(filepath); 
        } catch (e) {}
        
        // VFW 캡처
        await execAsync(
          `ffmpeg -y -f vfwcap -i ${index} -frames:v 1 "${filepath}"`, 
          {
            timeout: 10000,
            windowsHide: true
          }
        );
        
        // 파일 완성 대기
        await new Promise(r => setTimeout(r, 800));
        
        // 파일 존재 확인
        const stats = await fs.stat(filepath);
        if (stats.size < 1000) {
          throw new Error(`File too small: ${stats.size} bytes`);
        }
        
        console.log(`✅ VFW camera ${index} success (${(stats.size/1024).toFixed(1)} KB)`);
        return;
        
      } catch (error) {
        lastError = error;
        console.warn(`❌ VFW camera ${index} failed:`, error.message);
      }
    }
    
    throw new Error(`All VFW cameras failed. Last: ${lastError?.message}`);
  }

  async _captureWebcamMac(filepath) {
    const hasImageSnap = await this._which('imagesnap');
    if (!hasImageSnap) {
      throw new Error('❌ imagesnap not installed (brew install imagesnap)');
    }
    
    console.log('📸 Using imagesnap...');
    try {
      await execFileAsync('imagesnap', [filepath], { timeout: 10000 });
      console.log('✅ imagesnap success');
    } catch (error) {
      throw new Error(`❌ imagesnap failed: ${error.message}`);
    }
  }

  async captureFromWebcam(deviceName = null) {
    if (this.vision_mode === 'off') return null;

    await this._ensureDirectory();
    const maxRetries = 3;
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const timestamp = Date.now();
      const filename = `webcam_${timestamp}.jpg`;
      const filepath = path.join(this.fp, filename);
      
      try {
        console.log(`\n📸 Capture attempt ${attempt}/${maxRetries}`);
        
        // 2차 시도부터 대기 (카메라 안정화)
        if (attempt > 1) {
          console.log('⏳ Waiting 1.5s for camera...');
          await new Promise(r => setTimeout(r, 1500));
        }
        
        // 캡처 실행
        if (process.platform === 'win32') {
          await this._captureWebcamWindows(filepath, deviceName);
        } else if (process.platform === 'darwin') {
          await this._captureWebcamMac(filepath);
        } else {
          throw new Error(`Unsupported platform: ${process.platform}`);
        }
        
        // 파일 안정화 대기
        await new Promise(r => setTimeout(r, 1000));
        
        // ✅ 3단계 검증
        await this._ensureNonEmptyFile(filepath);
        await this._ensureJPEGMarkers(filepath);
        
        const isValid = await this._validateImageWithSharp(filepath);
        if (!isValid) {
          throw new Error('Sharp validation failed');
        }
        
        console.log(`✅ Capture successful: ${filename}`);
        return filename;
        
      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempt}/${maxRetries} failed:`, error.message);
        
        // 실패한 파일 삭제
        try {
          await fs.unlink(filepath);
          console.log(`🗑️ Cleaned failed file`);
        } catch (e) {}
        
        if (attempt === maxRetries) {
          console.error(`❌ All attempts exhausted`);
          
          // 폴백: 기존 이미지 사용
          const latest = await this.getLatestImage();
          if (latest) {
            console.log(`📸 Using existing image: ${latest}`);
            return latest;
          }
          return null;
        }
      }
    }
    
    return null;
  }

  // ===================== 이미지 분석 =====================

  async analyzeImage(filename, prompt = 'Describe what you see in this image.') {
    if (!filename) return 'Error: No filename provided.';
    const filepath = path.join(this.fp, filename);
    
    try {
      const buf = await fs.readFile(filepath);
      if (!buf || buf.length === 0) {
        return `Error: Image file '${filename}' is empty.`;
      }
      
      console.log(`🔍 Analyzing: ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(buf, prompt);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return `Error: Image file '${filename}' not found`;
      }
      console.error('❌ Analysis failed:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  async analyzeBuffer(imageBuffer, prompt = 'Describe what you see in this image.') {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    try {
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Empty image buffer');
      }
      console.log(`🔍 Analyzing buffer (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
      return await this.agent.prompter.promptVision(imageBuffer, prompt);
    } catch (error) {
      console.error('❌ Buffer analysis failed:', error);
      return `Image analysis failed: ${error.message}`;
    }
  }

  // ===================== 파일 관리 =====================

  async listImages() {
    try {
      await this._ensureDirectory();
      const files = await fs.readdir(this.fp);
      const imageFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
      console.log(`📂 Found ${imageFiles.length} images`);
      return imageFiles;
    } catch (error) {
      console.error('❌ List failed:', error);
      return [];
    }
  }

  async getLatestImage() {
    try {
      const files = await this.listImages();
      if (files.length === 0) {
        console.warn(`📸 No images in ${this.fp}`);
        return null;
      }
      
      const filesWithStats = await Promise.all(
        files.map(async (f) => {
          try {
            const stats = await fs.stat(path.join(this.fp, f));
            return { name: f, mtime: stats.mtime, size: stats.size };
          } catch (error) {
            return null;
          }
        })
      );
      
      const validFiles = filesWithStats.filter(f => f !== null && f.size > 0);
      if (validFiles.length === 0) {
        console.warn('📸 No valid images');
        return null;
      }
      
      validFiles.sort((a, b) => b.mtime - a.mtime);
      const latest = validFiles[0].name;
      console.log(`📸 Latest: ${latest} (${(validFiles[0].size/1024).toFixed(1)} KB)`);
      return latest;
    } catch (error) {
      console.error('❌ Get latest failed:', error);
      return null;
    }
  }

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
          console.log(`🗑️ Deleted: ${file.name}`);
        } catch (error) {
          console.warn(`⚠️ Delete failed: ${file.name}`);
        }
      }
      
      if (filesToDelete.length > 0) {
        console.log(`🧹 Cleaned ${filesToDelete.length} images`);
      }
    } catch (error) {
      console.error('❌ Cleanup failed:', error);
    }
  }

  // ===================== High-level API =====================

  async takeSnapshot() {
    const settings = await this._getSettings();
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    if (!settings.use_real_camera) {
      return 'Camera is disabled in settings.';
    }
    
    await this.cleanupOldImages(5);
    
    const fname = await this.captureFromWebcam();
    return fname ? `Captured: ${fname}` : 'Capture failed';
  }

  async lookAtPlayer(player_name, direction) {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    let latestImage = await this.getLatestImage();
    
    // 이미지 없으면 새로 캡처
    if (!latestImage) {
      console.log('📸 No existing image, capturing...');
      await this.takeSnapshot();
      latestImage = await this.getLatestImage();
      
      if (!latestImage) {
        return 'Failed to capture image';
      }
    }
    
    this.agent.latestScreenshotPath = latestImage;
    let result = `Looking at player ${player_name}...\n`;
    
    if (this.vision_mode === 'prompted') {
      try {
        const analysis = await this.analyzeImage(
          latestImage, 
          `Looking at player ${player_name}. Describe what you see.`
        );
        return result + `\nAnalysis: ${analysis}`;
      } catch (error) {
        return result + `\nAnalysis failed: ${error.message}`;
      }
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot stored for context.';
    }
    
    return 'Vision mode not configured';
  }

  async lookAtPosition(x, y, z) {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    let latestImage = await this.getLatestImage();
    
    if (!latestImage) {
      console.log('📸 No existing image, capturing...');
      await this.takeSnapshot();
      latestImage = await this.getLatestImage();
      
      if (!latestImage) {
        return 'Failed to capture image';
      }
    }
    
    this.agent.latestScreenshotPath = latestImage;
    let result = `Looking at position (${x}, ${y}, ${z})...\n`;
    
    if (this.vision_mode === 'prompted') {
      try {
        const analysis = await this.analyzeImage(
          latestImage,
          `Looking at position (${x}, ${y}, ${z}). Describe what you see.`
        );
        return result + `\nAnalysis: ${analysis}`;
      } catch (error) {
        return result + `\nAnalysis failed: ${error.message}`;
      }
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot stored for context.';
    }
    
    return 'Vision mode not configured';
  }

  async captureFullView() {
    if (this.vision_mode === 'off') return 'Vision is disabled.';
    
    let latestImage = await this.getLatestImage();
    
    if (!latestImage) {
      console.log('📸 No existing image, capturing...');
      await this.takeSnapshot();
      latestImage = await this.getLatestImage();
      
      if (!latestImage) {
        return 'Failed to capture image';
      }
    }
    
    this.agent.latestScreenshotPath = latestImage;
    let result = 'Capturing full view...\n';
    
    if (this.vision_mode === 'prompted') {
      try {
        const analysis = await this.analyzeImage(latestImage);
        return result + `\nAnalysis: ${analysis}`;
      } catch (error) {
        return result + `\nAnalysis failed: ${error.message}`;
      }
    } else if (this.vision_mode === 'always') {
      return result + 'Screenshot stored for context.';
    }
    
    return 'Vision mode not configured';
  }
}
