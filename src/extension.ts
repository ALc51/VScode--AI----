import * as vscode from "vscode";
import { BaseLanguageModelProvider } from "./providers/baseProvider";
import { createDeepseekConfig } from "./providers/deepseek";
import { createQwenConfig } from "./providers/qwen";
import { createZhipuConfig } from "./providers/zhipu";
import { createKimiConfig } from "./providers/kimi";
import { createXiaomiConfig } from "./providers/xiaomi";
import { ExtensionLogger } from "./utils/logger";
import type { ProviderConfig } from "./types";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("国内AI适配插件");
  context.subscriptions.push(outputChannel);
  ExtensionLogger.get().init(outputChannel);

  const vendorConfigs: ProviderConfig[] = [
    createDeepseekConfig(),
    createQwenConfig(),
    createZhipuConfig(),
    createKimiConfig(),
    createXiaomiConfig(),
  ];

  for (const config of vendorConfigs) {
    const provider = new BaseLanguageModelProvider(config, context.globalState);
    context.subscriptions.push(provider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(config.vendor, provider)
    );
  }

  ExtensionLogger.get().info(`已注册 ${vendorConfigs.length} 个厂商 Provider`);
}

export function deactivate() {}
