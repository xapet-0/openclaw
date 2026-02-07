import type { Page } from "puppeteer-core";
import { BrowserClient } from "./browser-kernel.js";

export class BrowserActions {
  private readonly client: BrowserClient;

  constructor(client: BrowserClient = new BrowserClient()) {
    this.client = client;
  }

  async readScreen(): Promise<string> {
    const page = await this.client.getActivePage();
    return page.evaluate(() => document.body?.innerText ?? "");
  }

  async typeInput(selector: string, text: string): Promise<void> {
    const page = await this.client.getActivePage();
    await page.waitForSelector(selector, { state: "attached" });
    await page.focus(selector);
    await page.keyboard.type(text);
  }

  async clickElement(selector: string): Promise<void> {
    const page = await this.client.getActivePage();
    await page.waitForSelector(selector, { state: "attached" });
    await page.click(selector);
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.client.getActivePage();
    return fn(page);
  }
}
