import {
  createAssistantMessageEventStream,
  registerApiProvider,
  type ApiProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@mariozechner/pi-ai";
import { chromium, type Page } from "playwright-core";

type BrowserUniversalOptions = {
  cdpUrl?: string;
  urlRegex?: RegExp;
  timeoutMs?: number;
};

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_URL_REGEX = /chatgpt\.com/i;
const DEFAULT_TIMEOUT_MS = 120_000;

const INPUT_SELECTORS = [
  "#prompt-textarea",
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="Send"]',
  "textarea",
  'div[contenteditable="true"][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
];

const STOP_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[title*="Stop"]',
  'button:has(svg[aria-label*="Stop"])',
  'button:has(svg[data-icon*="stop"])',
];

const SEND_SELECTORS = [
  'button[aria-label*="Send"]',
  'button[title*="Send"]',
  'button[data-testid*="send"]',
  'button:has(svg[aria-label*="Send"])',
  'button:has(svg[data-icon*="send"])',
];

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  ".markdown",
  ".prose",
  "article",
];

let browserUniversalRegistered = false;

function resolveEnvRegex(): RegExp | null {
  const raw = process.env.OPENCLAW_BROWSER_UNIVERSAL_URL_REGEX?.trim();
  if (!raw) {
    return null;
  }
  try {
    return new RegExp(raw);
  } catch {
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Browser universal run aborted");
  }
}

function buildAssistantMessage(
  text: string,
  model: Model<string>,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function extractLatestUserPrompt(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i];
    if (message?.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content.trim();
    }
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

async function resolveFocusedPage(pages: Page[]): Promise<Page | null> {
  for (const page of pages) {
    if (page.isClosed()) {
      continue;
    }
    try {
      const focused = await page.evaluate(() => document.hasFocus());
      if (focused) {
        return page;
      }
    } catch {
      // Ignore pages we can't evaluate (e.g., closed during check).
    }
  }
  return null;
}

async function resolvePageByRegex(pages: Page[], regex: RegExp): Promise<Page | null> {
  for (const page of pages) {
    if (page.isClosed()) {
      continue;
    }
    const url = page.url();
    if (regex.test(url)) {
      return page;
    }
  }
  return null;
}

async function resolveInputLocator(page: Page): Promise<ReturnType<Page["locator"]>> {
  for (const selector of INPUT_SELECTORS) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible()) {
        return locator;
      }
    } catch {
      // Ignore selector failures and try the next strategy.
    }
  }
  throw new Error("Browser universal input not found. Update selectors or focus the input.");
}

async function countAssistantBlocks(page: Page): Promise<number> {
  return await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      if (matches.length > 0) {
        return matches.length;
      }
    }
    return 0;
  }, ASSISTANT_SELECTORS);
}

async function waitForCompletion(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (stopSelectors, sendSelectors) => {
      const isVisible = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (!style || style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        return Boolean((el as HTMLElement).offsetParent);
      };
      const stopVisible = stopSelectors.some(isVisible);
      const sendVisible = sendSelectors.some(isVisible);
      const sendKnown = sendSelectors.some((selector) => document.querySelector(selector));
      return !stopVisible && (sendVisible || !sendKnown);
    },
    STOP_SELECTORS,
    SEND_SELECTORS,
    { timeout: timeoutMs },
  );
}

async function extractLatestAssistantText(page: Page): Promise<string> {
  return await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        const text = matches[i]?.textContent?.trim();
        if (text) {
          return text;
        }
      }
    }
    return "";
  }, ASSISTANT_SELECTORS);
}

export class BrowserUniversalProvider implements ApiProvider<"browser-universal", StreamOptions> {
  api: "browser-universal" = "browser-universal";
  private cdpUrl: string;
  private urlRegex: RegExp;
  private timeoutMs: number;

  constructor(options: BrowserUniversalOptions = {}) {
    this.cdpUrl =
      options.cdpUrl ?? process.env.OPENCLAW_BROWSER_UNIVERSAL_CDP_URL ?? DEFAULT_CDP_URL;
    this.urlRegex = options.urlRegex ?? resolveEnvRegex() ?? DEFAULT_URL_REGEX;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  stream(model: Model<"browser-universal">, context: Context, options?: StreamOptions) {
    return this.runStream(model, context, options);
  }

  streamSimple(model: Model<"browser-universal">, context: Context, options?: SimpleStreamOptions) {
    return this.runStream(model, context, options);
  }

  private runStream(
    model: Model<"browser-universal">,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void this.runBridge(stream, model, context, options);
    return stream;
  }

  private async runBridge(
    stream: AssistantMessageEventStream,
    model: Model<"browser-universal">,
    context: Context,
    options?: StreamOptions,
  ): Promise<void> {
    const prompt = extractLatestUserPrompt(context);
    if (!prompt) {
      const error = buildAssistantMessage("Browser universal: empty prompt.", model, "error");
      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
      return;
    }

    const timeoutMs = this.timeoutMs;
    try {
      throwIfAborted(options?.signal);
      const browser = await chromium.connectOverCDP(this.cdpUrl);
      try {
        const pages = browser.contexts().flatMap((ctx) => ctx.pages());
        if (pages.length === 0) {
          throw new Error("No open pages found in the connected Chrome instance.");
        }
        const focusedPage = await resolveFocusedPage(pages);
        const matchedPage = focusedPage ?? (await resolvePageByRegex(pages, this.urlRegex));
        const page = matchedPage ?? pages[0];
        if (!page) {
          throw new Error("Unable to select an active tab for browser universal provider.");
        }

        const initialCount = await countAssistantBlocks(page);
        const input = await resolveInputLocator(page);
        await input.click({ timeout: timeoutMs });
        const isTextArea = await input.evaluate((node) => node instanceof HTMLTextAreaElement);
        if (isTextArea) {
          await input.fill(prompt, { timeout: timeoutMs });
        } else {
          await input.fill("");
          await input.type(prompt, { delay: 5 });
        }
        await input.press("Enter");

        await page.waitForFunction(
          (selectors, previousCount) => {
            for (const selector of selectors) {
              const matches = document.querySelectorAll(selector);
              if (matches.length > previousCount) {
                return true;
              }
            }
            return false;
          },
          ASSISTANT_SELECTORS,
          initialCount,
          { timeout: timeoutMs },
        );

        await waitForCompletion(page, timeoutMs);
        const responseText = await extractLatestAssistantText(page);
        if (!responseText) {
          throw new Error("Browser universal: no assistant response found.");
        }

        const message = buildAssistantMessage(responseText, model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: responseText,
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: responseText,
          partial: message,
        });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } finally {
        await browser.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = buildAssistantMessage(`Browser universal error: ${message}`, model, "error");
      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
    }
  }
}

export function registerBrowserUniversalProvider(options?: BrowserUniversalOptions): void {
  if (browserUniversalRegistered) {
    return;
  }
  const provider = new BrowserUniversalProvider(options);
  registerApiProvider(provider, "openclaw-browser-universal");
  browserUniversalRegistered = true;
}
