/**
 * Simple string hash for thinking deduplication.
 * Uses DJB2-like algorithm.
 */
function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); /* hash * 33 + c */
    }
    return (hash >>> 0).toString(16);
}
export function createThoughtBuffer() {
    const buffer = new Map();
    return {
        get: (index) => buffer.get(index),
        set: (index, text) => buffer.set(index, text),
        clear: () => buffer.clear(),
    };
}
export function transformStreamingPayload(payload, transformThinkingParts) {
    return payload
        .split('\n')
        .map((line) => {
        if (!line.startsWith('data:')) {
            return line;
        }
        const json = line.slice(5).trim();
        if (!json) {
            return line;
        }
        try {
            const parsed = JSON.parse(json);
            if (parsed.response !== undefined) {
                const transformed = transformThinkingParts
                    ? transformThinkingParts(parsed.response)
                    : parsed.response;
                return `data: ${JSON.stringify(transformed)}`;
            }
        }
        catch (_) { }
        return line;
    })
        .join('\n');
}
export function deduplicateThinkingText(response, sentBuffer, displayedThinkingHashes) {
    if (!response || typeof response !== 'object')
        return response;
    const resp = response;
    if (Array.isArray(resp.candidates)) {
        const newCandidates = resp.candidates.map((candidate, index) => {
            const cand = candidate;
            if (!cand?.content)
                return candidate;
            const content = cand.content;
            if (!Array.isArray(content.parts))
                return candidate;
            const newParts = content.parts.map((part) => {
                const p = part;
                if (p.thought === true || p.type === 'thinking') {
                    const fullText = (p.text || p.thinking || '');
                    if (displayedThinkingHashes) {
                        const hash = hashString(fullText);
                        if (displayedThinkingHashes.has(hash)) {
                            sentBuffer.set(index, fullText);
                            return null;
                        }
                        displayedThinkingHashes.add(hash);
                    }
                    const sentText = sentBuffer.get(index) ?? '';
                    if (fullText.startsWith(sentText)) {
                        const delta = fullText.slice(sentText.length);
                        sentBuffer.set(index, fullText);
                        if (delta) {
                            return { ...p, text: delta, thinking: delta };
                        }
                        return null;
                    }
                    sentBuffer.set(index, fullText);
                    return part;
                }
                return part;
            });
            const filteredParts = newParts.filter((p) => p !== null);
            return {
                ...cand,
                content: { ...content, parts: filteredParts },
            };
        });
        return { ...resp, candidates: newCandidates };
    }
    if (Array.isArray(resp.content)) {
        let thinkingIndex = 0;
        const newContent = resp.content.map((block) => {
            const b = block;
            if (b?.type === 'thinking') {
                const fullText = (b.thinking || b.text || '');
                if (displayedThinkingHashes) {
                    const hash = hashString(fullText);
                    if (displayedThinkingHashes.has(hash)) {
                        sentBuffer.set(thinkingIndex, fullText);
                        thinkingIndex++;
                        return null;
                    }
                    displayedThinkingHashes.add(hash);
                }
                const sentText = sentBuffer.get(thinkingIndex) ?? '';
                if (fullText.startsWith(sentText)) {
                    const delta = fullText.slice(sentText.length);
                    sentBuffer.set(thinkingIndex, fullText);
                    thinkingIndex++;
                    if (delta) {
                        return { ...b, thinking: delta, text: delta };
                    }
                    return null;
                }
                sentBuffer.set(thinkingIndex, fullText);
                thinkingIndex++;
                return block;
            }
            return block;
        });
        const filteredContent = newContent.filter((b) => b !== null);
        return { ...resp, content: filteredContent };
    }
    return response;
}
export function transformSseLine(line, signatureStore, thoughtBuffer, sentThinkingBuffer, callbacks, options, debugState) {
    if (!line.startsWith('data:')) {
        return line;
    }
    const json = line.slice(5).trim();
    if (!json) {
        return line;
    }
    try {
        const parsed = JSON.parse(json);
        if (parsed.response !== undefined) {
            if (options.cacheSignatures && options.signatureSessionKey) {
                cacheThinkingSignaturesFromResponse(parsed.response, options.signatureSessionKey, signatureStore, thoughtBuffer, callbacks.onCacheSignature);
            }
            let response = deduplicateThinkingText(parsed.response, sentThinkingBuffer, options.displayedThinkingHashes);
            if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
                response = callbacks.onInjectDebug(response, options.debugText);
                debugState.injected = true;
            }
            const transformed = callbacks.transformThinkingParts
                ? callbacks.transformThinkingParts(response)
                : response;
            return `data: ${JSON.stringify(transformed)}`;
        }
    }
    catch (_) { }
    return line;
}
export function cacheThinkingSignaturesFromResponse(response, signatureSessionKey, signatureStore, thoughtBuffer, onCacheSignature) {
    if (!response || typeof response !== 'object')
        return;
    const resp = response;
    if (Array.isArray(resp.candidates)) {
        resp.candidates.forEach((candidate, index) => {
            const cand = candidate;
            if (!cand?.content)
                return;
            const content = cand.content;
            if (!Array.isArray(content.parts))
                return;
            content.parts.forEach((part) => {
                const p = part;
                if (p.thought === true || p.type === 'thinking') {
                    const text = (p.text || p.thinking || '');
                    if (text) {
                        const current = thoughtBuffer.get(index) ?? '';
                        thoughtBuffer.set(index, current + text);
                    }
                }
                if (p.thoughtSignature) {
                    const fullText = thoughtBuffer.get(index) ?? '';
                    if (fullText) {
                        const signature = p.thoughtSignature;
                        onCacheSignature?.(signatureSessionKey, fullText, signature);
                        signatureStore.set(signatureSessionKey, { text: fullText, signature });
                    }
                }
            });
        });
    }
    if (Array.isArray(resp.content)) {
        let thinkingText = '';
        resp.content.forEach((block) => {
            const b = block;
            if (b?.type === 'thinking') {
                thinkingText += (b.thinking || b.text || '');
            }
            if (b?.signature && thinkingText) {
                const signature = b.signature;
                onCacheSignature?.(signatureSessionKey, thinkingText, signature);
                signatureStore.set(signatureSessionKey, { text: thinkingText, signature });
            }
        });
    }
}
export function createStreamingTransformer(signatureStore, callbacks, options = {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const thoughtBuffer = createThoughtBuffer();
    const sentThinkingBuffer = createThoughtBuffer();
    const debugState = { injected: false };
    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const transformedLine = transformSseLine(line, signatureStore, thoughtBuffer, sentThinkingBuffer, callbacks, options, debugState);
                controller.enqueue(encoder.encode(transformedLine + '\n'));
            }
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer) {
                const transformedLine = transformSseLine(buffer, signatureStore, thoughtBuffer, sentThinkingBuffer, callbacks, options, debugState);
                controller.enqueue(encoder.encode(transformedLine));
            }
        },
    });
}
//# sourceMappingURL=transformer.js.map