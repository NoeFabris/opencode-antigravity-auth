/**
 * Constants for session recovery storage paths.
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/constants.ts
 */
/**
 * Get the XDG config directory for Antigravity config.
 * Falls back to ~/.config on Linux/Mac, or APPDATA on Windows.
 */
export declare function getXdgConfig(): string;
/**
 * Get the Antigravity config directory.
 * Default: ~/.config/opencode/antigravity.json
 */
export declare function getAntigravityConfigDir(): string;
export declare const OPENCODE_STORAGE: string;
export declare const MESSAGE_STORAGE: string;
export declare const PART_STORAGE: string;
export declare const THINKING_TYPES: Set<string>;
export declare const META_TYPES: Set<string>;
export declare const CONTENT_TYPES: Set<string>;
//# sourceMappingURL=constants.d.ts.map