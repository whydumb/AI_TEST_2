function trimText(value, limit = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function toSnakeCase(value) {
    return String(value || '')
        .replace(/^!/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function parseLiteral(token) {
    const text = String(token || '').trim();
    if (!text) return null;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
        return text.slice(1, -1);
    }
    if (/^(true|false)$/i.test(text)) {
        return /^true$/i.test(text);
    }
    const num = Number(text);
    if (Number.isFinite(num)) {
        return num;
    }
    return text;
}

function parseArgs(rawText = '') {
    const match = String(rawText || '').match(/!\w+\((.*)\)/);
    if (!match) return [];
    return match[1]
        .split(',')
        .map((token) => parseLiteral(token))
        .filter((value) => value !== null);
}

function durationBucket(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return 'default';
    if (value <= 0.8) return 'small';
    if (value <= 1.8) return 'medium';
    return 'large';
}

function buildLocomotionToken(stem, args = []) {
    return `${stem}_${durationBucket(args[0])}`;
}

export function canonicalizeAction(commandName, rawText = '') {
    const normalized = String(commandName || '').trim();
    const args = parseArgs(rawText);

    switch (normalized) {
        case '!robotWalkForward':
            return { token: buildLocomotionToken('forward', args), family: 'locomotion', primitive: 'forward', args };
        case '!robotWalkBackward':
            return { token: buildLocomotionToken('backward', args), family: 'locomotion', primitive: 'backward', args };
        case '!robotStrafeLeft':
            return { token: buildLocomotionToken('strafe_left', args), family: 'locomotion', primitive: 'strafe_left', args };
        case '!robotStrafeRight':
            return { token: buildLocomotionToken('strafe_right', args), family: 'locomotion', primitive: 'strafe_right', args };
        case '!robotTurnLeft':
            return { token: buildLocomotionToken('turn_left', args), family: 'locomotion', primitive: 'turn_left', args };
        case '!robotTurnRight':
            return { token: buildLocomotionToken('turn_right', args), family: 'locomotion', primitive: 'turn_right', args };
        case '!robotArcLeft':
            return { token: buildLocomotionToken('arc_left', args), family: 'locomotion', primitive: 'arc_left', args };
        case '!robotArcRight':
            return { token: buildLocomotionToken('arc_right', args), family: 'locomotion', primitive: 'arc_right', args };
        case '!robotWalkDistance':
            return { token: buildLocomotionToken('distance_walk', args), family: 'locomotion', primitive: 'distance_walk', args };
        case '!robotWalkVector':
            return { token: 'vector_walk', family: 'locomotion', primitive: 'vector_walk', args };
        case '!robotFaceYaw':
            return { token: 'face_yaw', family: 'orientation', primitive: 'face_yaw', args };
        case '!robotStopWalk':
            return { token: 'stop', family: 'safety', primitive: 'stop', args };
        case '!robotWave':
        case '!robotWaveHand':
            return { token: 'wave', family: 'gesture', primitive: 'wave', args };
        case '!robotApplaud':
        case '!robotApplaudLoud':
            return { token: 'applaud', family: 'gesture', primitive: 'applaud', args };
        case '!robotClap':
            return { token: 'clap', family: 'gesture', primitive: 'clap', args };
        case '!robotHi':
            return { token: 'greet', family: 'gesture', primitive: 'greet', args };
        case '!robotYes':
        case '!robotArmYes':
        case '!robotArmHeadYes':
            return { token: 'agree', family: 'gesture', primitive: 'agree', args };
        case '!robotNo':
            return { token: 'disagree', family: 'gesture', primitive: 'disagree', args };
        default:
            return {
                token: toSnakeCase(normalized),
                family: normalized.startsWith('!robot') ? 'robot_action' : 'generic',
                primitive: toSnakeCase(normalized),
                args,
            };
    }
}

export function buildObsActionPair({
    route = null,
    commandExecution = null,
    rawUserMessage = '',
    preObservation = null,
    postObservation = null,
    taskSnapshot = null,
} = {}) {
    const action = canonicalizeAction(
        commandExecution?.commandName || '',
        commandExecution?.attemptedText || ''
    );

    return {
        ts: Date.now(),
        request: trimText(rawUserMessage, 180),
        route: route
            ? {
                type: route.type || null,
                mode: route.mode || null,
                source: route.source || null,
            }
            : null,
        action: {
            token: action.token,
            family: action.family,
            primitive: action.primitive,
            commandName: commandExecution?.commandName || null,
            rawText: trimText(commandExecution?.attemptedText || '', 180),
            requestedText: trimText(commandExecution?.requestedText || '', 180),
            origin: commandExecution?.origin || null,
            motionClamped: commandExecution?.motionClamped === true,
            args: action.args,
        },
        observationBefore: preObservation
            ? {
                kind: preObservation.kind || null,
                filename: preObservation.filename || null,
                summary: trimText(preObservation.analysis || preObservation.summary || '', 260),
            }
            : null,
        observationAfter: postObservation
            ? {
                kind: 'post_action',
                filename: postObservation.filename || null,
                summary: trimText(postObservation.summary || '', 260),
                status: postObservation.status || null,
                keepTaskOpen: postObservation.keepTaskOpen === true,
            }
            : null,
        outcome: {
            executed: commandExecution?.executed === true,
            success: commandExecution?.success === true,
            error: trimText(commandExecution?.error || commandExecution?.result?.error || '', 160) || null,
        },
        task: taskSnapshot
            ? {
                id: taskSnapshot.id || null,
                type: taskSnapshot.type || null,
                targetObject: taskSnapshot.targetObject || null,
                status: taskSnapshot.status || null,
            }
            : null,
    };
}
