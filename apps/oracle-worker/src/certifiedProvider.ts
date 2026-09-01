import { ChatGptAdapter } from "../../../packages/chatgpt-adapter/src/index.js";
import {
  launchOracleBrowserRuntime,
  readRuntimeCertification,
  type OracleBrowserRuntime,
} from "../../../packages/oracle-browser-runtime/src/index.js";
import type {
  CompatibilityReceipt,
  PreparationReceipt,
  ProviderAdapter,
  ProviderCaptureContext,
  ProviderCaptureResult,
  ProviderDispatchContext,
  ProviderJobContext,
  ProviderRuntimeBindings,
  SubmissionReceipt,
} from "../../../packages/oracle-kernel/src/index.js";

export interface CertifiedChatGptProviderOptions {
  runtimeRoot: string;
  chatGptUrl?: string;
  maxOpenPages?: number;
}

export class CertifiedChatGptProvider implements ProviderAdapter {
  private readonly options: CertifiedChatGptProviderOptions;
  private bindings?: ProviderRuntimeBindings;
  private runtime?: OracleBrowserRuntime;
  private adapter?: ChatGptAdapter;

  constructor(options: CertifiedChatGptProviderOptions) {
    this.options = options;
  }

  bindRuntime(bindings: ProviderRuntimeBindings): void {
    this.bindings = bindings;
    this.adapter?.bindRuntime(bindings);
  }

  async probe(): Promise<CompatibilityReceipt> {
    return (await this.ensureAdapter()).probe();
  }

  async prepare(context: ProviderJobContext): Promise<PreparationReceipt> {
    return (await this.ensureAdapter()).prepare(context);
  }

  async verifyPrepared(context: ProviderJobContext, receipt: PreparationReceipt): Promise<void> {
    return (await this.ensureAdapter()).verifyPrepared(context, receipt);
  }

  async dispatchOnce(context: ProviderDispatchContext): Promise<void> {
    return (await this.ensureAdapter()).dispatchOnce(context);
  }

  async observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined> {
    return (await this.ensureAdapter()).observeCommit(context);
  }

  async capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult> {
    return (await this.ensureAdapter()).capture(context);
  }

  async releaseJob(jobId: string): Promise<void> {
    await this.adapter?.releaseJob(jobId);
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    const runtime = this.runtime;
    const errors: unknown[] = [];
    try {
      await adapter?.close();
      if (this.adapter === adapter) this.adapter = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await runtime?.close();
      if (this.runtime === runtime) this.runtime = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Oracle v2 certified provider cleanup failed");
    }
  }

  private async ensureAdapter(): Promise<ChatGptAdapter> {
    if (this.adapter) return this.adapter;
    const certification = readRuntimeCertification(this.options.runtimeRoot);
    if (!certification) {
      throw new Error("Oracle v2 worker requires the G1 browser runtime certification");
    }
    const runtime = await launchOracleBrowserRuntime({
      runtimeRoot: this.options.runtimeRoot,
      headless: false,
    });
    if (runtime.receipt.browserRuntimeId !== certification.browserRuntimeId) {
      await runtime.close();
      throw new Error("Oracle v2 worker runtime does not match the G1 certification");
    }
    const adapter = new ChatGptAdapter({
      context: runtime.context,
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      urlForJob: () => this.options.chatGptUrl ?? "https://chatgpt.com/",
      openPage: (url) => runtime.openPage(url),
      adapterVersion: "chatgpt-adapter-v2-r8",
      actionTimeoutMs: 30_000,
      commitTimeoutMs: 120_000,
      maxOpenPages: this.options.maxOpenPages ?? 3,
    });
    if (this.bindings) adapter.bindRuntime(this.bindings);
    this.runtime = runtime;
    this.adapter = adapter;
    return adapter;
  }
}
