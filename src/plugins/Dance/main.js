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
                console.log(`?? Robot ${online ? 'connected' : 'offline'}`);
            })
            .catch(err => {
                console.warn('?? Robot controller init warning:', err.message);
            });
    }

    getPluginActions() {
        const self = this; // Important: capture 'this' context
        
        return [
            
            
            {
                name: '!robotApplaud',
                description: '**USE WHEN CELEBRATING/PRAISING** - Clap hands to celebrate, praise, or show appreciation.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.applaud();
                        console.log('?? Robot applauded');
                    } catch (error) {
                        console.warn('?? Robot applaud failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotHi',
                description: '**USE WHEN MAKING A POLITE GREETING** - Tilt head and bow slightly to show respect or polite greeting.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.tiltHi();
                        console.log('?? Robot said hi');
                    } catch (error) {
                        console.warn('?? Robot tiltHi failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotTalk1',
                description: '**USE WHEN STARTING TO EXPLAIN/TALK** - Make talking gesture 1 when beginning to explain something or having a conversation.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.talk1();
                        console.log('?? Robot talk1');
                    } catch (error) {
                        console.warn('?? Robot talk1 failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotTalk2',
                description: '**USE WHEN CONTINUING EXPLANATION** - Make talking gesture 2 when continuing to explain or emphasizing a point.',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.talk2();
                        console.log('?? Robot talk2');
                    } catch (error) {
                        console.warn('?? Robot talk2 failed:', error.message);
                    }
                }),
            },
            

            
            // ===== Expression Actions =====
            {
                name: '!robotYes',
                description: '**USE WHEN AGREEING/CONFIRMING** - Nod head to show agreement, confirmation, or acceptance. Use frequently!',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.nodYes();
                        console.log('?? Robot nodded yes');
                    } catch (error) {
                        console.warn('?? Robot nodYes failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotNo',
                description: '**USE WHEN DISAGREEING/DENYING** - Shake head to show disagreement, denial, or refusal. Use frequently!',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.shakeNo();
                        console.log('?? Robot shook head no');
                    } catch (error) {
                        console.warn('?? Robot shakeNo failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotArmYes',
                description: '**USE WHEN STRONGLY AGREEING** - Express strong agreement or enthusiasm with arm gestures. Use when very positive!',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.armYes();
                        console.log('?? Robot arm yes');
                    } catch (error) {
                        console.warn('?? Robot armYes failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotArmHeadYes',
                description: '**USE WHEN EXTREMELY EXCITED/AGREEING** - Express maximum agreement or excitement with both arms and head. Use when VERY enthusiastic!',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.armHeadYes();
                        console.log('?? Robot arm+head yes');
                    } catch (error) {
                        console.warn('?? Robot armHeadYes failed:', error.message);
                    }
                }),
            },
            
            {
                name: '!robotStretch',
                description: '**USE WHEN SHY/EMBARRASSED/RELAXING** - Stretch body, use when feeling embarrassed, praised, or just relaxing. Perfect for tsundere reactions!',
                params: {},
                perform: runAsAction(async (agent) => {
                    try {
                        await self.robotController.stretch();
                        console.log('?? Robot stretched');
                    } catch (error) {
                        console.warn('?? Robot stretch failed:', error.message);
                    }
                }),
            },

        ];
    }
}
