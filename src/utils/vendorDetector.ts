import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { ExtensionLogger } from "./logger";

/**
 * 通过读取 VS Code 内部状态数据库（state.vscdb）检测当前 Chat 面板/编辑器选中的模型厂商。
 *
 * state.vscdb 是 SQLite 格式，ItemTable 中以纯文本存储 key-value：
 *   key: "chat.currentLanguageModel.panel"
 *   value: "deepseek/deepseek-chat"  （格式 {vendor}/{modelId}）
 *
 * 采用纯二进制搜索（fs.readFileSync + Buffer.indexOf），无外部依赖，平均 ~1ms。
 */
export class VendorDetector implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeVendor = this.changeEmitter.event;

  private currentVendor?: string;
  private timer?: ReturnType<typeof setInterval>;
  private dbPath: string;
  private sessionsDir: string;

  // ── ChatSessionStore.index 缓存 ──
  private cachedIndexRaw?: string;
  private cachedIndexVendor?: string;

  // ── Provider 活跃追踪 ──
  // VS Code 切换对话时不更新 chat.currentLanguageModel.panel，无法依赖该键判断当前对话模型。
  // 改为以 Provider 被 VS Code 调用为唯一依据：被调用则确认在用厂商模型，否则隐藏。
  private lastProviderActivityAt = Date.now();
  /** Provider 被 VS Code 调用时调用此方法 */
  markProviderActivity(): void {
    this.lastProviderActivityAt = Date.now();
  }

  constructor(
    context: vscode.ExtensionContext,
    private readonly supportedVendors: readonly string[],
    pollIntervalMs = 3000
  ) {
    // globalStorageUri → {appdata}/Code/User/globalStorage/{extensionId}
    // state.vscdb 在同级目录：{appdata}/Code/User/globalStorage/state.vscdb
    this.dbPath = path.resolve(
      context.globalStorageUri.fsPath,
      "..",
      "state.vscdb"
    );
    // 会话 JSONL 文件目录：{appdata}/Code/User/globalStorage/emptyWindowChatSessions
    this.sessionsDir = path.resolve(
      context.globalStorageUri.fsPath,
      "..",
      "emptyWindowChatSessions"
    );

    // 首次立即检测
    this.check();

    // 轮询
    this.timer = setInterval(() => this.check(), pollIntervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changeEmitter.dispose();
  }

  /** 当前检测到的厂商（可能是不支持的厂商或 undefined） */
  get vendor(): string | undefined {
    return this.currentVendor;
  }

  /** 当前是否为本插件支持的厂商 */
  get isSupported(): boolean {
    return !!this.currentVendor && this.supportedVendors.includes(this.currentVendor);
  }

  // ── 私有方法 ──────────────────────────────────────────

  private check(): void {
    try {
      const panel = this.extractVendor("chat.currentLanguageModel.panel");
      const editor = this.extractVendor("chat.currentLanguageModel.editor");
      const detected = panel ?? editor;

      if (detected !== this.currentVendor) {
        this.currentVendor = detected;
        this.changeEmitter.fire(detected);
      }
    } catch (err) {
      // 读取失败不中断轮询（文件可能被锁定、格式变更等）
      ExtensionLogger.get().warn(`VendorDetector 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 读取 state.vscdb 中指定 key 的值，提取 vendor 名称。
   *
   * 优先使用 sqlite3 CLI（可靠），失败时回退到二进制搜索（无依赖）。
   */
  private extractVendor(keyStr: string): string | undefined {
    // 方法 1：sqlite3 CLI（最可靠）
    try {
      const result = execFileSync("sqlite3", [
        this.dbPath,
        `SELECT value FROM ItemTable WHERE key = '${keyStr}';`,
      ], { timeout: 2000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

      if (result && result.includes("/") && result.length < 80) {
        return result.split("/")[0];
      }
    } catch {
      // sqlite3 不可用或查询失败，回退到二进制搜索
    }

    // 方法 2：二进制搜索（无外部依赖的后备方案）
    return this.extractVendorBinary(keyStr);
  }

  /**
   * 从 state.vscdb 中读取指定 key 的原始值（不做格式解析）。
   */
  private readRawValue(keyStr: string): string | undefined {
    // 方法 1：sqlite3 CLI
    try {
      const result = execFileSync("sqlite3", [
        this.dbPath,
        `SELECT value FROM ItemTable WHERE key = '${keyStr}';`,
      ], { timeout: 2000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

      if (result) {
        return result;
      }
    } catch {
      // sqlite3 不可用，回退到二进制搜索
    }

    // 方法 2：二进制搜索
    return this.readRawValueBinary(keyStr);
  }

  /**
   * 在 state.vscdb 二进制内容中搜索指定 key，提取紧随其后的 value。
   *
   * SQLite ItemTable 中 key 和 value 以纯文本连续存储：
   *   [...key-bytes][non-printable-header][value-bytes...]
   *
   * 策略：搜索 key 字节 → 跳过不可打印前缀 → 提取连续可打印 ASCII。
   */
  private extractVendorBinary(keyStr: string): string | undefined {
    const value = this.readRawValueBinary(keyStr);
    if (value && value.includes("/") && value.length > 2 && value.length < 80) {
      return value.split("/")[0];
    }
    return undefined;
  }

  /**
   * 在 state.vscdb 二进制内容中搜索指定 key，提取原始 value 字符串。
   */
  private readRawValueBinary(keyStr: string): string | undefined {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.dbPath);
    } catch {
      return undefined;
    }

    const key = Buffer.from(keyStr);
    let idx = -1;

    while ((idx = buf.indexOf(key, idx + 1)) >= 0) {
      const afterKey = idx + key.length;

      // 排除长键前缀匹配（如 "chat.currentLanguageModel.panel.isDefault"）
      const nextByte = buf[afterKey];
      if (
        nextByte !== undefined &&
        ((nextByte >= 0x30 && nextByte <= 0x39) || // 0-9
         (nextByte >= 0x41 && nextByte <= 0x5a) || // A-Z
         (nextByte >= 0x61 && nextByte <= 0x7a) || // a-z
         nextByte === 0x5f ||                       // _
         nextByte === 0x2e)                         // .
      ) {
        continue;
      }

      // 跳过不可打印字节（SQLite record header）
      let start = afterKey;
      while (start < buf.length && buf[start] < 0x20) start++;

      // 提取连续可打印 ASCII
      let end = start;
      while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++;

      return buf.slice(start, end).toString("ascii");
    }

    return undefined;
  }

  /**
   * 从 ChatSessionStore.index 找到最近活跃的会话，读取其 JSONL 文件获取模型厂商。
   *
   * VS Code 将 ChatSessionStore.index 存储在 state.vscdb 中，包含所有会话的元数据。
   * 每个会话的 JSONL 文件（emptyWindowChatSessions/{sessionId}.jsonl）第一行包含
   * inputState.selectedModel.identifier，记录了该会话使用的模型。
   *
   * 通过 lastMessageDate 找到最近活跃的会话，再读取其 JSONL 文件获取真实模型厂商。
   */
  private extractVendorFromActiveSession(): string | undefined {
    try {
      // 读取 ChatSessionStore.index
      const raw = this.readRawValue("chat.ChatSessionStore.index");
      if (!raw) {
        return this.cachedIndexVendor;
      }

      // 值未变化则返回缓存
      if (raw === this.cachedIndexRaw) {
        return this.cachedIndexVendor;
      }
      this.cachedIndexRaw = raw;

      // 解析 JSON，找到最近活跃的会话
      const index = JSON.parse(raw);
      const entries: Record<string, unknown> | undefined = index?.entries;
      if (!entries || typeof entries !== "object") {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      let latestSessionId: string | undefined;
      let latestDate = 0;
      for (const [sessionId, entry] of Object.entries(entries)) {
        const e = entry as Record<string, unknown>;
        const date = typeof e.lastMessageDate === "number" ? e.lastMessageDate : 0;
        if (date > latestDate) {
          latestDate = date;
          latestSessionId = sessionId;
        }
      }

      if (!latestSessionId) {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      // 读取该会话的 JSONL 文件
      const sessionFile = path.join(this.sessionsDir, `${latestSessionId}.jsonl`);
      if (!fs.existsSync(sessionFile)) {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      const fd = fs.openSync(sessionFile, "r");
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);

      if (bytesRead === 0) {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
      if (!firstLine) {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      const data = JSON.parse(firstLine);
      const identifier: string | undefined = data?.v?.inputState?.selectedModel?.identifier;
      if (!identifier || typeof identifier !== "string") {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      const slashIdx = identifier.indexOf("/");
      if (slashIdx <= 0 || slashIdx >= identifier.length - 1) {
        this.cachedIndexVendor = undefined;
        return undefined;
      }

      const vendor = identifier.substring(0, slashIdx);
      this.cachedIndexVendor = vendor;
      return vendor;
    } catch {
      return this.cachedIndexVendor;
    }
  }
}
