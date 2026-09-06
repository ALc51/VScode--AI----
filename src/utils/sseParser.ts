/**
 * SSE (Server-Sent Events) 流式解析器
 * 用于解析国内厂商 API 的流式响应
 */
export class SSEParser {
  private buffer = "";

  /**
   * 推入新的数据块，返回解析出的 JSON 对象数组
   */
  feed(chunk: string): Array<Record<string, unknown>> {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // 最后一行可能不完整，保留在 buffer 中
    this.buffer = lines.pop() || "";

    return this.parseLines(lines);
  }

  flush(): Array<Record<string, unknown>> {
    if (!this.buffer) {
      return [];
    }

    const lines = [this.buffer];
    this.buffer = "";
    return this.parseLines(lines);
  }

  private parseLines(lines: string[]): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) {
        continue; // 跳过空行和注释行
      }
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        try {
          results.push(JSON.parse(data));
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    return results;
  }

  reset(): void {
    this.buffer = "";
  }
}
