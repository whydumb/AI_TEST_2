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
                        // Send wave hand command to real robot
                        await self.robotController.waveHand();
                        console.log('🤖 Robot waving hand!');
                    } catch (error) {
                        console.warn('🤖 Robot command failed:', error.message);
                        // Continue even if robot command fails
                    }
                    
                    // Minecraft bot also jumps
                    agent.bot.setControlState("jump", true);
                    await new Promise((resolve) => setTimeout(resolve, duration));
                    agent.bot.setControlState("jump", false);
                }),
            },
            
            {
                name: '!robotWave',
                description: 'Make the robot wave hand.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Waving hand!");
                    await self.robotController.waveHand();
                }),
            },
            
            {
                name: '!robotApplaud',
                description: 'Make the robot applaud.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Applauding!");
                    await self.robotController.applaud();
                }),
            },
            
            {
                name: '!robotJump',
                description: 'Make the robot jump.',
                params: {},
                perform: runAsAction(async (agent) => {
                    agent.bot.chat("Jumping!");
                    await self.robotController.jump();
                }),
            },
        ];
    }
}
