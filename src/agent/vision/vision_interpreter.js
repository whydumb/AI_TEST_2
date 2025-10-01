// src/agent/vision/vision_interpreter.js
import fs from 'fs/promises';
import path from 'path';

export class VisionInterpreter {
    constructor(agent, vision_mode) {
        this.agent = agent;
        this.vision_mode = vision_mode;
        this.fp = `./bots/${agent.name}/screenshots`;
        
        // 디렉토리 생성
        this._ensureDirectory();
        
        if (this.vision_mode !== 'off') {
            console.log('📸 Vision interpreter initialized (file-based mode)');
        }
    }

    async _ensureDirectory() {
        try {
            await fs.mkdir(this.fp, { recursive: true });
        } catch (error) {
            console.error('Failed to create screenshots directory:', error);
        }
    }

    /**
     * 지정된 파일의 이미지를 분석
     * @param {string} filename - 분석할 이미지 파일명 (screenshots 폴더 내)
     * @param {string} prompt - 분석 프롬프트 (옵션)
     * @returns {Promise<string>} 분석 결과
     */
    async analyzeImage(filename, prompt = "Describe what you see in this image.") {
        const filepath = path.join(this.fp, filename);
        
        try {
            // 파일 존재 확인
            await fs.access(filepath);
            
            // 이미지 버퍼로 읽기
            const imageBuffer = await fs.readFile(filepath);
            
            console.log(`📸 Analyzing image: ${filename} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
            
            // Claude vision API 호출
            const analysis = await this.agent.prompter.promptVision(
                imageBuffer,
                prompt
            );
            
            return analysis;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return `Error: Image file '${filename}' not found in ${this.fp}`;
            }
            console.error('Failed to analyze image:', error);
            return `Image analysis failed: ${error.message}`;
        }
    }

    /**
     * 이미지 버퍼를 직접 분석 (메모리에서)
     * @param {Buffer} imageBuffer - 이미지 버퍼
     * @param {string} prompt - 분석 프롬프트
     * @returns {Promise<string>} 분석 결과
     */
    async analyzeBuffer(imageBuffer, prompt = "Describe what you see in this image.") {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }

        try {
            console.log(`📸 Analyzing image buffer (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
            
            const analysis = await this.agent.prompter.promptVision(
                imageBuffer,
                prompt
            );
            
            return analysis;
        } catch (error) {
            console.error('Failed to analyze image buffer:', error);
            return `Image analysis failed: ${error.message}`;
        }
    }

    /**
     * screenshots 폴더의 모든 이미지 파일 목록 반환
     * @returns {Promise<string[]>} 이미지 파일명 배열
     */
    async listImages() {
        try {
            const files = await fs.readdir(this.fp);
            const imageFiles = files.filter(f => 
                /\.(jpg|jpeg|png|gif|webp)$/i.test(f)
            );
            return imageFiles;
        } catch (error) {
            console.error('Failed to list images:', error);
            return [];
        }
    }

    /**
     * 가장 최근 이미지 파일 반환
     * @returns {Promise<string|null>} 가장 최근 이미지 파일명
     */
    async getLatestImage() {
        try {
            const files = await this.listImages();
            if (files.length === 0) return null;

            // 파일의 수정 시간으로 정렬
            const filesWithStats = await Promise.all(
                files.map(async (f) => {
                    const stats = await fs.stat(path.join(this.fp, f));
                    return { name: f, mtime: stats.mtime };
                })
            );

            filesWithStats.sort((a, b) => b.mtime - a.mtime);
            return filesWithStats[0].name;
        } catch (error) {
            console.error('Failed to get latest image:', error);
            return null;
        }
    }

    /**
     * 레거시 호환성: lookAtPlayer
     * 가장 최근 이미지를 사용하여 분석
     */
    async lookAtPlayer(player_name, direction) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }
        
        const latestImage = await this.getLatestImage();
        if (!latestImage) {
            return "No images available for analysis. Please place an image in the screenshots folder first.";
        }

        this.agent.latestScreenshotPath = latestImage;
        
        let result = `Using latest image: ${latestImage}\n`;
        
        if (this.vision_mode === 'prompted') {
            const analysis = await this.analyzeImage(latestImage, 
                `Looking at player ${player_name}. Describe what you see.`);
            return result + `Image analysis: "${analysis}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot reference stored for context.";
        }
        
        return "Error: Unknown vision mode.";
    }

    /**
     * 레거시 호환성: lookAtPosition
     * 가장 최근 이미지를 사용하여 분석
     */
    async lookAtPosition(x, y, z) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }
        
        const latestImage = await this.getLatestImage();
        if (!latestImage) {
            return "No images available for analysis. Please place an image in the screenshots folder first.";
        }

        this.agent.latestScreenshotPath = latestImage;
        
        let result = `Using latest image: ${latestImage}\n`;
        
        if (this.vision_mode === 'prompted') {
            const analysis = await this.analyzeImage(latestImage, 
                `Looking at position (${x}, ${y}, ${z}). Describe what you see.`);
            return result + `Image analysis: "${analysis}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot reference stored for context.";
        }
        
        return "Error: Unknown vision mode.";
    }

    /**
     * 레거시 호환성: captureFullView
     * 가장 최근 이미지를 사용하여 분석
     */
    async captureFullView() {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }

        const latestImage = await this.getLatestImage();
        if (!latestImage) {
            return "No images available for analysis. Please place an image in the screenshots folder first.";
        }

        this.agent.latestScreenshotPath = latestImage;
        
        let result = `Using latest image: ${latestImage}\n`;
        
        if (this.vision_mode === 'prompted') {
            const analysis = await this.analyzeImage(latestImage);
            return result + `Image analysis: "${analysis}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot reference stored for context.";
        }
        
        return "Error: Unknown vision mode.";
    }

    /**
     * 특정 이미지 파일을 분석하고 결과 반환 (외부 명령용)
     * @param {string} filename - 분석할 파일명
     * @returns {Promise<string>}
     */
    async analyzeSpecificImage(filename) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }

        const images = await this.listImages();
        if (!images.includes(filename)) {
            return `Image '${filename}' not found. Available images: ${images.join(', ') || 'none'}`;
        }

        const analysis = await this.analyzeImage(filename);
        return `Analysis of ${filename}: "${analysis}"`;
    }
}
