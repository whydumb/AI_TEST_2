function trimText(value, limit = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function cloneTask(task) {
    if (!task || typeof task !== 'object') return null;
    return {
        id: task.id || null,
        type: task.type || null,
        targetObject: task.targetObject || null,
        grounded: task.grounded === true,
        objectPoseHint: task.objectPoseHint || null,
        distanceHint: task.distanceHint || null,
        headingHintDeg: Number.isFinite(task.headingHintDeg) ? task.headingHintDeg : null,
        navigationState: task.navigationState ? JSON.parse(JSON.stringify(task.navigationState)) : null,
        awaitingSlot: task.awaitingSlot || null,
        status: task.status || null,
    };
}

function pushRecent(list, entry, maxItems = 6) {
    if (!entry) return list;
    list.push(entry);
    if (list.length > maxItems) {
        list.splice(0, list.length - maxItems);
    }
    return list;
}

function createPlanLedger(initialGoal = null) {
    return {
        goal: trimText(initialGoal, 220) || null,
        currentStep: null,
        evidence: [],
        lastResult: null,
        navigation: null,
    };
}

export class StandaloneTask {
    constructor(agent, memoryBank, taskId = null, taskStartTime = null) {
        this.agent = agent;
        this.memory_bank = memoryBank;
        this.task_id = taskId;
        this.taskStartTime = taskStartTime || Date.now();
        this.blocked_actions = [];
        this.externalTask = null;
        this.goalPrompt = null;
        this.conversationPrompt = null;
        this.taskType = null;
        this.taskTimeout = null;
        this.timeoutTriggered = false;
        this.activeTask = null;
        this.pendingConfirmation = null;
        this.lastUserRequest = null;
        this.lastResolvedTarget = null;
        this.lastCompletedTask = null;
        this.lastFailedAction = null;
        this.lastRoute = null;
        this.recentRoutes = [];
        this.recoveryCount = 0;
        this.lastObservationCheck = null;
        this.recentObservationChecks = [];
        this.lastObsActionPair = null;
        this.recentObsActionPairs = [];
        this.planLedger = createPlanLedger();
        this.recentRequests = [];
        this.recentCommandResults = [];
    }

    _rememberPlanLedger() {
        this.memory_bank?.remember('plan_ledger', {
            goal: this.planLedger.goal || null,
            currentStep: this.planLedger.currentStep || null,
            lastResult: this.planLedger.lastResult || null,
            evidence: this.planLedger.evidence.slice(-5),
        });
    }

    applyExternalTaskDefinition(taskDefinition = null) {
        if (!taskDefinition) return;
        this.externalTask = taskDefinition;
        this.task_id = taskDefinition.id || this.task_id;
        this.goalPrompt = taskDefinition.goalPrompt || null;
        this.conversationPrompt = taskDefinition.conversationPrompt || null;
        this.taskType = taskDefinition.type || null;
        this.taskTimeout = Number.isFinite(taskDefinition.timeout) ? taskDefinition.timeout : null;
        this.blocked_actions = Array.isArray(taskDefinition.blockedActions) ? taskDefinition.blockedActions.slice() : [];

        this.memory_bank?.remember('standalone_external_task', {
            id: this.task_id,
            type: this.taskType,
            goalPrompt: this.goalPrompt,
            timeout: this.taskTimeout,
            blockedActions: this.blocked_actions,
        });

        if (this.goalPrompt) {
            this.setPlanGoal(this.goalPrompt, { source: 'task_definition' });
        }
    }

    rememberIncomingRequest(source, message) {
        const entry = {
            source: source || 'unknown',
            message: trimText(message, 180),
            ts: Date.now(),
        };
        this.lastUserRequest = entry;
        pushRecent(this.recentRequests, entry, 8);
        this.memory_bank?.remember('last_user_request', entry);
    }

    syncFromExecutive(executive) {
        if (!executive) return;

        this.activeTask = cloneTask(executive.activeTask);
        this.pendingConfirmation = executive.pendingConfirmation
            ? {
                taskId: executive.pendingConfirmation.taskId || null,
                prompt: trimText(executive.pendingConfirmation.prompt, 180),
                awaitingSlot: executive.pendingConfirmation.awaitingSlot || null,
            }
            : null;

        if (this.activeTask?.targetObject) {
            this.lastResolvedTarget = this.activeTask.targetObject;
            this.memory_bank?.remember('last_resolved_target', this.lastResolvedTarget);
        }

        this.memory_bank?.remember('active_task', this.activeTask);
        this.memory_bank?.remember('pending_confirmation', this.pendingConfirmation);
    }

    recordCommandExecution(execution, requestText = null, taskSnapshot = null) {
        if (!execution?.executed) return;

        const entry = {
            ts: Date.now(),
            commandName: execution.commandName || null,
            success: execution.success !== false,
            error: execution.error || execution.result?.error || null,
            requestText: trimText(requestText, 120),
            task: cloneTask(taskSnapshot || this.activeTask),
        };

        pushRecent(this.recentCommandResults, entry, 8);
        this.memory_bank?.remember('last_command_execution', entry);

        if (entry.success) {
            this.lastCompletedTask = entry.task || (entry.commandName ? { type: entry.commandName, status: 'completed' } : null);
            this.lastFailedAction = null;
            this.memory_bank?.forget('last_failed_action');
            this.memory_bank?.remember('last_completed_task', this.lastCompletedTask);
        } else {
            this.lastFailedAction = entry;
            this.memory_bank?.remember('last_failed_action', entry);
        }
    }

    recordRoute(route, requestText = null) {
        if (!route?.type) return;

        const entry = {
            ts: Date.now(),
            type: route.type,
            mode: route.mode || 'generic',
            source: route.source || 'unknown',
            confidence: Number.isFinite(route.confidence) ? Number(route.confidence.toFixed(2)) : null,
            reason: trimText(route.reason, 120),
            requestText: trimText(requestText, 120),
        };

        this.lastRoute = entry;
        pushRecent(this.recentRoutes, entry, 8);
        if (entry.type === 'recovery') {
            this.recoveryCount += 1;
        }

        this.memory_bank?.remember('last_route', entry);
        this.memory_bank?.remember('recovery_count', this.recoveryCount);
    }

    recordObservationCheck(kind, summary, meta = {}) {
        const text = trimText(summary, 220);
        if (!text) return;

        const entry = {
            ts: Date.now(),
            kind: kind || 'generic',
            summary: text,
            status: meta.status || null,
            keepTaskOpen: meta.keepTaskOpen === true,
            commandName: meta.commandName || null,
        };

        this.lastObservationCheck = entry;
        pushRecent(this.recentObservationChecks, entry, 8);
        this.memory_bank?.remember('last_observation_check', entry);
        this.appendEvidence(`observation_${kind || 'generic'}`, text, {
            status: meta.status || null,
            commandName: meta.commandName || null,
            keepTaskOpen: meta.keepTaskOpen === true,
        });
    }

    recordObsActionPair(pair = null) {
        if (!pair?.action?.token) return;

        const entry = {
            ts: pair.ts || Date.now(),
            token: pair.action.token,
            family: pair.action.family || null,
            primitive: pair.action.primitive || null,
            origin: pair.action.origin || null,
            motionClamped: pair.action.motionClamped === true,
            success: pair.outcome?.success === true,
            routeType: pair.route?.type || null,
            keepTaskOpen: pair.observationAfter?.keepTaskOpen === true,
            preObservation: trimText(pair.observationBefore?.summary, 180),
            postObservation: trimText(pair.observationAfter?.summary, 180),
        };

        this.lastObsActionPair = entry;
        pushRecent(this.recentObsActionPairs, entry, 8);
        this.memory_bank?.remember('last_obs_action_pair', entry);
    }

    setPlanGoal(goalText, meta = {}) {
        const text = trimText(goalText, 220);
        if (!text) return;
        this.planLedger.goal = text;
        if (meta.resetStep === true) {
            this.planLedger.currentStep = null;
        }
        this._rememberPlanLedger();
    }

    startPlanStep(stepText, meta = {}) {
        const text = trimText(stepText, 180);
        if (!text) return;

        this.planLedger.currentStep = {
            text,
            ts: Date.now(),
            routeType: meta.routeType || null,
            targetObject: meta.targetObject || null,
            status: meta.status || 'in_progress',
            navigationStep: meta.navigationStep || null,
        };
        this._rememberPlanLedger();
    }

    setNavigationPlan(plan = null) {
        if (!plan || !Array.isArray(plan.waypoints) || plan.waypoints.length === 0) {
            this.planLedger.navigation = null;
            this._rememberPlanLedger();
            return;
        }

        this.planLedger.navigation = {
            summary: trimText(plan.summary, 220),
            status: plan.status || 'planned',
            currentIndex: Number.isInteger(plan.currentIndex) ? plan.currentIndex : 0,
            totalWaypoints: plan.waypoints.length,
            waypoints: plan.waypoints.map((waypoint, index) => ({
                index,
                label: trimText(waypoint.label, 120),
                commandText: trimText(waypoint.commandText, 120),
                reason: trimText(waypoint.reason, 140),
                status: waypoint.status || (index === 0 ? 'queued' : 'pending'),
            })),
        };
        this._rememberPlanLedger();
    }

    recordNavigationProgress(progress = {}) {
        if (!this.planLedger.navigation) return;

        if (Number.isInteger(progress.currentIndex)) {
            this.planLedger.navigation.currentIndex = progress.currentIndex;
        }
        if (progress.status) {
            this.planLedger.navigation.status = progress.status;
        }
        if (Number.isInteger(progress.waypointIndex) && this.planLedger.navigation.waypoints[progress.waypointIndex]) {
            this.planLedger.navigation.waypoints[progress.waypointIndex].status = progress.waypointStatus || progress.status || 'in_progress';
        }
        this._rememberPlanLedger();
    }

    clearNavigationPlan() {
        this.planLedger.navigation = null;
        this._rememberPlanLedger();
    }

    appendEvidence(kind, text, meta = {}) {
        const summary = trimText(text, 180);
        if (!summary) return;

        const entry = {
            ts: Date.now(),
            kind: kind || 'note',
            text: summary,
            status: meta.status || null,
            commandName: meta.commandName || null,
            targetObject: meta.targetObject || null,
            keepTaskOpen: meta.keepTaskOpen === true,
            success: meta.success === true,
        };
        pushRecent(this.planLedger.evidence, entry, 8);
        this._rememberPlanLedger();
    }

    finishPlanStep(resultText, meta = {}) {
        const summary = trimText(resultText, 180);
        const status = meta.status || (meta.success === false ? 'failed' : 'completed');
        this.planLedger.lastResult = {
            ts: Date.now(),
            text: summary,
            status,
            commandName: meta.commandName || null,
            keepTaskOpen: meta.keepTaskOpen === true,
            success: meta.success === true,
        };

        if (this.planLedger.currentStep) {
            this.planLedger.currentStep.status = status;
        }
        if (meta.keepTaskOpen !== true) {
            this.planLedger.currentStep = null;
            if (status === 'completed') {
                this.planLedger.navigation = null;
            }
        }
        this._rememberPlanLedger();
    }

    checkTimeout() {
        if (!Number.isFinite(this.taskTimeout) || this.taskTimeout <= 0 || this.timeoutTriggered) {
            return null;
        }

        const elapsedSecs = (Date.now() - this.taskStartTime) / 1000;
        if (elapsedSecs < this.taskTimeout) {
            return null;
        }

        this.timeoutTriggered = true;
        return {
            message: `Assigned task ${this.task_id || 'unknown'} timed out after ${this.taskTimeout} seconds.`,
            elapsedSecs,
        };
    }

    buildMemorySummary(sensorSummary = '') {
        const lines = [];

        lines.push(`Runtime task id: ${this.task_id || 'none'}`);
        if (this.taskType) {
            lines.push(`Runtime task type: ${this.taskType}`);
        }
        if (this.goalPrompt) {
            lines.push(`Assigned goal: ${trimText(this.goalPrompt, 200)}`);
        }
        if (this.planLedger.goal) {
            lines.push(`Plan goal: ${this.planLedger.goal}`);
        }
        if (this.conversationPrompt) {
            lines.push(`Task coordination note: ${trimText(this.conversationPrompt, 180)}`);
        }
        if (Number.isFinite(this.taskTimeout) && this.taskTimeout > 0) {
            const elapsedSecs = Math.max(0, Math.round((Date.now() - this.taskStartTime) / 1000));
            lines.push(`Task timeout: ${elapsedSecs}s elapsed of ${this.taskTimeout}s`);
        }

        if (this.activeTask) {
            lines.push(
                `Active task: ${[
                    this.activeTask.type || 'unknown',
                    this.activeTask.targetObject ? `target=${this.activeTask.targetObject}` : null,
                    this.activeTask.objectPoseHint ? `pose=${this.activeTask.objectPoseHint}` : null,
                    this.activeTask.distanceHint ? `distance=${this.activeTask.distanceHint}` : null,
                    Number.isFinite(this.activeTask.headingHintDeg) ? `heading=${this.activeTask.headingHintDeg}` : null,
                    this.activeTask.navigationState?.status ? `nav=${this.activeTask.navigationState.status}` : null,
                    this.activeTask.status ? `status=${this.activeTask.status}` : null,
                ].filter(Boolean).join(', ')}`
            );
        } else {
            lines.push('Active task: none');
        }

        if (this.planLedger.currentStep?.text) {
            lines.push(
                `Plan step: ${this.planLedger.currentStep.text}${this.planLedger.currentStep.targetObject ? ` (target=${this.planLedger.currentStep.targetObject})` : ''}${this.planLedger.currentStep.status ? ` [${this.planLedger.currentStep.status}]` : ''}`
            );
        }

        if (this.planLedger.lastResult?.text) {
            lines.push(
                `Plan result: ${this.planLedger.lastResult.text}${this.planLedger.lastResult.status ? ` [${this.planLedger.lastResult.status}]` : ''}`
            );
        }

        if (this.planLedger.navigation?.summary) {
            lines.push(
                `Navigation plan: ${this.planLedger.navigation.summary}${this.planLedger.navigation.status ? ` [${this.planLedger.navigation.status}]` : ''}${Number.isInteger(this.planLedger.navigation.currentIndex) ? ` step=${this.planLedger.navigation.currentIndex + 1}/${this.planLedger.navigation.totalWaypoints}` : ''}`
            );
        }

        if (this.pendingConfirmation?.prompt) {
            lines.push(`Awaiting confirmation: ${this.pendingConfirmation.prompt}`);
        }

        if (this.lastResolvedTarget) {
            lines.push(`Last resolved target: ${this.lastResolvedTarget}`);
        }

        if (this.lastFailedAction?.commandName) {
            lines.push(
                `Recent failed action: ${this.lastFailedAction.commandName}${this.lastFailedAction.error ? ` (${trimText(this.lastFailedAction.error, 120)})` : ''}`
            );
        }

        if (this.lastRoute?.type) {
            lines.push(
                `Last route: ${this.lastRoute.type}${this.lastRoute.mode ? ` (${this.lastRoute.mode})` : ''}${this.lastRoute.reason ? ` - ${this.lastRoute.reason}` : ''}`
            );
        }

        if (this.lastObservationCheck?.summary) {
            lines.push(
                `Last observation check: ${this.lastObservationCheck.kind}${this.lastObservationCheck.status ? ` (${this.lastObservationCheck.status})` : ''} - ${this.lastObservationCheck.summary}`
            );
        }

        if (this.lastObsActionPair?.token) {
            lines.push(
                `Last obs-action pair: ${this.lastObsActionPair.token}${this.lastObsActionPair.motionClamped ? ' [shortened]' : ''}${this.lastObsActionPair.routeType ? ` via ${this.lastObsActionPair.routeType}` : ''}${this.lastObsActionPair.success ? ' ok' : ' failed'}`
            );
        }

        if (this.lastCompletedTask?.type || this.lastCompletedTask?.commandName) {
            lines.push(`Recent completed task: ${this.lastCompletedTask.type || this.lastCompletedTask.commandName}`);
        }

        const recentRequests = this.recentRequests
            .slice(-3)
            .map((entry) => `${entry.source}: ${entry.message}`)
            .filter(Boolean);
        if (recentRequests.length > 0) {
            lines.push(`Recent requests: ${recentRequests.join(' | ')}`);
        }

        const recentResults = this.recentCommandResults
            .slice(-3)
            .map((entry) => `${entry.commandName || 'unknown'}=${entry.success ? 'ok' : 'failed'}`)
            .filter(Boolean);
        if (recentResults.length > 0) {
            lines.push(`Recent command results: ${recentResults.join(', ')}`);
        }

        const recentRoutes = this.recentRoutes
            .slice(-3)
            .map((entry) => `${entry.type}${entry.mode ? `:${entry.mode}` : ''}`)
            .filter(Boolean);
        if (recentRoutes.length > 0) {
            lines.push(`Recent routes: ${recentRoutes.join(', ')}`);
        }

        if (this.recoveryCount > 0) {
            lines.push(`Recovery turns: ${this.recoveryCount}`);
        }

        const recentObservationChecks = this.recentObservationChecks
            .slice(-2)
            .map((entry) => `${entry.kind}${entry.status ? `:${entry.status}` : ''}`)
            .filter(Boolean);
        if (recentObservationChecks.length > 0) {
            lines.push(`Recent observation checks: ${recentObservationChecks.join(', ')}`);
        }

        const recentObsActionPairs = this.recentObsActionPairs
            .slice(-3)
            .map((entry) => `${entry.token}${entry.motionClamped ? '[short]' : ''}${entry.success ? '=ok' : '=fail'}`)
            .filter(Boolean);
        if (recentObsActionPairs.length > 0) {
            lines.push(`Recent obs-action pairs: ${recentObsActionPairs.join(', ')}`);
        }

        const recentPlanEvidence = this.planLedger.evidence
            .slice(-3)
            .map((entry) => `${entry.kind}:${entry.text}`)
            .filter(Boolean);
        if (recentPlanEvidence.length > 0) {
            lines.push(`Plan evidence: ${recentPlanEvidence.join(' | ')}`);
        }

        if (sensorSummary) {
            lines.push(sensorSummary);
        }

        return lines.filter(Boolean).join('\n');
    }
}
