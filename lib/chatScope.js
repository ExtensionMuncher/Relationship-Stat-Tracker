import { chat_metadata } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";

import { getChatData } from "../data/storage.js";

let revision = 0;
export function invalidateChatScopes() { revision++; }
export function captureChatScope() {
    getChatData();
    const origin = chat_metadata;
    const namespace = origin?.rst;
    const version = revision;
    const key = () => {
        const ctx = getContext();
        return JSON.stringify([ctx?.chatId, ctx?.characterId, ctx?.groupId]);
    };
    const originKey = key();
    const isCurrent = () => revision === version && chat_metadata === origin
        && chat_metadata?.rst === namespace && key() === originKey;
    const assertCurrent = () => {
        if (!isCurrent()) {
            const error = new Error("RST operation cancelled because the active chat changed. Reopen it in the intended chat.");
            error.code = "RST_STALE_CHAT";
            throw error;
        }
    };
    return { isCurrent, assertCurrent, async wait(operation) {
        assertCurrent();
        try {
            const value = await operation();
            assertCurrent();
            return value;
        } catch (error) {
            assertCurrent();
            throw error;
        }
    } };
}
