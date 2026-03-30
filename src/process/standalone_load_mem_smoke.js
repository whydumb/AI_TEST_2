import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import settings from '../../settings.js';
import { Prompter } from '../models/prompter.js';
import { SelfPrompter } from '../agent/self_prompter.js';
import { StandaloneAgent } from '../standalone/standalone_agent.js';

const TEST_NAME = 'standalone_load_mem_smoke';
const PROFILE_PATH = path.resolve(`./profiles/${TEST_NAME}.json`);
const BOT_DIR = path.resolve(`./bots/${TEST_NAME}`);

function createNoopSkillLibrary() {
    return {
        initSkillLibrary() {},
        getAllSkillDocs() { return []; },
        async getRelevantSkillDocs() { return ''; },
    };
}

function patchRuntimeForSmoke() {
    settings.speak = false;
    settings.allow_vision = false;
    settings.plugins = [];
    settings.standalone_environment = 'generic';
    settings.standalone_update_interval_ms = 1000;
    settings.standalone_status_interval_ms = 1000;

    Prompter.prototype._createModel = function _createModel() {
        return {
            async sendRequest() {
                return 'NO_COMMAND';
            },
            async embed() {
                return [];
            },
        };
    };

    Prompter.prototype.refreshSkillLibrary = async function refreshSkillLibrary() {
        this.skill_libary = createNoopSkillLibrary();
    };

    Prompter.prototype.initExamples = async function initExamples() {
        this.skill_libary = createNoopSkillLibrary();
        this.convo_examples = null;
        this.coding_examples = null;
    };

    Prompter.prototype._saveLog = async function _saveLog() {};

    SelfPrompter.prototype.startLoop = async function startLoop() {
        this.loop_active = false;
        this.interrupt = false;
    };

    StandaloneAgent.prototype.connect = function connect() {
        this.connected = false;
        this.socket = null;
    };
}

function writeTempProfile() {
    mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, JSON.stringify({
        name: TEST_NAME,
        model: 'gpt-test',
        embedding: 'none',
        speak_model: '',
    }, null, 2), 'utf8');
}

function cleanupArtifacts() {
    rmSync(BOT_DIR, { recursive: true, force: true });
    rmSync(PROFILE_PATH, { force: true });
}

async function disposeAgent(agent) {
    if (agent.statusUpdateInterval) {
        clearInterval(agent.statusUpdateInterval);
        agent.statusUpdateInterval = null;
    }
    if (agent.updateInterval) {
        clearInterval(agent.updateInterval);
        agent.updateInterval = null;
    }
    await agent.self_prompter?.stop(false).catch(() => {});
    agent.environment?.stop?.();
}

async function main() {
    patchRuntimeForSmoke();
    cleanupArtifacts();
    writeTempProfile();

    const first = new StandaloneAgent();
    await first.start(PROFILE_PATH, false, null, 0, './tasks/example_tasks.json', 'debug_goal');

    const memoryPath = path.resolve(`./bots/${TEST_NAME}/memory.json`);
    if (!existsSync(memoryPath)) {
        throw new Error(`Memory file was not created at ${memoryPath}`);
    }
    const firstPrompt = first.self_prompter?.prompt;
    const firstState = first.self_prompter?.state;
    await disposeAgent(first);

    const second = new StandaloneAgent();
    await second.start(PROFILE_PATH, true, null, 0, './tasks/example_tasks.json', 'debug_goal');
    const loaded = JSON.parse(readFileSync(memoryPath, 'utf8'));
    const secondPrompt = second.self_prompter?.prompt;
    const secondState = second.self_prompter?.state;
    await disposeAgent(second);

    const result = {
        memoryPath,
        savedTaskId: loaded.task_id,
        savedSelfPrompt: loaded.self_prompt,
        firstPrompt,
        secondPrompt,
        firstState,
        secondState,
        restored: firstPrompt === secondPrompt && loaded.self_prompt === secondPrompt,
    };

    console.log(JSON.stringify(result, null, 2));
    cleanupArtifacts();
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
