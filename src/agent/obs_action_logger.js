import { appendFileSync, mkdirSync } from 'fs';

export class ObsActionLogger {
    constructor(agentName) {
        this.agentName = agentName;
        this.dirPath = `./bots/${agentName}`;
        this.filePath = `${this.dirPath}/obs_action_pairs.jsonl`;
        mkdirSync(this.dirPath, { recursive: true });
    }

    append(pair) {
        if (!pair || typeof pair !== 'object') return;
        appendFileSync(this.filePath, `${JSON.stringify(pair)}\n`, 'utf8');
    }
}
