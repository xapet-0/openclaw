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
const DEFAULT_URL_REGEX = /chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com/i;
const DEFAULT_TIMEOUT_MS = 120_000;

type PlatformId = "chatgpt" | "claude" | "gemini" | "unknown";

type SelectorStrategy = {
  input: string[];
  stop: string[];
  send: string[];
  assistant: string[];
  modelLabel: string[];
  domHints: string[];
};

const BASE_SELECTORS: SelectorStrategy = {
  input: [
    "#prompt-textarea",
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Send"]',
    "textarea",
    'div[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
  ],
  stop: [
    'button[aria-label*="Stop"]',
    'button[title*="Stop"]',
    'button:has(svg[aria-label*="Stop"])',
    'button:has(svg[data-icon*="stop"])',
    'button:has(svg[data-testid*="stop"])',
  ],
  send: [
    'button[aria-label*="Send"]',
    'button[title*="Send"]',
    'button[data-testid*="send"]',
    'button:has(svg[aria-label*="Send"])',
    'button:has(svg[data-icon*="send"])',
  ],
  assistant: ['[data-message-author-role="assistant"]', ".markdown", ".prose", "article"],
  modelLabel: [
    'button[data-testid*="model"]',
    'button[aria-haspopup="listbox"]',
    '[data-testid*="model"]',
    'div[role="button"][aria-haspopup="listbox"]',
  ],
  domHints: [],
};

type PlatformProfile = {
  id: PlatformId;
  urlHints: RegExp[];
  selectors: Partial<SelectorStrategy>;
};

const PLATFORM_PROFILES: PlatformProfile[] = [
  {
    id: "chatgpt",
    urlHints: [/chatgpt\.com/i, /chat\.openai\.com/i],
    selectors: {
      input: [
        "textarea#prompt-textarea",
        'div[contenteditable="true"][data-testid="prompt-textarea"]',
      ],
      assistant: ['[data-message-author-role="assistant"]', ".markdown", ".prose"],
      stop: ['button[aria-label*="Stop"]', 'button[data-testid*="stop"]'],
      send: ['button[aria-label*="Send"]', 'button[data-testid*="send"]'],
      modelLabel: [
        'button[data-testid="model-switcher"]',
        'button[aria-label*="Model"]',
        'button[aria-haspopup="listbox"]',
      ],
      domHints: ['[data-message-author-role="assistant"]', "#prompt-textarea"],
    },
  },
  {
    id: "claude",
    urlHints: [/claude\.ai/i],
    selectors: {
      input: ['div[contenteditable="true"][role="textbox"]', "textarea"],
      assistant: ['div[data-testid="chat-messages"]', ".prose", "article"],
      stop: ['button[aria-label*="Stop"]', 'button:has(svg[data-icon*="stop"])'],
      send: ['button[aria-label*="Send"]', 'button[type="submit"]'],
      modelLabel: [
        'button[data-testid*="model"]',
        'button[aria-label*="Model"]',
        'div[role="button"][aria-haspopup="listbox"]',
      ],
      domHints: ['[data-testid="chat-messages"]', 'button[aria-label*="Model"]'],
    },
  },
  {
    id: "gemini",
    urlHints: [/gemini\.google\.com/i, /bard\.google\.com/i],
    selectors: {
      input: ['textarea[aria-label*="Enter a prompt"]', 'textarea[placeholder*="Enter"]'],
      assistant: ["response-container", ".markdown", ".prose", "article"],
      stop: ['button[aria-label*="Stop"]', 'button:has(svg[data-icon*="stop"])'],
      send: ['button[aria-label*="Send"]', 'button[aria-label*="Submit"]', 'button[type="submit"]'],
      modelLabel: [
        'button[aria-label*="Model"]',
        'button[aria-haspopup="listbox"]',
        '[data-test-id*="model"]',
      ],
      domHints: ['body:has([data-test-id*="gemini"])', 'div[aria-label*="Gemini"]'],
    },
  },
];

const INPUT_SELECTORS = BASE_SELECTORS.input;

const STOP_SELECTORS = BASE_SELECTORS.stop;

const SEND_SELECTORS = BASE_SELECTORS.send;

const ASSISTANT_SELECTORS = BASE_SELECTORS.assistant;

const MODEL_LABEL_SELECTORS = BASE_SELECTORS.modelLabel;

