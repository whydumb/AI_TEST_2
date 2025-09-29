import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';
import path from 'path';

export class VisionInterpreter {
    constructor(agent, vision_mode, use_real_camera = false) {  // 파라미터 추가
        this.agent = agent;
        this.vision_mode = vision_mode;
        this.fp = './bots/'+agent.name+'/screenshots/';
        
        if (this.vision_mode !== 'off') {
            // 🎯 여기가 핵심! 카메라 선택
            if (use_real_camera) {
                this.camera = new RealCamera(agent.bot, this.fp);
            } else {
                this.camera = new Camera(agent.bot, this.fp);
            }
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (this.vision_mode === 'off') {
            return "Vision is disabled.";
        }
        if (!this.camera) {
            return "Camera is not initialized.";
        }

        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        // ❌ 이 부분들은 실제 카메라에서는 의미 없음 (제거 가능)
        // if (direction === 'with') {
        //     await bot.look(player.yaw, player.pitch);
        // } else {
        //     await bot.lookAt(...);
        // }
        
        // ✅ 그냥 바로 찍기
        result = `Taking photo for player ${player_name}.\n`;
        let filename = await this.camera.capture();
        this.agent.latestScreenshotPath = filename;

        if (this.vision_mode === 'prompted') {
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot taken and stored.";
        }
        
        return "Error: Unknown vision mode.";
    }

    async lookAtPosition(x, y, z) {
        // lookAtPlayer와 거의 동일
        // ❌ bot.lookAt() 제거
        // ✅ 그냥 capture() 호출
        
        let result = `Taking photo for position ${x}, ${y}, ${z}.\n`;
        let filename = await this.camera.capture();
        this.agent.latestScreenshotPath = filename;

        if (this.vision_mode === 'prompted') {
            return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
        } else if (this.vision_mode === 'always') {
            return result + "Screenshot taken and stored.";
        }
        
        return "Error: Unknown vision mode.";
    }

    // analyzeImage()는 그대로 유지 - 이미지 분석 부분
}
