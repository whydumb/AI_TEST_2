function trimText(value, limit = 280) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function clone(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
}

export class ObservationState {
    constructor(maxAnalyses = 8) {
        this.maxAnalyses = maxAnalyses;
        this.latestFrame = null;
        this.analyses = [];
        this.robotState = null;
        this.lastAction = null;
        this.lastResult = null;
        this.taskSnapshot = null;
        this.navigationState = null;
    }

    recordFrame(filename, meta = {}) {
        if (!filename) return null;
        this.latestFrame = {
            filename,
            ts: Date.now(),
            source: meta.source || 'camera',
            reason: meta.reason || null,
        };
        return clone(this.latestFrame);
    }

    recordAnalysis(kind, filename, prompt, summary, meta = {}) {
        if (!filename || !summary) return null;

        const entry = {
            kind: kind || 'generic',
            filename,
            prompt: trimText(prompt, 180),
            summary: trimText(summary, 320),
            ts: Date.now(),
            routeType: meta.routeType || null,
            targetObject: meta.targetObject || null,
        };
        this.analyses.unshift(entry);
        if (this.analyses.length > this.maxAnalyses) {
            this.analyses.length = this.maxAnalyses;
        }
        return clone(entry);
    }

    recordRobotState(snapshot = null) {
        if (!snapshot || typeof snapshot !== 'object') return null;
        this.robotState = {
            snapshot: clone(snapshot),
            ts: Date.now(),
        };
        return clone(this.robotState);
    }

    recordTaskSnapshot(task = null) {
        if (!task || typeof task !== 'object') {
            this.taskSnapshot = null;
            return null;
        }

        this.taskSnapshot = {
            id: task.id || null,
            type: task.type || null,
            targetObject: task.targetObject || null,
            grounded: task.grounded === true,
            objectPoseHint: task.objectPoseHint || null,
            distanceHint: task.distanceHint || null,
            headingHintDeg: Number.isFinite(task.headingHintDeg) ? task.headingHintDeg : null,
            status: task.status || null,
            navigationState: clone(task.navigationState || null),
            ts: Date.now(),
        };
        return clone(this.taskSnapshot);
    }

    recordCommandExecution(execution = null, meta = {}) {
        if (!execution || typeof execution !== 'object') return null;

        this.lastAction = {
            commandName: execution.commandName || null,
            attemptedText: trimText(execution.attemptedText, 180),
            requestedText: trimText(execution.requestedText, 180),
            motionClamped: execution.motionClamped === true,
            origin: execution.origin || null,
            routeType: meta.routeType || null,
            ts: Date.now(),
        };
        this.lastResult = {
            success: execution.success === true,
            executed: execution.executed === true,
            error: trimText(execution.error || execution.result?.error, 180) || null,
            keepTaskOpen: meta.keepTaskOpen === true,
            ts: Date.now(),
        };

        return {
            lastAction: clone(this.lastAction),
            lastResult: clone(this.lastResult),
        };
    }

    recordNavigationState(navigation = null) {
        if (!navigation || typeof navigation !== 'object') {
            this.navigationState = null;
            return null;
        }

        this.navigationState = {
            ...clone(navigation),
            ts: Date.now(),
        };
        return clone(this.navigationState);
    }

    getLatestFrame() {
        return clone(this.latestFrame);
    }

    isFrameFresh(maxAgeMs = 2500) {
        return !!this.latestFrame && (Date.now() - this.latestFrame.ts) <= maxAgeMs;
    }

    getLatestAnalysis(kind = null) {
        if (!kind) {
            return clone(this.analyses[0] || null);
        }
        return clone(this.analyses.find((entry) => entry.kind === kind) || null);
    }

    getCanonicalState() {
        return {
            latestFrame: this.getLatestFrame(),
            analyses: clone(this.analyses) || [],
            robotState: clone(this.robotState),
            lastAction: clone(this.lastAction),
            lastResult: clone(this.lastResult),
            taskSnapshot: clone(this.taskSnapshot),
            navigationState: clone(this.navigationState),
        };
    }

    buildRouteContext(kind = null) {
        const frame = this.latestFrame;
        const analysis = this.getLatestAnalysis(kind) || this.getLatestAnalysis();
        const lines = [];
        const robot = this.robotState?.snapshot?.robot || null;
        const task = this.taskSnapshot;
        const navigation = this.navigationState;

        if (frame?.filename) {
            lines.push(`Latest observation frame: ${frame.filename}`);
        }
        if (analysis?.summary) {
            lines.push(`Latest ${analysis.kind} observation: ${analysis.summary}`);
        }
        if (robot) {
            lines.push(`Robot state: ${robot.connected ? 'connected' : 'disconnected'}, yaw=${robot.yawDeg ?? 'unknown'}, motion=${robot.isWalking ? 'walking' : 'idle'}, pose=${robot.pose || 'unknown'}, planned=${robot.plannedPose || 'unknown'}, motionPage=${robot.currentMotionPage ?? 0}, queue=${robot.motionQueueLength ?? 0}`);
            lines.push(`Robot control gate: ${robot.manualJointsLikelyAllowed ? 'manual joints likely allowed' : 'manual joints blocked by walk/motion'}`);
        }
        const camera = this.robotState?.snapshot?.vision?.camera || null;
        if (camera) {
            lines.push(`Camera state: ${camera.hasImage ? 'ready' : 'not ready'}${camera.width && camera.height ? ` ${camera.width}x${camera.height}` : ''}`);
        }
        if (task?.type) {
            lines.push(`Task state: ${task.type}${task.targetObject ? ` target=${task.targetObject}` : ''}${task.status ? ` status=${task.status}` : ''}`);
        }
        if (navigation?.summary) {
            lines.push(`Navigation state: ${navigation.summary}`);
        }

        return lines.join('\n');
    }
}
