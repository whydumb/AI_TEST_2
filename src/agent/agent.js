import fs from 'fs';
import path from 'path';
import * as logger from '../../logger.js';
import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { PluginManager } from './plugin.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import settings from '../../settings.js';
import { serverProxy } from './agent_proxy.js';
import { Task } from './tasks/tasks.js';
import { say } from './speak.js';

export class Agent {
    constructor() {
        // ...existing code...
        this._lastChatTime = Date.now();
        this._idleTriggered = false;
        this._lastModelResponseTime = Date.now();
    }
    async start(profile_fp, load_mem=false, init_message=null, count_id=0, task_path=null, task_id=null) {
        this.last_sender = null;
        // Safely attach agent instance to a global-like object so STT code can access it.
        // This works in Node.js ESM or CommonJS. If "global" doesn't exist, fallback to "globalThis".
        const globalObj = (typeof global !== 'undefined') ? global : globalThis;
        try {
            globalObj.agent = this;
        } catch(e) {
            console.warn("Failed attaching agent to global object:", e);
        }
        
        this.latestScreenshotPath = null;
        this.count_id = count_id;
        if (!profile_fp) {
            throw new Error('No profile filepath provided');
        }
        
        console.log('Starting agent initialization with profile:', profile_fp);
        
        // Initialize components with more detailed error handling
        console.log('Initializing action manager...');
        this.actions = new ActionManager(this);
        console.log('Initializing prompter...');
        this.prompter = new Prompter(this, profile_fp);
        this.name = this.prompter.getName();
        console.log('Initializing history...');
        this.history = new History(this);
        console.log('Initializing coder...');
        this.coder = new Coder(this);
        console.log('Initializing npc controller...');
        this.npc = new NPCContoller(this);
        console.log('Initializing plugin manager...');
        this.plugin = new PluginManager(this);
        console.log('Initializing memory bank...');
        this.memory_bank = new MemoryBank();
        console.log('Initializing self prompter...');
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        console.log('Initializing examples...');
        await this.prompter.initExamples();
        console.log('Initializing task...');

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, task_path, task_id, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        serverProxy.connect(this);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        initModes(this);

        

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });

        const spawnTimeout = setTimeout(() => {
            process.exit(0);
        }, 30000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
                
                // Send initial status update
                this.sendStatusUpdate();
                
                // Set up periodic status updates every 5 seconds
                this.statusUpdateInterval = setInterval(() => {
                    this.sendStatusUpdate();
                }, 5000);
              
                if (!load_mem) {
                    if (task_path !== null) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (task_path !== null) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();
              
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.vision_mode);

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    /**
     * Formats conversation history into a JSON string suitable for vision model logs.
     * This function replicates formatting logic that would ideally be centralized in `logger.js`.
     * It's placed in `agent.js` as a workaround due to previous difficulties in directly
     * modifying `logger.js` to ensure consistent vision log formatting.
     * @param {Array<Object>} conversationHistory - The conversation history array.
     * @returns {string} A JSON string representing the formatted history.
     */
    formatHistoryForVisionLog(conversationHistory) {
        if (!conversationHistory || conversationHistory.length === 0) return '';

        const formattedHistory = [];

        for (const turn of conversationHistory) {
            const formattedTurn = {
                role: turn.role || 'user',
                content: []
            };

            if (typeof turn.content === 'string') {
                formattedTurn.content.push({
                    type: 'text',
                    text: turn.content
                });
            } else if (Array.isArray(turn.content)) {
                turn.content.forEach(contentItem => {
                    if (typeof contentItem === 'string') {
                        formattedTurn.content.push({ type: 'text', text: contentItem });
                    } else if (contentItem.type === 'text' && contentItem.text) {
                        formattedTurn.content.push({ type: 'text', text: contentItem.text });
                    } else if (contentItem.type === 'image_url' && contentItem.image_url && contentItem.image_url.url) {
                        formattedTurn.content.push({ type: 'image', image: contentItem.image_url.url });
                    } else if (contentItem.type === 'image' && contentItem.image) {
                         formattedTurn.content.push({ type: 'image', image: contentItem.image });
                    }
                });
            } else if (turn.content && typeof turn.content === 'object') {
                if (turn.content.text) {
                    formattedTurn.content.push({
                        type: 'text',
                        text: turn.content.text
                    });
                }
                if (turn.content.image) {
                    formattedTurn.content.push({
                        type: 'image',
                        image: turn.content.image
                    });
                }
                if (turn.content.image_url && turn.content.image_url.url) {
                    formattedTurn.content.push({
                        type: 'image',
                        image: turn.content.image_url.url
                    });
                }
            }

            if (turn.content && formattedTurn.content.length === 0) {
                formattedTurn.content.push({ type: 'text', text: JSON.stringify(turn.content) });
            }

            formattedHistory.push(formattedTurn);
        }

        return JSON.stringify(formattedHistory);
    }


    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        if (settings.profiles.length === 1)
            this.bot.on('chat', respondFunc);

        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                await this.history.add('system', init_message, null);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) {
            if (settings.vision_mode === 'always' && this.vision_interpreter && this.vision_interpreter.camera) {
                try {
                    const screenshotFilename = await this.vision_interpreter.camera.capture();
                    this.latestScreenshotPath = screenshotFilename;
                    console.log(`[${this.name}] Captured screenshot in always_active mode: ${screenshotFilename}`);

                    const currentHistory = this.history.getHistory();

                    let imageBuffer = null;
                    if (this.latestScreenshotPath && this.vision_interpreter.fp) {
                        try {
                            const fullImagePath = path.join(this.vision_interpreter.fp, this.latestScreenshotPath);
                            imageBuffer = fs.readFileSync(fullImagePath);
                        } catch (err) {
                            console.error(`[${this.name}] Error reading image for always active log: ${err.message}`);
                        }
                    }

                    if (imageBuffer) {
                        const formattedHistoryString = this.formatHistoryForVisionLog(currentHistory);
                        logger.logVision(currentHistory, imageBuffer, "Image captured for always active vision", formattedHistoryString);
                    }

                } catch (error) {
                    console.error(`[${this.name}] Error capturing or logging screenshot in always_active mode:`, error);
                }
            }
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    let imagePathForNewActionCmd = null;
                    await this.history.add(source, message, imagePathForNewActionCmd);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \\n' + behavior_log;
            await this.history.add('system', behavior_log, null);
        }

        let imagePathForInitialMessage = null;
        if (!self_prompt && !from_other_bot && settings.vision_mode === 'always' && this.latestScreenshotPath) {
             imagePathForInitialMessage = this.latestScreenshotPath;
        }

        await this.history.add(source, message, imagePathForInitialMessage);
        if (imagePathForInitialMessage) {
            this.latestScreenshotPath = null;
        }
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive())
            max_responses = 1;
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history_for_prompt = this.history.getHistory();
            let res = await this.prompter.promptConvo(history_for_prompt);

            this._lastModelResponseTime = Date.now();

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) {
                res = truncCommandMessage(res);
                await this.history.add(this.name, res, null);
                
                if (!commandExists(command_name)) {
                    await this.history.add('system', `Command ${command_name} does not exist.`, null);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.verbose_commands) {
                    this.routeResponse(source, res);
                }
                else {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res) {
                    let imagePathForCommandResult = null;
                    if (command_name && (command_name === '!lookAtPlayer' || command_name === '!lookAtPosition' || command_name === '!captureFullView') && this.latestScreenshotPath) {
                        imagePathForCommandResult = this.latestScreenshotPath;
                    }
                    await this.history.add('system', execute_res, imagePathForCommandResult);
                    if (imagePathForCommandResult) {
                        this.latestScreenshotPath = null;
                    }
                }
                else {
                    break;
                }
            }
            else {
                await this.history.add(this.name, res, null);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            convoManager.sendToBot(to_player, message);
        }
        else {
            this.openChat(message);
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) {
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        message = message.replaceAll('\\n', ' ');

        if (serverProxy.getSocket()) {
            serverProxy.getSocket().emit('agent-response', this.name, message);
        }

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                say(to_translate, this.prompter.profile.speak_model);
            }
            this.bot.chat(message);
        }
        this._lastChatTime = Date.now();
        this._idleTriggered = false;
    }

    sendStatusUpdate() {
        if (serverProxy.getSocket() && this.bot) {
            const statusData = {
                health: this.bot.health || 20,
                hunger: this.bot.food || 20,
                xp: this.bot.experience.points || 0,
                level: this.bot.experience.level || 0,
                location: {
                    x: this.bot.entity?.position?.x || 0,
                    y: this.bot.entity?.position?.y || 0,
                    z: this.bot.entity?.position?.z || 0,
                    dimension: this.bot.game?.dimension || 'overworld'
                }
            };
            
            serverProxy.getSocket().emit('agent-status-update', this.name, statusData);
        }
    }

    startEvents() {
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        this.bot.on('end', (reason) => {
            console.warn('Bot disconnected! Killing agent process.', reason)
            this.cleanKill('Bot disconnected! Killing agent process.');
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
            
            const deathData = {
                cause: 'unknown',
                location: this.bot.entity ? {
                    x: this.bot.entity.position.x,
                    y: this.bot.entity.position.y,
                    z: this.bot.entity.position.z,
                    dimension: this.bot.game.dimension
                } : null
            };
            
            serverProxy.sendDeathEvent(this.name, deathData);
        });
        this.bot.on('kicked', (reason) => {
            console.warn('Bot kicked!', reason);
            this.cleanKill('Bot kicked! Killing agent process.');
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                
                let deathCause = 'unknown';
                if (message.includes('fell')) deathCause = 'fall_damage';
                else if (message.includes('drowned')) deathCause = 'drowning';
                else if (message.includes('burned')) deathCause = 'fire';
                else if (message.includes('blown up')) deathCause = 'explosion';
                else if (message.includes('shot')) deathCause = 'projectile';
                else if (message.includes('slain')) deathCause = 'mob';
                else if (message.includes('starved')) deathCause = 'starvation';
                else if (message.includes('suffocated')) deathCause = 'suffocation';
                else if (message.includes('lava')) deathCause = 'lava';
                else if (message.includes('void')) deathCause = 'void';
                
                const deathData = {
                    cause: deathCause,
                    message: message,
                    location: death_pos ? {
                        x: death_pos.x,
                        y: death_pos.y,
                        z: death_pos.z,
                        dimension: dimention
                    } : null
                };
                
                serverProxy.sendDeathEvent(this.name, deathData);
                
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop();
            this.bot.modes.unPauseAll();
            this.actions.resumeAction();
        });

        this.plugin.init();
        this.npc.init();

        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
        if (settings.auto_idle_trigger && settings.auto_idle_trigger.enabled) {
            const timeout = (settings.auto_idle_trigger.timeout_secs || 60) * 1000;
            if (Date.now() - this._lastModelResponseTime > timeout) {
                this._lastModelResponseTime = Date.now();
                this.handleMessage('system', settings.auto_idle_trigger.message, 1);
            }
        }
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    async cleanKill(msg='Killing agent process...', code=1) {
        if (this.statusUpdateInterval) {
            clearInterval(this.statusUpdateInterval);
        }
        
        if (this.history) {
             await this.history.add('system', msg, null);
             this.history.save();
        } else {
            console.warn("[Agent] History not initialized, cannot save cleanKill message.")
        }
        if (this.bot) {
            this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        }
        process.exit(code);
    }
    
    async checkTaskDone() {
        if (this.task && this.task.data) {
            let res = this.task.isDone();
            if (res) {
                if (this.history) {
                    await this.history.add('system', `Task ended with score : ${res.score}`, null);
                    await this.history.save();
                } else {
                     console.warn("[Agent] History not initialized, cannot save task end message.")
                }
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
