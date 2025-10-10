import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../../settings.js';

import { Gemini } from './gemini.js';
import { Vertex } from './vertex.js';
import { GPT } from './gpt.js';
import { Claude } from './claude.js';
import { Mistral } from './mistral.js';
import { ReplicateAPI } from './replicate.js';
import { Local } from './local.js';
import { Novita } from './novita.js';
import { GroqCloudAPI } from './groq.js';
import { HuggingFace } from './huggingface.js';
import { Qwen } from "./qwen.js";
import { Grok } from "./grok.js";
import { DeepSeek } from './deepseek.js';
import { Hyperbolic } from './hyperbolic.js';
import { GLHF } from './glhf.js';
import { OpenRouter } from './openrouter.js';
import { Pollinations } from './pollinations.js';
import { Doubao } from './doubao.js';
import { VLLM } from './vllm.js';
import { Andy } from './andy.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, fp) {
        this.agent = agent;
        this.profile = JSON.parse(readFileSync(fp, 'utf8'));
        let default_profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        let base_fp = settings.base_profile;
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        // Initialize personality system
        this.current_personality = null;
        this.personality_set_time = null;
        this._loadPersonalities();
        this._selectNewPersonality();
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // try to get "max_tokens" parameter, else null
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = this._selectAPI(this.profile.model);
        this.chat_model = this._createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = this._selectAPI(this.profile.code_model);
            this.code_model = this._createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = this._selectAPI(this.profile.vision_model);
            this.vision_model = this._createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        let embedding = this.profile.embedding;
        if (embedding === undefined) {
            if (chat_model_profile.api !== 'ollama')
                embedding = {api: chat_model_profile.api};
            else
                embedding = {api: 'none'};
        }
        else if (typeof embedding === 'string' || embedding instanceof String)
            embedding = {api: embedding};

        console.log('Using embedding settings:', embedding);

        try {
            if (embedding.api === 'google')
                this.embedding_model = new Gemini(embedding.model, embedding.url);
            else if (embedding.api === 'vertex')
                this.embedding_model = new Vertex(embedding.model, embedding.url);
            else if (embedding.api === 'openai')
                this.embedding_model = new GPT(embedding.model, embedding.url);
            else if (embedding.api === 'replicate')
                this.embedding_model = new ReplicateAPI(embedding.model, embedding.url);
            else if (embedding.api === 'ollama')
                this.embedding_model = new Local(embedding.model, embedding.url);
            else if (embedding.api === 'qwen')
                this.embedding_model = new Qwen(embedding.model, embedding.url);
            else if (embedding.api === 'mistral')
                this.embedding_model = new Mistral(embedding.model, embedding.url);
            else if (embedding.api === 'huggingface')
                this.embedding_model = new HuggingFace(embedding.model, embedding.url);
            else if (embedding.api === 'novita')
                this.embedding_model = new Novita(embedding.model, embedding.url);
            else {
                this.embedding_model = null;
                let embedding_name = embedding ? embedding.api : '[NOT SPECIFIED]'
                console.warn('Unsupported embedding: ' + embedding_name + '. Using word-overlap instead, expect reduced performance. Recommend using a supported embedding model. See Readme.');
            }
        }
        catch (err) {
            console.warn('Warning: Failed to initialize embedding model:', err.message);
            console.log('Continuing anyway, using word-overlap instead.');
            this.embedding_model = null;
        }
        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    _selectAPI(profile) {
        if (typeof profile === 'string' || profile instanceof String) {
            profile = {model: profile};
        }
        if (!profile.api) {
            if (profile.model.includes('openrouter/'))
                profile.api = 'openrouter'; // must do first because shares names with other models
            else if (profile.model.includes('andy/'))
                profile.api = 'andy'; // add andy api right after openrouter since it may share model names
            else if (profile.model.includes('ollama/'))
                profile.api = 'ollama'; // also must do early because shares names with other models
            else if (profile.model.includes('pollinations/'))
                profile.api = 'pollinations'; // also shares some model names like llama
            else if (profile.model.includes('vertex/') || profile.model.includes('vertex-'))
                profile.api = 'vertex';
            else if (profile.model.includes('gemini'))
                profile.api = 'google';
            else if (profile.model.includes('vllm/'))
                profile.api = 'vllm';
            else if (profile.model.includes('gpt') || profile.model.includes('o1') || profile.model.includes('o3') || profile.model.includes('o4')) 
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('huggingface/'))
                profile.api = "huggingface";
            else if (profile.model.includes('replicate/'))
                profile.api = 'replicate';
            else if (profile.model.includes('mistralai/') || profile.model.includes("mistral/"))
                model_profile.api = 'mistral';
            else if (profile.model.includes("groq/") || profile.model.includes("groqcloud/"))
                profile.api = 'groq';
            else if (profile.model.includes("glhf/"))
                profile.api = 'glhf';
            else if (profile.model.includes("hyperbolic/"))
                profile.api = 'hyperbolic';
            else if (profile.model.includes('novita/'))
                profile.api = 'novita';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
            else if (profile.model.includes('doubao'))
                profile.api = 'doubao';
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
	        else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else 
                throw new Error('Unknown model:', profile.model);
        }
        return profile;
    }
    _createModel(profile) {
        let model = null;
        if (profile.api === 'google')
            model = new Gemini(profile.model, profile.url, profile.params);
        else if (profile.api === 'vertex')
            model = new Vertex(profile.model.replace('vertex/', '').replace('vertex-', ''), profile.url, profile.params);
        else if (profile.api === 'openai')
            model = new GPT(profile.model, profile.url, profile.params);
        else if (profile.api === 'anthropic')
            model = new Claude(profile.model, profile.url, profile.params);
        else if (profile.api === 'replicate')
            model = new ReplicateAPI(profile.model.replace('replicate/', ''), profile.url, profile.params);
        else if (profile.api === 'ollama')
            model = new Local(profile.model.replace('ollama/', ''), profile.url, profile.params);
        else if (profile.api === 'mistral')
            model = new Mistral(profile.model, profile.url, profile.params);
        else if (profile.api === 'groq')
            model = new GroqCloudAPI(profile.model.replace('groq/', '').replace('groqcloud/', ''), profile.url, profile.params);
        else if (profile.api === 'huggingface')
            model = new HuggingFace(profile.model, profile.url, profile.params);
        else if (profile.api === 'glhf')
            model = new GLHF(profile.model.replace('glhf/', ''), profile.url, profile.params);
        else if (profile.api === 'hyperbolic')
            model = new Hyperbolic(profile.model.replace('hyperbolic/', ''), profile.url, profile.params);
        else if (profile.api === 'novita')
            model = new Novita(profile.model.replace('novita/', ''), profile.url, profile.params);
        else if (profile.api === 'qwen')
            model = new Qwen(profile.model, profile.url, profile.params);
        else if (profile.api === 'doubao')
            model = new Doubao(profile.model, profile.url, profile.params);
        else if (profile.api === 'xai')
            model = new Grok(profile.model, profile.url, profile.params);
        else if (profile.api === 'deepseek')
            model = new DeepSeek(profile.model, profile.url, profile.params);
        else if (profile.api === 'openrouter')
            model = new OpenRouter(profile.model.replace('openrouter/', ''), profile.url, profile.params);
        else if (profile.api === 'pollinations')
            model = new Pollinations(profile.model.replace('pollinations/', ''), profile.url, profile.params);
        else if (profile.api === 'vllm')
            model = new VLLM(profile.model.replace('vllm/', ''), profile.url, profile.params);
        else if (profile.api === 'andy')
            model = new Andy(profile.model.replace('andy/', ''), profile.url, profile.params);
        else
            throw new Error('Unknown API:', profile.api);
        return model;
    }
    
    _loadPersonalities() {
        try {
            const personalitiesPath = './profiles/defaults/personalities.json';
            const personalitiesData = JSON.parse(readFileSync(personalitiesPath, 'utf8'));
            this.personalities = personalitiesData.personalities;
            console.log(`Loaded ${this.personalities.length} personalities.`);
        } catch (error) {
            console.warn('Failed to load personalities file, using default personality:', error.message);
            this.personalities = ["Friendly and helpful, always eager to assist with various tasks."];
        }
    }
    
    _selectNewPersonality() {
        if (this.personalities && this.personalities.length > 0) {
            const randomIndex = Math.floor(Math.random() * this.personalities.length);
            this.current_personality = this.personalities[randomIndex];
            this.personality_set_time = Date.now();
            console.log(`Selected new personality: ${this.current_personality.substring(0, 50)}...`);
        } else {
            this.current_personality = "Friendly and helpful, always eager to assist with various tasks.";
            this.personality_set_time = Date.now();
        }
    }
    
    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {

        // Personality has to go first since some of the personalities contain $NAME
        if (prompt.includes('$PERSONALITY')) {
            prompt = prompt.replaceAll('$PERSONALITY', this.current_personality || "Friendly and helpful, always eager to assist with various tasks.");
        }

        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }
        if (prompt.includes('$PERSONALITY')) {
            prompt = prompt.replaceAll('$PERSONALITY', this.current_personality || "Friendly and helpful, always eager to assist with various tasks.");
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = ( process.env.CONVERSING_PROMPT || this.profile.conversing) + this.profile.conversing_end;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;
            let imageData = null;

            if (settings.vision_mode === 'always' && messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                // Check if the last message has an imagePath and if the model supports raw image input
                if (lastMessage.imagePath && this.chat_model.supportsRawImageInput) {
                    try {
                        // Construct the full path to the image file
                        const agentScreenshotDir = path.join('bots', this.agent.name, 'screenshots');
                        const imageFullPath = path.join(agentScreenshotDir, lastMessage.imagePath);

                        console.log(`[Prompter] Attempting to read image for always_active mode: ${imageFullPath}`);
                        imageData = await fs.readFile(imageFullPath); // Read as buffer
                        console.log('[Prompter] Image data prepared for chat model.');
                    } catch (err) {
                        console.error(`[Prompter] Error reading image file ${lastMessage.imagePath}:`, err);
                        imageData = null; // Proceed without image data if reading fails
                    }
                }
            }

            try {
                generation = await this.chat_model.sendRequest(messages, prompt, imageData);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation); 
                await this._saveLog(prompt, messages, generation, 'conversation');

                // Remove the incorrect logVision call here since sendRequest should handle it
                // The model's sendRequest method will call logVision if imageData was provided

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            } 

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        
        // Select new personality after memory summarization
        this._selectNewPersonality();
        console.log('Memory summarized - selecting new personality for next conversation cycle.');
        
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        switch (tag) {
            case 'conversation':
            case 'coding': // Assuming coding logs fall under normal data
            case 'memSaving':
                if (!settings.log_normal_data) return;
                break;
            default:
                return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
