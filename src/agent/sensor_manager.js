import settings from '../../settings.js';
import { createRobotController } from '../utils/robot_controller.js';

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, limit = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export class SensorManager {
    constructor(agentName) {
        this.agentName = agentName;
        this.robotController = createRobotController({ agentName });
        this.pollIntervalMs = Math.max(1000, Number(settings.standalone_sensor_poll_ms) || 3000);
        this.pollTimer = null;
        this.snapshot = {
            robot: {
                connected: false,
                isWalking: false,
                walkVector: { x: 0, y: 0, theta: 0 },
                yawDeg: null,
                pose: 'unknown',
                plannedPose: 'unknown',
                currentMotionPage: 0,
                motionQueueLength: 0,
                manualJointsLikelyAllowed: false,
                emotion: 'neutral',
                emotionIdle: null,
                blinkMode: false,
                trackMode: false,
                lock: null,
                lastError: null,
                updatedAt: null,
            },
            vision: {
                available: false,
                lastCapture: null,
                lastAnalysis: null,
                camera: null,
                updatedAt: null,
            },
            audio: {
                sttEnabled: settings.stt_transcription === true,
                lastTranscript: null,
                speaking: false,
                provider: settings.stt_provider || null,
                updatedAt: null,
            },
            location: {
                available: false,
                x: null,
                y: null,
                z: null,
                frame: 'robot',
            },
            battery: {
                available: false,
                level: null,
            },
            proximity: {
                available: false,
                distance: null,
            },
            navigation: {
                activePlan: null,
                lastProgress: null,
                updatedAt: null,
            },
        };
    }

    async start() {
        await this.refreshRobotState();
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => {
            this.refreshRobotState().catch((error) => {
                console.warn('[SensorManager] Robot status refresh failed:', error.message);
            });
        }, this.pollIntervalMs);
        this.pollTimer.unref?.();
    }

    stop() {
        if (!this.pollTimer) return;
        clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    async refreshRobotState() {
        try {
            const status = await this.robotController.getStatus();
            const camera = status?.camera || null;
            this.snapshot.robot = {
                connected: !!status?.connected,
                isWalking: !!status?.isWalking,
                walkVector: status?.walkVector || { x: 0, y: 0, theta: 0 },
                yawDeg: Number.isFinite(status?.yawDeg) ? status.yawDeg : null,
                pose: status?.pose || 'unknown',
                plannedPose: status?.plannedPose || 'unknown',
                currentMotionPage: Number.isInteger(status?.motionPage) ? status.motionPage : 0,
                motionQueueLength: Number.isInteger(status?.motionQueueLength) ? status.motionQueueLength : 0,
                manualJointsLikelyAllowed: status?.manualJointsLikelyAllowed === true,
                emotion: status?.emotion || 'neutral',
                emotionIdle: typeof status?.emotionIdle === 'boolean' ? status.emotionIdle : null,
                blinkMode: !!status?.blinkMode,
                trackMode: !!status?.trackMode,
                lock: status?.lock || null,
                lastError: status?.lastError || status?.error || null,
                updatedAt: Date.now(),
            };

            if (camera && typeof camera === 'object') {
                this.snapshot.vision.camera = {
                    available: camera.available === true,
                    hasImage: camera.hasImage === true,
                    width: Number.isInteger(camera.width) ? camera.width : null,
                    height: Number.isInteger(camera.height) ? camera.height : null,
                    sizeBytes: Number.isFinite(camera.sizeBytes) ? camera.sizeBytes : null,
                    updatedAt: camera.updatedAt || Date.now(),
                };
                this.snapshot.vision.available = this.snapshot.vision.available || camera.available === true;
                this.snapshot.vision.updatedAt = Date.now();
            }
        } catch (error) {
            this.snapshot.robot = {
                ...this.snapshot.robot,
                connected: false,
                lastError: error.message,
                updatedAt: Date.now(),
            };
        }
        return this.getSnapshot();
    }

    recordVisionCapture(filename) {
        if (!filename) return;
        this.snapshot.vision.available = true;
        this.snapshot.vision.lastCapture = {
            filename,
            ts: Date.now(),
        };
        this.snapshot.vision.updatedAt = Date.now();
    }

    recordVisionAnalysis(filename, analysis, meta = {}) {
        this.recordVisionCapture(filename);
        this.snapshot.vision.lastAnalysis = {
            filename: filename || this.snapshot.vision.lastCapture?.filename || null,
            kind: meta.kind || 'generic',
            routeType: meta.routeType || null,
            targetObject: meta.targetObject || null,
            prompt: normalizeText(meta.prompt, 180),
            summary: normalizeText(analysis, 260),
            ts: Date.now(),
        };
        this.snapshot.vision.updatedAt = Date.now();
    }

    recordAudioTranscript(payload = {}) {
        const transcript = normalizeText(payload.transcript, 220);
        if (!transcript) return;
        this.snapshot.audio.lastTranscript = {
            transcript,
            username: payload.username || null,
            provider: payload.provider || this.snapshot.audio.provider || null,
            ts: payload.ts || Date.now(),
        };
        this.snapshot.audio.updatedAt = Date.now();
    }

    setSpeechState(speaking, message = null) {
        this.snapshot.audio.speaking = speaking === true;
        if (message) {
            this.snapshot.audio.lastSpeech = {
                message: normalizeText(message, 160),
                ts: Date.now(),
            };
        }
        this.snapshot.audio.updatedAt = Date.now();
    }

    recordNavigationPlan(plan = null) {
        this.snapshot.navigation.activePlan = plan ? cloneJson(plan) : null;
        this.snapshot.navigation.updatedAt = Date.now();
    }

    recordNavigationProgress(progress = null) {
        this.snapshot.navigation.lastProgress = progress ? cloneJson(progress) : null;
        this.snapshot.navigation.updatedAt = Date.now();
    }

    applyObservation(payload = {}) {
        const sensor = String(payload.sensor || '').toLowerCase();
        if (sensor === 'stt') {
            this.recordAudioTranscript(payload);
        }
    }

    getPromptStats() {
        const lines = [];
        const robot = this.snapshot.robot;
        const vision = this.snapshot.vision;
        const audio = this.snapshot.audio;

        lines.push('Runtime: standalone robot');
        lines.push(`Robot connected: ${robot.connected ? 'yes' : 'no'}`);
        lines.push(`Robot motion: ${robot.isWalking ? `walking ${JSON.stringify(robot.walkVector)}` : 'idle'}`);
        lines.push(`Robot yaw: ${robot.yawDeg === null ? 'unknown' : robot.yawDeg}`);
        lines.push(`Robot pose: ${robot.pose || 'unknown'} -> planned ${robot.plannedPose || 'unknown'} (motion=${robot.currentMotionPage}, queue=${robot.motionQueueLength})`);
        lines.push(`Robot manual joints: ${robot.manualJointsLikelyAllowed ? 'likely allowed' : 'blocked by walk/motion'}`);
        lines.push(`Robot emotion: ${robot.emotion}${robot.emotionIdle === null ? '' : ` (ambient=${robot.emotionIdle})`}`);
        lines.push(`Robot lock: ${robot.lock?.owner ? `${robot.lock.owner} (${robot.lock.ownerType || 'unknown'})` : 'free'}`);

        if (vision.lastAnalysis?.summary) {
            const kind = vision.lastAnalysis.kind ? ` (${vision.lastAnalysis.kind})` : '';
            lines.push(`Vision${kind}: ${vision.lastAnalysis.summary}`);
        } else if (vision.lastCapture?.filename) {
            lines.push(`Vision: latest capture ${vision.lastCapture.filename}`);
        } else {
            lines.push('Vision: no recent capture');
        }

        if (vision.camera) {
            lines.push(`Camera feed: ${vision.camera.hasImage ? 'ready' : 'not ready'}${vision.camera.width && vision.camera.height ? ` ${vision.camera.width}x${vision.camera.height}` : ''}`);
        }

        if (audio.lastTranscript?.transcript) {
            lines.push(`Audio/STT: last heard "${audio.lastTranscript.transcript}"`);
        } else {
            lines.push(`Audio/STT: ${audio.sttEnabled ? 'enabled, no recent transcript' : 'disabled'}`);
        }

        if (this.snapshot.navigation.activePlan?.summary) {
            lines.push(`Navigation plan: ${this.snapshot.navigation.activePlan.summary}`);
        } else if (this.snapshot.navigation.lastProgress?.summary) {
            lines.push(`Navigation progress: ${this.snapshot.navigation.lastProgress.summary}`);
        }

        lines.push(`Battery: ${this.snapshot.battery.available ? this.snapshot.battery.level : 'unavailable'}`);
        lines.push(`Proximity: ${this.snapshot.proximity.available ? this.snapshot.proximity.distance : 'unavailable'}`);

        if (robot.lastError) {
            lines.push(`Robot status note: ${robot.lastError}`);
        }

        return lines.join('\n');
    }

    getStatusPayload() {
        const robot = this.snapshot.robot;
        return {
            health: robot.connected ? 20 : 0,
            hunger: 20,
            xp: 0,
            level: 0,
            runtime: 'standalone',
            location: {
                x: this.snapshot.location.x ?? 0,
                y: this.snapshot.location.y ?? 0,
                z: this.snapshot.location.z ?? 0,
                dimension: 'standalone',
            },
            sensors: cloneJson(this.snapshot),
        };
    }

    getSnapshot() {
        return cloneJson(this.snapshot);
    }
}
