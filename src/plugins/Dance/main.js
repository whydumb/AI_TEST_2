// src/plugins/Dance/main.js
import { Vec3 } from 'vec3';
import * as skills from '../../agent/library/skills.js';
import * as world from '../../agent/library/world.js';
import * as mc from '../../utils/mcdata.js';
import { runAsAction } from '../../agent/commands/actions.js';
import { createRobotController } from '../../utils/robot_controller.js';

export class PluginInstance {
    constructor(agent) {
        this.agent = agent;
        // 로봇 컨트롤러 초기화 (디버그 모드)
        this.robotController = createRobotController({ debug: true });
    }

    init() {
        // 연결 확인 (옵션)
        this.robotController.ping()
            .then(online => {
                console.log(`🤖 Robot ${online ? 'connected' : 'offline'}`);
            })
            .catch(err => {
                console.warn('🤖 Robot controller init warning:', err.message);
            });
    }

    getPluginActions() {
        const self = this; // Important: capture 'this' context
        
        return [
            // ============================================================
            // 🧠 COMPLEX TASKS (External Brain / Puppet Mode)
            // 무거운 작업은 C++ 서버가 아니라 외부 고성능 PC로 위임
            // ============================================================
            {
                name: '!robotFetch',
                description: 'Order the robot to fetch an object. Uses External RL Computer. (Complexity: High)',
                params: {
                    'objectName': { type: 'string', description: 'Name of the object to fetch (e.g., "towel", "cup")' }
                },
                perform: runAsAction(async (agent, objectName) => {
                    try {
                        // 1. 로봇이 현재 사용 가능한지(Locked 상태가 아닌지) 확인
                        const canRun = await self.robotController.canAgentExecute();
                        if (!canRun) {
                            agent.bot.chat("🚫 Robot is currently busy with another external task.");
                            return;
                        }

                        agent.bot.chat(`🤖 Asking External Brain to fetch: ${objectName}...`);
                        
                        // 2. 외부 PC(RL 서버)에 태스크 위임 요청
                        // C++ 서버는 건드리지 않고, 외부 PC가 C++ 서버에 락을 걸고 제어하게 됨
                        const result = await self.robotController.triggerExternalRL('fetch_object', { target: objectName });
                        
                        agent.bot.chat(`✅ Task started! (ID: ${result.task_id})`);
                    } catch (error) {
                        console.warn('🤖 Robot fetch failed:', error.message);
                        agent.bot.chat(`❌ Failed to start fetch task: ${error.message}`);
                    }
                }),
            },

            // ============================================================
            // 😊 EMOTIONAL EXPRESSIONS (Simple Motions)
            // C++ 서버에 저장된 단순 모션 ID만 호출 (가벼움)
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
                        // 로봇 모드 체크
                        if (!(await self.robotController.canAgentExecute())) return;

                        // 동시 실행: 로봇 점프 + 마인크래프트 점프
                        await Promise.all([
                            self.robotController.jump(),
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
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.waveHand();
                            console.log('🤖 Robot waved hand');
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotApplaud',
                description: '**USE WHEN CELEBRATING/PRAISING** - Clap hands to celebrate, praise, or show appreciation.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.applaud();
                            console.log('🤖 Robot applauded');
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotHi',
                description: '**USE WHEN MAKING A POLITE GREETING** - Tilt head and bow slightly to show respect or polite greeting.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.tiltHi();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotTalk1',
                description: '**USE WHEN STARTING TO EXPLAIN/TALK** - Make talking gesture 1 when beginning to explain something.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.talk1();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotTalk2',
                description: '**USE WHEN CONTINUING EXPLANATION** - Make talking gesture 2 when continuing to explain.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.talk2();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            // ===== Soccer Actions (Active) =====
            {
                name: '!robotKickRight',
                description: '**USE WHEN PLAYING SOCCER/BEING ACTIVE** - Kick with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.rightKick();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotKickLeft',
                description: '**USE WHEN PLAYING SOCCER/BEING ACTIVE** - Kick with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.leftKick();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotPassRight',
                description: '**USE WHEN COOPERATING/TEAMWORK** - Pass with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.rightPass();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotPassLeft',
                description: '**USE WHEN COOPERATING/TEAMWORK** - Pass with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.leftPass();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            // ===== Expression Actions (Reaction) =====
            {
                name: '!robotYes',
                description: '**USE WHEN AGREEING/CONFIRMING** - Nod head to show agreement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.nodYes();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotNo',
                description: '**USE WHEN DISAGREEING/DENYING** - Shake head to show disagreement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.shakeNo();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotArmYes',
                description: '**USE WHEN STRONGLY AGREEING** - Express strong agreement with arms.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.armYes();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotArmHeadYes',
                description: '**USE WHEN EXTREMELY EXCITED** - Express maximum agreement with arms and head.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.armHeadYes();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotStretch',
                description: '**USE WHEN SHY/EMBARRASSED** - Stretch body.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.stretch();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotJump',
                description: '**USE WHEN EXCITED/HAPPY** - Jump to show excitement.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.jump();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
            
            {
                name: '!robotQuickJump',
                description: '**USE WHEN SURPRISED** - Quick jump.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        if (await self.robotController.canAgentExecute()) {
                            await self.robotController.quickJump();
                        }
                    } catch (error) { console.warn('Fail:', error.message); }
                }),
            },
        ];
    }
}
