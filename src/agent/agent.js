// src/agent/agent.js
import fs from 'fs';
import path from 'path';
import * as logger from '../../logger.js';
import { History } from './history.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import {
  containsCommand,
  commandExists,
  executeCommand,
  truncCommandMessage,
  isAction,
  blacklistCommands,
} from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { PluginManager } from './plugin.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import settings from '../../settings.js';
import { serverProxy } from './agent_proxy.js';
import { say } from './speak.js';

const INTERNAL_LOG_MESSAGES = [
  'No response from Claude.',
  'No response from model.',
  '()',
  '.',
];

function stringifyOutcome(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch (err) {
    return String(result);
  }
}

export class Agent {
  constructor() {
    this._lastChatTime = Date.now();
    this._idleTriggered = false;
    this._lastModelResponseTime = Date.now();
    this._suppressNextOutput = false;
    this._cmdDebounce = Object.create(null);
    this.latestScreenshotPath = null;
    this.last_sender = null;
    this.shut_up = false;
    this._updateInterval = null;
    this.task = null;
  }

  async start(profile_fp, load_mem = false, init_message = null, count_id = 0, task_path = null, task_id = null) {
    if (!profile_fp) throw new Error('No profile filepath provided');

    const globalObj = typeof global !== 'undefined' ? global : globalThis;
    try { globalObj.agent = this; } catch (e) { console.warn('Failed attaching agent to global object:', e); }

    this.count_id = count_id;
    this.latestScreenshotPath = null;

    console.log('Starting agent initialization with profile:', profile_fp);

    this.actions = new ActionManager(this);
    this.prompter = new Prompter(this, profile_fp);
    this.name = this.prompter.getName();
    this.history = new History(this);
    this.memory_bank = new MemoryBank();
    this.self_prompter = new SelfPrompter(this);
    this.plugin = new PluginManager(this);
    convoManager.initAgent(this);

    await this.prompter.initExamples();

    let save_data = null;
    if (load_mem) {
      save_data = this.history.load();
    }

    this.blocked_actions = settings.blocked_actions ? [...settings.blocked_actions] : [];
    blacklistCommands(this.blocked_actions);

    serverProxy.connect(this);
    if (typeof serverProxy.login === 'function') {
      serverProxy.login();
    }

    this._initializeVision(settings.vision_mode || 'off');

    if (save_data?.self_prompt) {
      if (init_message) await this.history.add('system', init_message, null);
      await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
    } else if (init_message) {
      await this.history.add('system', init_message, null);
    }

    if (save_data?.last_sender) {
      this.last_sender = save_data.last_sender;
    }

    this.plugin.init();
    this._startUpdateLoop();

    console.log(`${this.name} ready for robot control.`);
  }

  _initializeVision(mode) {
    console.log('Initializing vision interpreter...');
    try {
      this.vision_interpreter = new VisionInterpreter(this, mode);
      console.log('✅ Vision interpreter initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize vision interpreter:', error);
      this.vision_interpreter = null;
    }
  }

