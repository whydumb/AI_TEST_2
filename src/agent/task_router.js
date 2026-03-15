export const TASK_TYPES = Object.freeze({
    CHAT: 'chat',
    QA: 'qa',
    ACTION: 'action',
    RECOVERY: 'recovery',
});

const VALID_TYPES = new Set(Object.values(TASK_TYPES));

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function includesAny(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword));
}

function createRoute(type, confidence, source, reason, mode = 'generic') {
    return {
        type,
        confidence,
        source,
        reason,
        mode,
    };
}

function wantsVision(ctx, text) {
    return ctx.environment?.shouldUsePromptedVision?.(ctx.rawMessage) === true || includesAny(text, [
        'camera',
        'vision',
        'see',
        'look',
        'image',
        'screenshot',
        'show me',
        'what do you see',
        'what can you see',
        'what is visible',
        'scene',
        'view',
        '카메라',
        '비전',
        '보여',
        '보이',
        '장면',
        '화면',
    ]);
}

function ruleRoute(ctx) {
    const text = normalizeText(ctx.rawMessage);
    const visualQuery = wantsVision(ctx, text);
    const hasRecoveryCue = includesAny(text, [
        'failed',
        'failure',
        'error',
        'stuck',
        'retry',
        'again',
        'recover',
        'recovery',
        'why did',
        'why couldnt',
        "why couldn't",
        'why did not',
        "why didn't",
        '실패',
        '오류',
        '에러',
        '복구',
        '막혔',
        '왜 못',
        '왜 안',
    ]);
    const hasActionCue = ctx.environment?.shouldPlanImmediateCommand?.(ctx.rawMessage) === true || includesAny(text, [
        'go',
        'move',
        'walk',
        'turn',
        'rotate',
        'face',
        'point',
        'gesture',
        'wave',
        'clap',
        'stop',
        'halt',
        '앞으로',
        '이동',
        '가',
        '걸어',
        '회전',
        '돌아',
        '가리켜',
        '손 흔들',
        '박수',
        '멈춰',
        '정지',
    ]);
    const hasQaCue = text.includes('?') || visualQuery || includesAny(text, [
        'status',
        'state',
        'what are you doing',
        'what can you do',
        'capability',
        'battery',
        'sensor',
        'where is',
        'where are',
        'which one',
        'is it',
        'right now',
        '상태',
        '지금 뭐',
        '가능',
        '배터리',
        '센서',
        '어디',
        '맞아',
    ]);

    if (ctx.isSelfPromptTurn) {
        return createRoute(TASK_TYPES.ACTION, 1, 'forced', 'self-prompt continuation', 'planned');
    }

    if (ctx.isSystemTurn) {
        if (ctx.task?.lastFailedAction && hasRecoveryCue) {
            return createRoute(TASK_TYPES.RECOVERY, 0.9, 'forced', 'system failure follow-up', 'diagnose');
        }
        return createRoute(TASK_TYPES.QA, 0.9, 'forced', 'system/internal turn', visualQuery ? 'vision' : 'generic');
    }

    if (ctx.executive?.pendingConfirmation || ctx.executive?.activeTask?.awaitingSlot) {
        return createRoute(TASK_TYPES.ACTION, 1, 'forced', 'pending clarification or active task slot', 'clarify');
    }

    if (ctx.task?.lastFailedAction && hasRecoveryCue) {
        return createRoute(TASK_TYPES.RECOVERY, 0.95, 'rule', 'recent failure referenced', 'diagnose');
    }

    if (hasActionCue) {
        return createRoute(
            TASK_TYPES.ACTION,
            0.92,
            'rule',
            'physical action request',
            ctx.environment?.shouldPlanImmediateCommand?.(ctx.rawMessage) ? 'planned' : 'direct'
        );
    }

    if (hasQaCue) {
        return createRoute(
            TASK_TYPES.QA,
            visualQuery ? 0.86 : 0.8,
            'rule',
            visualQuery ? 'visual or scene query' : 'state or knowledge query',
            visualQuery ? 'vision' : 'generic'
        );
    }

    return createRoute(TASK_TYPES.CHAT, 0.6, 'rule', 'default conversational fallback', 'generic');
}

function sanitizeCandidateRoute(candidate, fallback) {
    if (!candidate || typeof candidate !== 'object' || !VALID_TYPES.has(candidate.type)) {
        return fallback;
    }

    return {
        type: candidate.type,
        confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : fallback.confidence,
        source: candidate.source || 'llm',
        reason: candidate.reason || fallback.reason,
        mode: candidate.mode || fallback.mode || 'generic',
    };
}

export async function routeTaskTurn(ctx) {
    const route = ruleRoute(ctx);

    if (route.confidence < 0.72 && typeof ctx.prompter?.promptTaskRoute === 'function') {
        try {
            const llmRoute = await ctx.prompter.promptTaskRoute({
                source: ctx.source,
                rawMessage: ctx.rawMessage,
                messageForModel: ctx.messageForModel,
                executive: ctx.executive,
                task: ctx.task,
            });
            return sanitizeCandidateRoute(llmRoute, route);
        } catch (error) {
            console.warn('[TaskRouter] LLM route fallback failed:', error.message);
        }
    }

    return route;
}
