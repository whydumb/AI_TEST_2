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
        // Initialize robot controller
        this.robotController = createRobotController({ debug: true });
    }

    init() {
        // Check robot connection (optional)
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
            {
                name: '!dancePoping',
                description: 'Dance poping with real robot.',
                params: {
                    'duration': {
                        type: 'int', 
                        description: 'Duration in milliseconds (e.g., 1000 for 1 second).'
                    },
                },
                perform: runAsAction(async (agent, duration) => {
                    agent.bot.chat("I am dancing~");
                    
                    try {
                        await self.robotController.waveHand();
                        console.log('🤖 Robot waving hand!');
                    } catch (error) {
                        console.warn('🤖 Robot command failed:', error.message);
                    }
                    
                    agent.bot.setControlState("jump", true);
                    await new Promise((resolve) => setTimeout(resolve, duration));
                    agent.bot.setControlState("jump", false);
                }),
            },
            
            // ===== Greeting Actions =====
            {
                name: '!robotWave',
                description: 'Make the robot wave hand.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Waving hand! 👋");
                    await self.robotController.waveHand();
                }),
            },
            
            {
                name: '!robotApplaud',
                description: 'Make the robot applaud.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Applauding! 👏");
                    await self.robotController.applaud();
                }),
            },
            
            {
                name: '!robotHi',
                description: 'Make the robot tilt and say hi.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Hi there! 🙇");
                    await self.robotController.tiltHi();
                }),
            },
            
            {
                name: '!robotTalk1',
                description: 'Make the robot perform talking gesture 1.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Let me explain... 💬");
                    await self.robotController.talk1();
                }),
            },
            
            {
                name: '!robotTalk2',
                description: 'Make the robot perform talking gesture 2.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("And another thing... 💬");
                    await self.robotController.talk2();
                }),
            },
            
            // ===== Soccer Actions =====
            {
                name: '!robotKickRight',
                description: 'Make the robot kick with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Right kick! ⚽");
                    await self.robotController.rightKick();
                }),
            },
            
            {
                name: '!robotKickLeft',
                description: 'Make the robot kick with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Left kick! ⚽");
                    await self.robotController.leftKick();
                }),
            },
            
            {
                name: '!robotPassRight',
                description: 'Make the robot pass with right foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Passing right! ⚽");
                    await self.robotController.rightPass();
                }),
            },
            
            {
                name: '!robotPassLeft',
                description: 'Make the robot pass with left foot.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Passing left! ⚽");
                    await self.robotController.leftPass();
                }),
            },
            
            // ===== Expression Actions =====
            {
                name: '!robotYes',
                description: 'Make the robot nod yes.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Yes! ✅");
                    await self.robotController.nodYes();
                }),
            },
            
            {
                name: '!robotNo',
                description: 'Make the robot shake head no.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("No! ❌");
                    await self.robotController.shakeNo();
                }),
            },
            
            {
                name: '!robotArmYes',
                description: 'Make the robot express yes with arms.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Yes with arms! 🙌");
                    await self.robotController.armYes();
                }),
            },
            
            {
                name: '!robotArmHeadYes',
                description: 'Make the robot express yes with arms and head.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Big yes! 🙌");
                    await self.robotController.armHeadYes();
                }),
            },
            
            {
                name: '!robotStretch',
                description: 'Make the robot stretch.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Stretching! 🤸");
                    await self.robotController.stretch();
                }),
            },
            
            {
                name: '!robotJump',
                description: 'Make the robot jump.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Jumping! 🦘");
                    await self.robotController.jump();
                }),
            },
            
            {
                name: '!robotQuickJump',
                description: 'Make the robot do a quick jump.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Quick jump! ⚡");
                    await self.robotController.quickJump();
                }),
            },
            

        ];
    }
}
