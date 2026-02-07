import type { Browser, Page } from "puppeteer-core";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

type BrowserClientOptions = {
  cdpPort?: number;
  profileDir?: string;
  chromeExecutable?: string;
};

type BrowserVersionInfo = {
  webSocketDebuggerUrl?: string;
};

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".eagle", "browser-profile");
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1";

export class BrowserClient {
  private browser: Browser | null = null;
  private readonly cdpPort: number;
  private readonly profileDir: string;
  private readonly chromeExecutable?: string;

  constructor(options: BrowserClientOptions = {}) {
    this.cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
    this.profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
    this.chromeExecutable = options.chromeExecutable;
  }

  async connect(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    const versionInfo = await this.fetchVersionInfo();
    if (!versionInfo?.webSocketDebuggerUrl) {
      await this.launchChrome();
    }

    const refreshedInfo = await this.fetchVersionInfo();
    const wsUrl = refreshedInfo?.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error(
        `Failed to discover Chrome CDP endpoint on ${DEFAULT_CDP_ENDPOINT}:${this.cdpPort}.`,
      );
    }

    this.browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    return this.browser;
  }

  async getActivePage(): Promise<Page> {
    const browser = await this.connect();
    const pages = await browser.pages();
    if (pages.length === 0) {
      throw new Error("No Chrome pages available to attach to.");
    }

    const match = pages.find((page) => this.isChatPage(page.url()));
    if (match) {
      return match;
    }

    return pages[0] ?? Promise.reject(new Error("No Chrome pages available to attach to."));
  }

  private isChatPage(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes("chatgpt.com") ||
      lower.includes("claude.ai") ||
      lower.includes("gemini.google.com")
    );
  }

  private async fetchVersionInfo(): Promise<BrowserVersionInfo | null> {
    try {
      const response = await fetch(`${DEFAULT_CDP_ENDPOINT}:${this.cdpPort}/json/version`);
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as BrowserVersionInfo;
    } catch {
      return null;
    }
  }

  private async launchChrome(): Promise<void> {
    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
    ];

    const executable = this.chromeExecutable ?? this.resolveChromeExecutable();
    if (!executable) {
      throw new Error("Unable to resolve Chrome/Chromium executable for auto-launch.");
    }

    spawn(executable, args, {
      detached: true,
      stdio: "ignore",
    }).unref();
  }

  private resolveChromeExecutable(): string | undefined {
    const candidates = [
      process.env.CHROME_PATH,
      process.env.CHROMIUM_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "google-chrome",
      "chromium",
      "chromium-browser",
    ];

    return candidates.find((candidate) => Boolean(candidate));
  }
}
