
import { readdirSync, readFileSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import settings from '../../settings.js';
import { addPluginActions } from './commands/index.js';

export class PluginManager {
    constructor(agent) {
        this.agent = agent;
        this.plugins = {};
        this.pluginActions = {};
        this.initPromise = null;
    }

    init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.importPlugins()
            .then((plugins) => {
                this.plugins = plugins;
                for (let plugin in this.plugins) {
                    if (this.plugins[plugin]) {
                        if (typeof this.plugins[plugin].getPluginActions === 'function') {
                            const actions = this.plugins[plugin].getPluginActions();
                            this.pluginActions[plugin] = actions;
                            addPluginActions(plugin, actions);
                        }
                    }
                }
                console.log("Loaded plugins:", Object.keys(this.plugins).filter(key => this.plugins[key] !== null));
                return this.plugins;
            })
            .catch((error) => {
                console.error("Error importing plugins:", error);
                throw error;
            });

        return this.initPromise;
    }

    async importPlugin(dir, name) {
        let path = join(dir, name, "main.js");
        let instance = null;
        try {
            const plugin = await import(pathToFileURL(path).href);
            if (plugin.PluginInstance) {
                instance = new plugin.PluginInstance(this.agent);
                if (typeof instance.init === 'function') {
                    await instance.init();
                }
            } else {
                console.error(`Can't find PluginInstance in ${path}.`);
            }
        } catch (error) {
            console.error(`Error import plugin ${path}:`, error);
        }
        return instance;
    }

    async importPlugins(dir = "src/plugins") {
        let plugins = {};
        try {
            for (let file of readdirSync(dir, { withFileTypes: true })) {
                if (settings.plugins && settings.plugins.includes(file.name) && file.isDirectory() && !file.name.startsWith('.')) {
                    let instance = await this.importPlugin(dir, file.name);
                    plugins[file.name] = instance;
                }
            }
        } catch (error) {
            console.error(`Error importing plugins in ${dir}:`, error);
        }
        return plugins;
    }
}
