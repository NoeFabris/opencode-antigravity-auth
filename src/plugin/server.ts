import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

import { ANTIGRAVITY_REDIRECT_URI } from "../constants";

interface OAuthListenerOptions {
  /**
   * How long to wait for the OAuth redirect before timing out (in milliseconds).
   */
  timeoutMs?: number;
}

export interface OAuthListener {
  /**
   * Resolves with the callback URL once Google redirects back to the local server.
   */
  waitForCallback(): Promise<URL>;
  /**
   * Cleanly stop listening for callbacks.
   */
  close(): Promise<void>;
}

const redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI);
const callbackPath = redirectUri.pathname || "/";

/**
 * Detect if running in OrbStack Docker with --network host mode.
 * OrbStack's host networking only forwards ports bound to 127.0.0.1 to macOS.
 */
function isOrbStackDockerHost(): boolean {
  // Check if we're in Docker
  if (!existsSync("/.dockerenv")) {
    return false;
  }
  
  // Check for OrbStack-specific indicators
  // OrbStack sets specific environment variables or has identifiable characteristics
  try {
    // OrbStack containers often have /run/.containerenv or specific mount patterns
    // Also check if /proc/version contains orbstack
    if (existsSync("/proc/version")) {
      const version = readFileSync("/proc/version", "utf8").toLowerCase();
      if (version.includes("orbstack")) {
        return true;
      }
    }
    
    // Check hostname pattern (OrbStack uses specific patterns)
    const hostname = process.env.HOSTNAME || "";
    if (hostname.includes("orbstack") || hostname.includes("orb")) {
      return true;
    }
    
    // Check for OrbStack's network host mode by looking at resolv.conf
    // OrbStack with --network host has specific DNS configuration
    if (existsSync("/etc/resolv.conf")) {
      const resolv = readFileSync("/etc/resolv.conf", "utf8");
      if (resolv.includes("orb.local") || resolv.includes("orbstack")) {
        return true;
      }
    }
    
    // Fallback: Check if running on macOS/Darwin host via Docker
    // This is a heuristic - if in Docker on Linux but /proc/version shows darwin-like patterns
    if (process.platform === "linux" && existsSync("/.dockerenv")) {
      // Most OrbStack containers will have been caught above
      // For safety, also check common OrbStack mount patterns
      if (existsSync("/run/host-services")) {
        return true;
      }
    }
  } catch {
    // Ignore errors, fall through to default
  }
  
  return false;
}

/**
 * Detect WSL (Windows Subsystem for Linux) environment.
 */
function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Detect remote/SSH environment where localhost may not be accessible from browser.
 */
function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  return false;
}

/**
 * Determine the best bind address for the OAuth callback server.
 * 
 * Priority:
 * 1. OPENCODE_ANTIGRAVITY_OAUTH_BIND environment variable (user override)
 * 2. OrbStack Docker with --network host: 127.0.0.1 (required for port forwarding)
 * 3. WSL/SSH/Remote: 0.0.0.0 (needed for cross-network access)
 * 4. Default: 127.0.0.1 (most secure for local development)
 */
function getBindAddress(): string {
  // Allow user override via environment variable
  const envBind = process.env.OPENCODE_ANTIGRAVITY_OAUTH_BIND;
  if (envBind) {
    return envBind;
  }
  
  // OrbStack Docker needs 127.0.0.1 for --network host port forwarding
  if (isOrbStackDockerHost()) {
    return "127.0.0.1";
  }
  
  // WSL and remote environments need 0.0.0.0 to be reachable
  if (isWSL() || isRemoteEnvironment()) {
    return "0.0.0.0";
  }
  
  // Default to 127.0.0.1 for security (local-only access)
  return "127.0.0.1";
}

/**
 * Starts a lightweight HTTP server that listens for the Antigravity OAuth redirect
 * and resolves with the captured callback URL.
 */
