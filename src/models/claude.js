import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { log, logVision } from '../../logger.js';

export class Claude {
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        let config = {};
        if (url)
            config.baseURL = url;
        config.apiKey = getKey('ANTHROPIC_API_KEY');
        this.anthropic = new Anthropic(config);
        this.supportsRawImageInput = true;
    }

    async sendRequest(turns, systemMessage, imageData = null) {
        const messages = strictFormat(turns); // Ensure messages are in role/content format
        let res = null;

        if (imageData) {
            const visionModels = ["claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307", "claude-3-5-sonnet", "claude-3-5-haiku"];
            if (!visionModels.some(vm => this.model_name.includes(vm))) {
                console.warn(`[Claude] Warning: imageData provided for model ${this.model_name}, which is not explicitly a Claude 3 vision model. The image may be ignored or cause an error.`);
            }

            let lastUserMessageIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                    lastUserMessageIndex = i;
                    break;
                }
            }

            if (lastUserMessageIndex !== -1) {
                const userMessage = messages[lastUserMessageIndex];
                
                // ✅ Sharp를 사용해서 항상 JPEG로 변환
                const sharp = (await import('sharp')).default;
                const jpegBuffer = await sharp(imageData)
                    .jpeg({ quality: 90 })
                    .toBuffer();
                
                const imagePart = {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: jpegBuffer.toString('base64')
                    }
                };

                if (typeof userMessage.content === 'string') {
                    userMessage.content = [{ type: "text", text: userMessage.content }, imagePart];
                } else if (Array.isArray(userMessage.content)) {
                    // If content is already an array, add the image part.
                    userMessage.content.push(imagePart);
                } else {
                    // Fallback or error if content is an unexpected type
                    console.warn('[Claude] Last user message content is not a string or array. Cannot attach image.');
                    userMessage.content = [{ type: "text", text: "Image attached" }, imagePart];
                }
            } else {
                console.warn('[Claude] imageData provided, but no user message found to attach it to. Image not sent.');
            }
        }

        try {
            console.log('Awaiting anthropic api response...');
            console.log('Formatted Messages for API:', JSON.stringify(messages, null, 2));

            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000; // max_tokens must be greater
                } else {
                    this.params.max_tokens = 4096;
                }
            }

            // Remove any extra fields that Anthropic API doesn't accept
            const cleanMessages = messages.map(msg => {
                const { imagePath, ...cleanMsg } = msg;
                return cleanMsg;
            });

            const resp = await this.anthropic.messages.create({
                model: this.model_name || "claude-3-sonnet-20240229", // Default to a vision-capable model if none specified
                system: systemMessage,
                messages: cleanMessages, // Use cleaned messages without imagePath
                ...(this.params || {})
            });
            
            console.log('Received.')
            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Claude.';
            }
        } catch (err) {
            if (err.message.includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        
        const logMessagesForClaude = [{ role: "system", content: systemMessage }].concat(turns);
        if (typeof res === 'string') {
            res = res.replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>');
        }

        if (imageData) { // If imageData was part of this sendRequest call
            let visionPromptText = ""; // Attempt to find the text prompt associated with the image
            if (turns.length > 0) {
                const lastTurn = messages[messages.length - 1]; // `messages` is strictFormat(turns)
                if (lastTurn.role === 'user' && Array.isArray(lastTurn.content)) {
                    const textPart = lastTurn.content.find(part => part.type === 'text');
                    if (textPart) visionPromptText = textPart.text;
                } else if (lastTurn.role === 'user' && typeof lastTurn.content === 'string') {
                    visionPromptText = lastTurn.content;
                }
            }
            logVision(logMessagesForClaude, imageData, res, visionPromptText);
        } else {
            log(JSON.stringify(logMessagesForClaude), res);
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const sharp = (await import('sharp')).default;
        const jpegBuffer = await sharp(imageBuffer)
            .jpeg({ quality: 90 })
            .toBuffer();
        
        const visionUserMessageContent = [
            { type: "text", text: systemMessage },
            {
                type: "image",
                source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: jpegBuffer.toString('base64')
                }
            }
        ];

        const turnsForAPIRequest = [...turns, { role: "user", content: visionUserMessageContent }];

        const res = await this.sendRequest(turnsForAPIRequest, systemMessage);

        if (imageBuffer && res) {
            logVision([{ role: "system", content: systemMessage }].concat(turns), imageBuffer, res, systemMessage);
        }
        return res;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude.');
    }
}
