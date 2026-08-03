// 从 Node.js 内置加密模块导入 createHash，用于生成参数/结果的 SHA-256 指纹
import { createHash } from 'node:crypto';

// --- 类型定义 ---

// 一条工具调用记录：存哈希而非原始参数/结果，既省内存又便于比较
export interface ToolCallRecord {
  toolName: string;
  argsHash: string;        // 工具名 + 参数的指纹，由 hashToolCall 生成
  resultHash?: string;     // 结果的指纹，调用返回后由 recordResult 补录
  timestamp: number;       // 调用时间戳，毫秒级
}

// 三种检测器：通用重复 / A-B 交替（乒乓）/ 无进展熔断
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

// 检测结果：未卡住，或卡住并给出级别（warning 提醒 / critical 强制停止）
export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

// --- 配置 ---

// 滑动窗口大小：只保留最近 30 条调用记录，防止历史无限增长
const HISTORY_SIZE = 30;
const WARNING_THRESHOLD = 5;// 警告阈值：注入系统提醒消息,让模型“醒过来”换策略 warning（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8;// 严重阈值：阻断工具调用，强制停止循环 critical（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10;// 熔断阈值：无论什么情况，强制停止（演示用，生产环境通常是 30）

// --- 指纹计算 ---

// 稳定序列化：保证对象属性顺序一致，使等价对象得到相同哈希
// 注意：不处理循环引用、Map、Set、Symbol 等边界情况
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

// 使用 sha256 计算字符串哈希，并取前 16 位作为短指纹，兼顾唯一性与可读性
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// 将工具名和参数序列化后生成调用指纹：工具名不同或参数不同都会得到不同结果
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

// 将结果对象序列化后生成结果指纹，用于判断同一调用是否返回相同结果
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

// 全局历史队列：按调用顺序保存 ToolCallRecord，作为循环检测的数据源
const history: ToolCallRecord[] = [];

// 记录一次新的工具调用：先生成参数指纹，再压入队列；队列超长时移除最旧记录
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift(); // 超过窗口大小时移除最旧记录
}

// 为最近一次匹配的调用补录结果指纹：从后往前找到第一个工具名、参数指纹相同且尚未记录结果的槽位
export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

// 重置历史：清空所有调用记录，常用于任务切换或开始新的 agent 会话
export function resetHistory(): void {
  history.length = 0;
}

// --- 检测器 ---

// 计算“无进展”连续次数：从最近一次当前调用开始往回数，结果指纹相同的连续次数
// 一旦结果指纹发生变化，说明这次调用产生了新进展，streak 中断
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    // 只关心当前工具且参数指纹相同的记录
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    // 未返回结果的记录无法判断进展，跳过
    if (!r.resultHash) continue;
    if (!lastResultHash) {
      // 第一次命中：以该结果指纹作为基准，并开始计数
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    // 结果指纹与基准不一致，说明出现新进展，停止计数
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

// 检测 A-B 乒乓循环：从历史末尾往前看，是否只有两种调用在交替出现
// currentHash 是本次即将发起的调用指纹；若它等于 anotherHash 且已形成足够交替，则计入
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;

  const last = history[history.length - 1];
  let otherHash: string | undefined;

  // 从倒数第二条开始往前找，第一个与最后一条不同的指纹就是“另一条腿”
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;

  // 从末尾往前校验严格交替：偶数位（从 0 起）应等于 last，奇数位应等于 otherHash
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }

  // 如果本次调用正好接上 anotherHash，且历史中已形成至少 2 次交替，则把本次也算入
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---

// 对即将发起的工具调用进行循环检测，按严重程度依次返回 critical/warning/正常
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);

  // 1. 无进展熔断：同一调用反复返回相同结果，说明 agent 在原地踏步，最严重
  const noProgress = getNoProgressStreak(toolName, argsHash);
  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  // 2. 乒乓循环检测：A-B-A-B 交替调用，常见于两类工具互相拉扯
  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  // 3. 通用重复检测：同一工具、相同参数在窗口内出现多次
  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  // 未命中任何阈值：视为正常调用
  return { stuck: false };
}
