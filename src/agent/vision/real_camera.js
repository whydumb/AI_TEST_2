// src/agent/vision/real_camera.js
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

export class RealCamera extends EventEmitter {
    constructor(bot, fp) {
        super();
        this.bot = bot;  // 사실 안 써도 됨
        this.fp = fp;
        this.width = 800;
        this.height = 512;
        
        // 초기화 완료 신호
        this.emit('ready');
    }
  
    async capture() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `realcam_${timestamp}.jpg`;
        
        // 🎬 3D 렌더링 부분 전부 스킵!
        // 바로 웹캠에서 사진 찍기
        await this._captureFromWebcam(filename);
        
        console.log('saved', filename);
        return filename;
    }

    async _captureFromWebcam(filename) {
        await this._ensureScreenshotDirectory();
        const fullPath = `${this.fp}/${filename}`;
        
        const execAsync = promisify(exec);
        
        // Linux/Mac (ffmpeg 사용)
        try {
            await execAsync(
                `ffmpeg -f v4l2 -i /dev/video0 -vframes 1 -y ${fullPath}`
            );
        } catch (error) {
            console.error('Camera capture failed:', error);
            throw error;
        }
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp, { recursive: true });
            }
        }
    }
}