  _startUpdateLoop() {
    const INTERVAL = 300;
    let last = Date.now();
    this._updateInterval = setInterval(async () => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      try {
        await this.update(delta);
      } catch (err) {
        console.error('Agent update loop error:', err);
      }
    }, INTERVAL);
  }

  async update(delta) {
    if (this.self_prompter && typeof this.self_prompter.update === 'function') {
      this.self_prompter.update(delta);
    }

    if (settings.auto_idle_trigger?.enabled) {
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

  shutUp() {
    this.shut_up = true;
    if (this.self_prompter?.isActive()) this.self_prompter.stop(false);
    convoManager.endAllConversations();
  }

  _canExecuteCommand(commandName, { self_prompt, from_other_bot }) {
    if (self_prompt || from_other_bot) return false;
    const now = Date.now();
    const last = this._cmdDebounce[commandName] || 0;
    if (now - last < 2000) return false;
    this._cmdDebounce[commandName] = now;
    return true;
  }

  async handleMessage(source, message, max_responses = null) {
    await this.checkTaskDone();
    if (!source || !message) {
      console.warn('Received empty message from', source);
      return false;
    }

    let used_command = false;
    if (max_responses === null) {
      max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
    }
    if (max_responses === -1) max_responses = Infinity;

    const self_prompt = source === 'system' || source === this.name;
    const from_other_bot = convoManager.isOtherAgent(source);

    if (!self_prompt && !from_other_bot && settings.vision_mode === 'always' && this.vision_interpreter?.camera) {
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
          logger.logVision(currentHistory, imageBuffer, 'Image captured for always active vision', formattedHistoryString);
        }
      } catch (error) {
        console.error(`[${this.name}] Error capturing or logging screenshot in always_active mode:`, error);
      }
    }

    if (!self_prompt && !from_other_bot) {
      const user_command_name = containsCommand(message);
      if (user_command_name) {
        if (!commandExists(user_command_name)) {
          this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
          return false;
        }

        if (settings.show_command_marker) {
          this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
        }

        if (user_command_name === '!newAction') {
          await this.history.add(source, message, null);
        }

        const execute_res = await executeCommand(this, message);
        if (settings.echo_command_result_to_chat && execute_res) {
          const response = typeof execute_res === 'string' ? execute_res : JSON.stringify(execute_res);
          this.routeResponse(source, response);
        }
        return true;
      }
    }

    if (from_other_bot) this.last_sender = source;

    message = await handleEnglishTranslation(message);
    console.log('received message from', source, ':', message);

    const checkInterrupt = () =>
      this.self_prompter.shouldInterrupt(self_prompt) ||
      this.shut_up ||
      convoManager.responseScheduledFor(source);

    let imagePathForInitialMessage = null;
    if (!self_prompt && !from_other_bot && settings.vision_mode === 'always' && this.latestScreenshotPath) {
      imagePathForInitialMessage = this.latestScreenshotPath;
    }
    await this.history.add(source, message, imagePathForInitialMessage);
    if (imagePathForInitialMessage) this.latestScreenshotPath = null;
    this.history.save();

    if (!self_prompt && this.self_prompter.isActive()) max_responses = 1;

    for (let i = 0; i < max_responses; i++) {
      if (checkInterrupt()) break;

      const history_for_prompt = this.history.getHistory().filter((t) => t.role !== 'system');
      let res = await this.prompter.promptConvo(history_for_prompt);

      this._lastModelResponseTime = Date.now();

      console.log(`${this.name} full response to ${source}: ""${res}""`);
      if (res.trim().length === 0) {
        console.warn('no response');
        break;
      }

      let command_name = containsCommand(res);

      if (command_name) {
        const canRun = this._canExecuteCommand(command_name, { self_prompt, from_other_bot });
        if (!canRun) {
          await this.history.add(
            'system',
            `Ignored ${command_name} from ${self_prompt ? 'self/system' : (from_other_bot ? 'other-bot' : 'unknown')} (${source})`,
            null,
          );
          continue;
        }

        const origRes = res;
        res = truncCommandMessage(res);
        await this.history.add(this.name, res, null);

        if (!commandExists(command_name)) {
          await this.history.add('system', `Command ${command_name} does not exist.`, null);
          console.warn('Agent hallucinated command:', command_name);
          continue;
        }

        if (checkInterrupt()) break;
        this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

        const isRobotCommand = command_name.startsWith('!robot');
        if (!isRobotCommand) {
          if (settings.verbose_commands) {
            this.routeResponse(source, origRes);
          } else if (settings.show_command_marker) {
            const cut = origRes.indexOf(command_name);
            const pre_message = cut >= 0 ? origRes.substring(0, cut).trim() : '';
            let chat_message = `*used ${command_name.substring(1)}*`;
            if (pre_message.length > 0) chat_message = `${pre_message}  ${chat_message}`;
            this.routeResponse(source, chat_message);
          } else {
            const cut = origRes.indexOf(command_name);
            const pre_message = cut >= 0 ? origRes.substring(0, cut).trim() : '';
            if (pre_message.length > 0) this.routeResponse(source, pre_message);
          }
        } else {
          const cut = origRes.indexOf(command_name);
          const pre_message = cut >= 0 ? origRes.substring(0, cut).trim() : '';
          const post_message = cut >= 0 ? origRes.substring(cut + command_name.length).trim() : '';
          const speech = pre_message.length > 0 ? pre_message : post_message;
          if (speech.length > 0) this.routeResponse(source, speech);
        }

        const execute_res = await executeCommand(this, res);
        console.log('Agent executed:', command_name, 'and got:', execute_res);
        used_command = true;

        if (execute_res) {
          let imagePathForCommandResult = null;
          const isVisionCapture =
            command_name &&
            (command_name === '!lookAtPlayer' || command_name === '!lookAtPosition' || command_name === '!captureFullView');
          if (isVisionCapture && this.latestScreenshotPath) {
            imagePathForCommandResult = this.latestScreenshotPath;
          }
          await this.history.add('system', stringifyOutcome(execute_res), imagePathForCommandResult);
          if (imagePathForCommandResult) this.latestScreenshotPath = null;
        } else {
          break;
        }
      } else {
        const cleanRes = res.trim();
        const isInternalLog = INTERNAL_LOG_MESSAGES.some((log) => cleanRes === log);

        if (isInternalLog) {
          await this.history.add('system', `Internal log/error: ${cleanRes}`, null);
          console.warn(`[${this.name}] Suppressing internal log message from output: ${cleanRes}`);
          break;
        }

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

    const self_prompt = to_player === 'system' || to_player === this.name;

    if (self_prompt) this._suppressNextOutput = true;
    if (self_prompt && this.last_sender) to_player = this.last_sender;

    if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
      convoManager.sendToBot(to_player, message);
    } else {
      this.openChat(message);
    }
  }

  async openChat(message) {
    const suppress = !!this._suppressNextOutput;
    this._suppressNextOutput = false;

    let to_translate = message;
    let remaining = '';
    const command_name = containsCommand(message);
    const translate_up_to = command_name ? message.indexOf(command_name) : -1;
    if (translate_up_to !== -1) {
      to_translate = to_translate.substring(0, translate_up_to);
      remaining = message.substring(translate_up_to);
    }

    let translated = (await handleTranslation(to_translate)).trim();
    if (remaining) {
      translated = `${translated} ${remaining}`.trim();
    }
    translated = translated.replaceAll('\\n', ' ');

    if (!suppress && serverProxy.getSocket()) {
      serverProxy.getSocket().emit('agent-response', this.name, translated);
    }

    if (!suppress && settings.speak && to_translate.trim().length > 0) {
      try {
        say(to_translate, this.prompter?.profile?.speak_model);
      } catch (err) {
        console.warn('Failed to speak:', err);
      }
    }

    this._lastChatTime = Date.now();
    this._idleTriggered = false;
  }

  formatHistoryForVisionLog(conversationHistory) {
    if (!conversationHistory || conversationHistory.length === 0) return '';
    const formattedHistory = [];
    for (const turn of conversationHistory) {
      const formattedTurn = { role: turn.role || 'user', content: [] };
      if (typeof turn.content === 'string') {
        formattedTurn.content.push({ type: 'text', text: turn.content });
      } else if (Array.isArray(turn.content)) {
        turn.content.forEach((contentItem) => {
          if (typeof contentItem === 'string') {
            formattedTurn.content.push({ type: 'text', text: contentItem });
          } else if (contentItem.type === 'text' && contentItem.text) {
            formattedTurn.content.push({ type: 'text', text: contentItem.text });
          } else if (contentItem.type === 'image_url' && contentItem.image_url?.url) {
            formattedTurn.content.push({ type: 'image', image: contentItem.image_url.url });
          } else if (contentItem.type === 'image' && contentItem.image) {
            formattedTurn.content.push({ type: 'image', image: contentItem.image });
          }
        });
      } else if (turn.content && typeof turn.content === 'object') {
        if (turn.content.text) formattedTurn.content.push({ type: 'text', text: turn.content.text });
        if (turn.content.image) formattedTurn.content.push({ type: 'image', image: turn.content.image });
        if (turn.content.image_url?.url) formattedTurn.content.push({ type: 'image', image: turn.content.image_url.url });
      }
      if (turn.content && formattedTurn.content.length === 0) {
        formattedTurn.content.push({ type: 'text', text: JSON.stringify(turn.content) });
      }
      formattedHistory.push(formattedTurn);
    }
    return JSON.stringify(formattedHistory);
  }

  async cleanKill(msg = 'Killing agent process...', code = 1) {
    if (this._updateInterval) clearInterval(this._updateInterval);
    if (this.history) {
      await this.history.add('system', msg, null);
      this.history.save();
    } else {
      console.warn('[Agent] History not initialized, cannot save cleanKill message.');
    }
    process.exit(code);
  }

  async checkTaskDone() {
    // Task system removed for robot-only mode.
  }

  killAll() {
    serverProxy.shutdown();
  }
}
