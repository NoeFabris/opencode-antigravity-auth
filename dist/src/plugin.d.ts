import type { PluginContext, PluginResult } from "./plugin/types";
/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export declare const createAntigravityPlugin: (providerId: string) => ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const AntigravityCLIOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const GoogleOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
//# sourceMappingURL=plugin.d.ts.map