const UNKNOWN_PROFILE: PlatformProfile = {
  id: "unknown",
  urlHints: [],
  selectors: {},
};

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
  detectedModel?: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  const resolvedModel = detectedModel?.trim() || model.id;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: resolvedModel,
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

function mergeSelectors(base: string[], specific?: string[]): string[] {
  if (!specific || specific.length === 0) {
    return base;
  }
  const combined = [...specific, ...base];
  return Array.from(new Set(combined));
}

function resolveSelectorStrategy(profile: PlatformProfile): SelectorStrategy {
  return {
    input: mergeSelectors(INPUT_SELECTORS, profile.selectors.input),
    stop: mergeSelectors(STOP_SELECTORS, profile.selectors.stop),
    send: mergeSelectors(SEND_SELECTORS, profile.selectors.send),
    assistant: mergeSelectors(ASSISTANT_SELECTORS, profile.selectors.assistant),
    modelLabel: mergeSelectors(MODEL_LABEL_SELECTORS, profile.selectors.modelLabel),
    domHints: mergeSelectors(BASE_SELECTORS.domHints, profile.selectors.domHints),
  };
}

async function resolveInputLocator(
  page: Page,
  selectors: string[],
): Promise<ReturnType<Page["locator"]>> {
  for (const selector of selectors) {
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

async function countAssistantBlocks(page: Page, selectors: string[]): Promise<number> {
  return await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const matches = Array.from(document.querySelectorAll(selector));
      if (matches.length > 0) {
        return matches.length;
      }
    }
    return 0;
  }, selectors);
}

async function waitForCompletion(
  page: Page,
  timeoutMs: number,
  stopSelectors: string[],
  sendSelectors: string[],
): Promise<void> {
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
    stopSelectors,
    sendSelectors,
    { timeout: timeoutMs },
  );
}

async function extractLatestAssistantText(page: Page, selectors: string[]): Promise<string> {
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
  }, selectors);
}

async function resolveModelLabel(page: Page, selectors: string[]): Promise<string | undefined> {
  return await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) {
        return text;
      }
    }
    return undefined;
  }, selectors);
}

async function matchesDomHints(page: Page, selectors: string[]): Promise<boolean> {
  if (selectors.length === 0) {
    return false;
  }
  return await page.evaluate((selectors) => {
    return selectors.some((selector) => document.querySelector(selector));
  }, selectors);
}

async function detectPlatform(page: Page, urlRegex: RegExp): Promise<PlatformProfile> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const candidates = PLATFORM_PROFILES.filter((profile) =>
    profile.urlHints.some((hint) => hint.test(url) || hint.test(title)),
  );
  for (const profile of candidates) {
    const hints = profile.selectors.domHints ?? [];
    if (await matchesDomHints(page, hints)) {
      return profile;
    }
  }
  for (const profile of PLATFORM_PROFILES) {
    const hints = profile.selectors.domHints ?? [];
    if (await matchesDomHints(page, hints)) {
      return profile;
    }
  }
  if (urlRegex.test(url)) {
    const matched = PLATFORM_PROFILES.find((profile) =>
      profile.urlHints.some((hint) => hint.test(url)),
    );
    if (matched) {
      return matched;
    }
  }
  return UNKNOWN_PROFILE;
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
      const error = buildAssistantMessage(
        "Browser universal: empty prompt.",
        model,
        undefined,
        "error",
      );
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

        const profile = await detectPlatform(page, this.urlRegex);
        const strategy = resolveSelectorStrategy(profile);
        const modelLabel = await resolveModelLabel(page, strategy.modelLabel);

        const initialCount = await countAssistantBlocks(page, strategy.assistant);
        const input = await resolveInputLocator(page, strategy.input);
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
          strategy.assistant,
          initialCount,
          { timeout: timeoutMs },
        );

        await waitForCompletion(page, timeoutMs, strategy.stop, strategy.send);
        const responseText = await extractLatestAssistantText(page, strategy.assistant);
        if (!responseText) {
          throw new Error("Browser universal: no assistant response found.");
        }

        const message = buildAssistantMessage(responseText, model, modelLabel);
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
      const error = buildAssistantMessage(
        `Browser universal error: ${message}`,
        model,
        undefined,
        "error",
      );
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
