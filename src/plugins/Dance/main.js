// src/plugins/Dance/main.js
// ============================================================
// DANCE PLUGIN - Uses centralized RobotService from mind_server
// All robot control goes through mind_server to prevent conflicts
// ============================================================

import { Vec3 } from 'vec3';
import * as skills from '../../agent/library/skills.js';
import * as world from '../../agent/library/world.js';
import * as mc from '../../utils/mcdata.js';
import { runAsAction } from '../../agent/commands/actions.js';

// Import centralized RobotService from mind_server
import { getRobotService } from '../../server/mind_server.js';

export class PluginInstance {
    constructor(agent) {
        this.agent = agent;
        // Use centralized RobotService instead of creating own instance
        this.robot = getRobotService();
        this.agentName = agent.name || 'agent';
    }

    init() {
        // Connection check
        this.robot.ping()
            .then(online => {
                console.log(`🤖 Robot ${online ? 'connected' : 'offline'} (via MindServer)`);
            })
            .catch(err => {
                console.warn('🤖 Robot controller init warning:', err.message);
            });
    }

    getPluginActions() {
        const self = this;

        return [
            // ============================================================
            // COMPLEX TASKS (External Brain / Puppet Mode)
            // Heavy tasks are delegated to external high-performance PC
            // ============================================================
            {
                name: '!robotFetch',
                description: 'Order the robot to fetch an object. Uses External RL Computer. (Complexity: High)',
                params: {
                    'objectName': { type: 'string', description: 'Name of the object to fetch (e.g., "towel", "cup")' }
                },
                perform: runAsAction(async (agent, objectName) => {
                    try {
                        // 1. Check if robot is available (not locked by external RL)
                        const canRun = self.robot.canAgentExecute(self.agentName);
                        if (!canRun) {
                            const lockStatus = self.robot.getLockStatus();
                            agent.bot.chat(`🚫 Robot is currently busy with ${lockStatus.taskType || 'external task'}.`);
                            return;
                        }

                        agent.bot.chat(`🤖 Asking External Brain to fetch: ${objectName}...`);

                        // 2. Trigger external RL task
                        // This acquires lock for external_rl and notifies external PC
                        const result = await self.robot.triggerExternalRL('fetch_object', { 
                            target: objectName,
                            requester: self.agentName 
                        });

                        if (result.success) {
                            agent.bot.chat(`✅ Task started! (ID: ${result.task_id})`);
                        } else {
                            agent.bot.chat(`❌ Failed to start task: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('🤖 Robot fetch failed:', error.message);
                        agent.bot.chat(`❌ Failed to start fetch task: ${error.message}`);
                    }
                }),
            },

            // ============================================================
            // EMOTIONAL EXPRESSIONS (Simple Motions)
            // Direct motion commands to C++ server (with lock check)
            // ============================================================
            {
                name: '!dancePoping',
                description: 'Dance poping with real robot - makes both Minecraft bot and physical robot jump simultaneously.',
                params: {
                    'duration': {
                        type: 'int',
                        description: 'Duration in milliseconds (e.g., 1000 for 1 second).'
                    },
                },
                perform: runAsAction(async (agent, duration) => {
                    try {
                        // Check if agent can execute motion
                        if (!self.robot.canAgentExecute(self.agentName)) {
                            console.log(`🔒 [Dance] Motion blocked - robot locked`);
                            return;
                        }

                        // Execute robot jump + Minecraft jump simultaneously
                        await Promise.all([
                            self.robot.jump(self.agentName),
                            (async () => {
                                agent.bot.setControlState("jump", true);
                                await new Promise((resolve) => setTimeout(resolve, duration));
                                agent.bot.setControlState("jump", false);
                            })()
                        ]);
                        console.log('🤖 Robot dance completed');
                    } catch (error) {
                        console.warn('🤖 Robot dance failed:', error.message);
                    }
                }),
            },

            // ===== Greeting Actions =====
            {
                name: '!robotWave',
                description: '**USE WHEN GREETING/SAYING HELLO/GOODBYE** - Wave hand to greet someone or say goodbye.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.waveHand(self.agentName);
                        if (result.success) {
                            console.log('🤖 Robot waved hand');
                        } else {
                            console.log(`🔒 Robot wave blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotApplaud',
                description: '**USE WHEN CELEBRATING/PRAISING** - Clap hands to celebrate, praise, or show appreciation.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.applaud(self.agentName);
                        if (result.success) {
                            console.log('🤖 Robot applauded');
                        } else {
                            console.log(`🔒 Robot applaud blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotHi',
                description: '**USE WHEN MAKING A POLITE GREETING** - Tilt head and bow slightly to show respect or polite greeting.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.tiltHi(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot hi blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotTalk1',
                description: '**USE WHEN STARTING TO EXPLAIN/TALK** - Make talking gesture 1 when beginning to explain something.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.talk1(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot talk1 blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotTalk2',
                description: '**USE WHEN CONTINUING EXPLANATION** - Make talking gesture 2 when continuing to explain.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.talk2(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot talk2 blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            // ===== Soccer Actions (Active) =====
            {
                name: '!robotKickRight',
                description: '**USE WHEN PLAYING SOCCER/BEING ACTIVE** - Kick with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.rightKick(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot kick blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotKickLeft',
                description: '**USE WHEN PLAYING SOCCER/BEING ACTIVE** - Kick with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.leftKick(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot kick blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotPassRight',
                description: '**USE WHEN COOPERATING/TEAMWORK** - Pass with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.rightPass(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot pass blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotPassLeft',
                description: '**USE WHEN COOPERATING/TEAMWORK** - Pass with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.leftPass(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot pass blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            // ===== Expression Actions (Reaction) =====
            {
                name: '!robotYes',
                description: '**USE WHEN AGREEING/CONFIRMING** - Nod head to show agreement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.nodYes(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot yes blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotNo',
                description: '**USE WHEN DISAGREEING/DENYING** - Shake head to show disagreement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.shakeNo(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot no blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotArmYes',
                description: '**USE WHEN STRONGLY AGREEING** - Express strong agreement with arms.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.armYes(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot armYes blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotArmHeadYes',
                description: '**USE WHEN EXTREMELY EXCITED** - Express maximum agreement with arms and head.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.armHeadYes(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot armHeadYes blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotStretch',
                description: '**USE WHEN SHY/EMBARRASSED** - Stretch body.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.stretch(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot stretch blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotJump',
                description: '**USE WHEN EXCITED/HAPPY** - Jump to show excitement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.jump(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot jump blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            {
                name: '!robotQuickJump',
                description: '**USE WHEN SURPRISED** - Quick jump.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const result = await self.robot.quickJump(self.agentName);
                        if (!result.success) {
                            console.log(`🔒 Robot quickJump blocked: ${result.error}`);
                        }
                    } catch (error) {
                        console.warn('Fail:', error.message);
                    }
                }),
            },

            // ============================================================
            // LOCK STATUS CHECK (for debugging/monitoring)
            // ============================================================
            {
                name: '!robotStatus',
                description: 'Check robot connection and lock status.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        const status = await self.robot.getStatus();
                        const lockStatus = self.robot.getLockStatus();
                        
                        let msg = `🤖 Robot: ${status.connected ? 'Connected' : 'Offline'}`;
                        if (lockStatus.isLocked) {
                            msg += ` | Lock: ${lockStatus.owner} (${lockStatus.ownerType})`;
                            if (lockStatus.taskType) {
                                msg += ` - ${lockStatus.taskType}`;
                            }
                        } else {
                            msg += ` | Lock: Free`;
                        }
                        
                        agent.bot.chat(msg);
                        console.log('🤖 Robot status:', { status, lockStatus });
                    } catch (error) {
                        agent.bot.chat(`❌ Robot status check failed: ${error.message}`);
                    }
                }),
            },
        ];
    }
}