export async function startOAuthListener(
  { timeoutMs = 5 * 60 * 1000 }: OAuthListenerOptions = {},
): Promise<OAuthListener> {
  const port = redirectUri.port
    ? Number.parseInt(redirectUri.port, 10)
    : redirectUri.protocol === "https:"
    ? 443
    : 80;
  const origin = `${redirectUri.protocol}//${redirectUri.host}`;

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (error: Error) => void;
  let timeoutHandle: NodeJS.Timeout;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url: URL) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(url);
    };
    rejectCallback = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    };
  });

const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authentication Successful</title>
    <style>
      :root {
        --bg: #FAFAFA;
        --card-bg: #FFFFFF;
        --text-primary: #1F2937;
        --text-secondary: #6B7280;
        --accent: #2563EB;
        --success: #10B981;
        --border: #E5E7EB;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111827;
          --card-bg: #1F2937;
          --text-primary: #F9FAFB;
          --text-secondary: #9CA3AF;
          --accent: #3B82F6;
          --success: #34D399;
          --border: #374151;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text-primary);
        padding: 1rem;
      }
      .card {
        background: var(--card-bg);
        border-radius: 16px;
        padding: 3rem 2rem;
        width: 100%;
        max-width: 400px;
        text-align: center;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        border: 1px solid var(--border);
      }
      .icon-wrapper {
        width: 64px;
        height: 64px;
        background: rgba(16, 185, 129, 0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 1.5rem;
      }
      .icon {
        width: 32px;
        height: 32px;
        color: var(--success);
      }
      h1 {
        font-size: 1.5rem;
        font-weight: 600;
        margin: 0 0 0.5rem;
        letter-spacing: -0.025em;
      }
      p {
        color: var(--text-secondary);
        font-size: 0.95rem;
        line-height: 1.5;
        margin: 0 0 2rem;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--text-primary);
        color: var(--card-bg);
        font-weight: 500;
        padding: 0.75rem 1.5rem;
        border-radius: 8px;
        text-decoration: none;
        transition: opacity 0.2s;
        font-size: 0.95rem;
        border: none;
        cursor: pointer;
        width: 100%;
        box-sizing: border-box;
      }
      .btn:hover {
        opacity: 0.9;
      }
      .sub-text {
        margin-top: 1rem;
        font-size: 0.8rem;
        color: var(--text-secondary);
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon-wrapper">
        <svg class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h1>All set!</h1>
      <p>You've successfully authenticated with Antigravity. You can now return to Opencode.</p>
      <button class="btn" onclick="closeWindow()">Close this tab</button>
      <div class="sub-text">Usage Tip: Most browsers block auto-closing. If the button doesn't work, please close the tab manually.</div>
    </div>
    <script>
      function closeWindow() {
        window.close();
        // Fallback if window.close() is blocked
        document.querySelector('.btn').textContent = "Tab cannot be closed automatically";
        document.querySelector('.btn').style.opacity = "0.5";
        document.querySelector('.btn').style.cursor = "default";
      }
    </script>
  </body>
</html>`;

  timeoutHandle = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request");
      return;
    }

    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(successResponse);

    resolveCallback(url);

    setImmediate(() => {
      server.close();
    });
  });

  const bindAddress = getBindAddress();
  
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: NodeJS.ErrnoException) => {
      server.off("error", handleError);
      if (error.code === "EADDRINUSE") {
        reject(new Error(
          `Port ${port} is already in use. ` +
          `Another process is occupying this port. ` +
          `Please terminate the process or try again later.`
        ));
        return;
      }
      reject(error);
    };
    server.once("error", handleError);
    server.listen(port, bindAddress, () => {
      server.off("error", handleError);
      resolve();
    });
  });

  server.on("error", (error) => {
    rejectCallback(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          if (!settled) {
            rejectCallback(new Error("OAuth listener closed before callback"));
          }
          resolve();
        });
      }),
  };
}
