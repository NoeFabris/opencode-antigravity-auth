export function createSignatureStore() {
    const store = new Map();
    return {
        get: (key) => store.get(key),
        set: (key, value) => {
            store.set(key, value);
        },
        has: (key) => store.has(key),
        delete: (key) => {
            store.delete(key);
        },
    };
}
export function createThoughtBuffer() {
    const buffer = new Map();
    return {
        get: (index) => buffer.get(index),
        set: (index, text) => {
            buffer.set(index, text);
        },
        clear: () => buffer.clear(),
    };
}
export const defaultSignatureStore = createSignatureStore();
//# sourceMappingURL=signature-store.js.map