import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import settings from '../../settings.js';

export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];
        this.memory = '';
        this.max_messages = settings.max_messages;
        this.summary_chunk_size = 5;
    }

    getHistory() {
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories() {
        return;
    }

    async appendFullHistory() {
        return;
    }

    async add(name, content, imagePath = null) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        } else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }

        this.turns.push({ role, content, imagePath });

        const maxTurns = 50;
        if (this.turns.length > maxTurns) {
            this.turns = this.turns.slice(-maxTurns);
        }
    }

    async save() {
        try {
            const selfPrompter = this.agent.self_prompter;
            const task = this.agent.task;
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: selfPrompter?.state,
                self_prompt: selfPrompter && !selfPrompter.isStopped() ? selfPrompter.prompt : null,
                taskStart: task?.taskStartTime ?? null,
                task_id: task?.task_id ?? null,
                last_sender: this.agent.last_sender ?? null,
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2), 'utf8');
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }

            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = Array.isArray(data.turns) ? data.turns.slice(-50) : [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}
