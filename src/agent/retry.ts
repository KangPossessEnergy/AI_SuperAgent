// --- 错误分类 ---

// 判断一个错误是否值得重试：只有“临时性/网络性”错误才重试，业务错误不重试
export function isRetryable(error: unknown): boolean {
  // 非 Error 对象（例如字符串、数字）无法判断，直接视为不可重试
  if (!(error instanceof Error)) return false;

  const message = error.message || '';

  // 从错误信息里尝试提取 HTTP 状态码（如 429、500）
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    // 明确可重试的状态码：限流 429、服务过载 529、请求超时 408
    if ([429, 529, 408].includes(status)) return true;
    // 5xx 服务端内部错误通常属于临时故障，值得重试
    if (status >= 500 && status < 600) return true;
    // 4xx 客户端错误属于请求本身有问题，重试也没用
    if (status >= 400 && status < 500) return false;
  }

  // 网络层常见错误：连接被重置、管道破裂，多为临时问题
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  // 超时相关：连接超时或显式 timeout 关键字
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  // 通用网络/ fetch 失败
  if (message.includes('fetch failed') || message.includes('network')) return true;
  // AI SDK 常见临时失败：模型没有生成输出，可重试
  if (message.includes('No output generated')) return true;

  // 不属于以上任何一种，默认不重试
  return false;
}

// --- 指数退避 + 随机抖动 ---

// 根据第几次重试计算等待时间：指数增长，并加上 25% 随机抖动，避免所有重试同时发起
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  // 指数部分：第 1 次 500ms，第 2 次 1000ms，第 3 次 2000ms...
  const exponential = baseMs * Math.pow(2, attempt - 1);
  // 上限保护：最大不超过 maxMs，防止等待时间无限增长
  const capped = Math.min(exponential, maxMs);
  // 抖动范围：正负 25%
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  // 确保结果非负并取整
  return Math.max(0, Math.round(jittered));
}

// 异步等待指定毫秒：常用在重试之间制造间隔
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
