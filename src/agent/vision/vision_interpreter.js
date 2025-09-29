// src/agent/vision/vision_interpreter.js
import fs from 'fs/promises';
import path from 'path';

export class VisionInterpreter {
    constructor(agent, vision_mode, robotController) {
        this.agent = agent;
        this.vision_mode = vision_mode;
        this.fp = `./bots/${agent.name}/screenshots`;
        this.robot = robotController; // 의존성 주입
        
        if (this.vision_mode !== 'off' && this.robot) {
            console.log('🎥 Robot camera initialized');
            this._checkRobotConnection();
        }
    }

    async _checkRobotConnection() {
        try {
            const health = await this.robot.healthCheck();
            if (health.online) {
                console.log(`🤖 Robot camera ready (latency: ${health.latency}ms)`);
            } else {
                console.warn(`⚠️  Robot offline: ${health.error}`);
            }
        } catch (error) {
            console.warn(`⚠️  Failed to check robot connection:`, error.message);
        }
    }

    /**
     * 로봇 카메라에서 이미지를 캡처하여 파일로 저장
     * @param {Object} options - 캡처 옵션
     * @param {number} options.w - 너비 (기본: 800)
     * @param {number} options.h - 높이 (기본: 600)
     * @param {number} options.q - 품질 (기본: 2)
     * @returns {Promise<string>} 저장된 파일명
     */
    async captureImage({ w = 800, h = 600, q = 2 } = {}) {
        if (!this.robot) {
            throw new Error('Robot controller not initialized');
        }

        try {
            // screenshots 폴더 확인/생성
            await fs.mkdir(this.fp, { recursive: true });
            
            // 로봇 카메라에서 이미지 캡처하여 파일로 저장
            const { path: savedPath, bytes } = await this.robot.captureToFile(this.fp, { w, h, q });
            
            // 파일명만 추출 (경로 제외)
            const filename = path.basename(savedPath);
            
            console.log(`📸 ${filename} (${(bytes / 1024).toFixed(1)} KB)`);
            return filename;
            
        } catch (error) {
            console.error('🎥 Robot camera capture failed:', error.message);
            throw new Error(`Robot camera error: ${error.message}`);
        }
    }

    /**
     * 메모리 버퍼로 이미지 캡처 (비전 모델에 바로 전달용)
     * @param {Object} options - 캡처 옵션
     * @returns {Promise<Buffer>} 이미지 버퍼
     */
    async captureBuffer({ w = 800, h = 600, q = 2 } = {}) {
        if (!this.robot) {
            throw new Error('Robot controller not initialized');
        }

        try {
            const buffer = await this.robot.captureFrame({ w, h, q });
            console.log(`📸 Captured frame to buffer (${(buffer.length / 1024).toFixed(1)} KB)`);
            return buffer;
        } catch (error) {
            console.error('🎥 Robot camera capture failed:', error.message);
            throw new Error(`Robot camera error: ${error.message}`);
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }
        
        let result = `Taking photo from robot camera.\n`;
        
        // 추적 모드 활성화
        try {
            await this.robot.setTrack(true);
            console.log('🎯 Robot tracking enabled');
            await new Promise(r => setTimeout(r, 300));
        } catch (error) {
            console.warn('⚠️  Failed to enable tracking:', error.message);
        }
        
        let filename = await this.captureImage();
        this.agent.latestScreenshotPath = filename;

        if (this.vision_mode === 'prompted') {
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot taken and stored.";
        }
        
        return "Error: Unknown vision mode.";
    }

    async lookAtPosition(x, y, z) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }
        
        let result = `Taking photo from robot camera.\n`;
        
        let filename = await this.captureImage();
        this.agent.latestScreenshotPath = filename;

        if (this.vision_mode === 'prompted') {
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot taken and stored.";
        }
        
        return "Error: Unknown vision mode.";
    }

    async captureFullView() {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }

        let result = `Capturing robot camera view.\n`;
        
        let filename = await this.captureImage();
        this.agent.latestScreenshotPath = filename;

        if (this.vision_mode === 'prompted') {
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot taken and stored.";
        }
        
        return "Error: Unknown vision mode.";
    }

    async analyzeImage(filename) {
        const filepath = path.join(this.fp, filename);
        
        try {
            const imageBuffer = await fs.readFile(filepath);
            
            // Claude vision API 호출
            const analysis = await this.agent.prompter.promptVision(
                imageBuffer,
                "Describe what you see in this image from the robot's perspective."
            );
            
            return analysis;
        } catch (error) {
            console.error('Failed to analyze image:', error);
            return 'Image analysis failed.';
        }
    }

    /**
     * 이미지를 직접 분석 (파일 저장 없이 버퍼로)
     * @param {Object} options - 캡처 옵션
     * @param {string} prompt - 분석 프롬프트
     * @returns {Promise<string>} 분석 결과
     */
    async analyzeDirectly(options = {}, prompt = "Describe what you see in this image.") {
        try {
            const imageBuffer = await this.captureBuffer(options);
            const analysis = await this.agent.prompter.promptVision(imageBuffer, prompt);
            return analysis;
        } catch (error) {
            console.error('Failed to analyze image:', error);
            return 'Image analysis failed.';
        }
    }
}
