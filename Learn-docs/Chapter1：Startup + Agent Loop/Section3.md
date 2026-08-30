# 一.循环检测

## 最常见的三种模式

真正麻烦的不是while(true)，而是模型在不断地做事，但没有任何进展。它每一步都在调工具，看起来很忙，但其实在原地打转。

```bash
通用重复——同一个工具、同样的参数、同样的结果，反复调
乒乓循环——两个操作来回交替，A → B → A → B，每一步看起来都在"做事"，但整体没有进展
轮询无进展——不断 poll 检查状态，结果一直是 "running"
```

```text
核心思路：指纹 + 滑动窗口
1 给每次工具调用算指纹
  把工具名 + 参数做一次确定性的 JSON 序列化（key 排序），然后哈希。这样 get_weather({"city":"北京"}) 不管参数顺序怎么变，指纹都一样
2 维护滑动窗口（最近 30 条）
  只看最近的行为，早期的正常行为不太具备参考意义，主要看看最近若干轮有没有出现重复。
3 同样的输入 + 同样的输出 = 无进展
  光看参数相同还不够。
  模型调了 10 次 read_file 但每次读的都是不同文件，这是正常探索。只有调用指纹和结果指纹都一样，才算真的没进展。
```

## 循环检测代码解析

```typescript
//从 Node.js 内置 crypto 模块导入 createHash，后面用 SHA-256 给参数和结果生成稳定指纹。
import { createHash } from "node:crypto";

// --- 类型定义 ---
//工具调用记录
export interface ToolCallRecord {
  toolName: string; //工具名。例如：read_file
  argsHash: string; //工具名+参数 共同生成的哈希，用于判断"是不是同一次参数调用"
  resultHash?: string; //结果哈希。?表示可选：刚记录调用时还没有结果
  timestamp: number; //调用发生时间，通常是 Date.now() 返回的毫秒时间戳。
}

/*
检测器种类：
1 generic_repeat(通用循环)：相同工具、相同参数被连续/频繁重复调用。
2 ping_pong(乒乓循环)：两个调用模式交替出现，如 A-B-A-B-A。
3 global_circuit_breaker(全局熔断器)：相同调用得到相同结果太多次，触发强制熔断。
*/
export type DetectorKind =
  | "generic_repeat"
  | "ping_pong"
  | "global_circuit_breaker";

//检测器结果
export type DetectionResult =
  | { stuck: false } //没检测到问题时，只返回 { stuck: false }。
  | {
      stuck: true; //检测到卡住
      level: "warning" | "critical"; //级别：警告｜严重
      detector: DetectorKind; //哪种检测器触发
      count: number; //重复次数
      message: string; // 可直接展示给用户或日志的说明
    };

// --- 配置 ---

const HISTORY_SIZE = 30; // 滑动窗口大小
const WARNING_THRESHOLD = 5; // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8; // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10; // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

//把任意输入转成"字段顺序稳定"的字符串
function stableStringify(value: unknown): string {
  //如果value是null或者基本类型，直接JSON序列化. eg: "hello" ->"hello" , 42 -> "42"
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  //如果是数组，递归序列化每一项，并保留数组原本顺序. eg:[{ b: 2, a: 1 }]->[{"a":1,"b":2}]
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  //如果是普通对象，取出键名并排序。这样下面两个对象会得到一样的字符串：
  const keys = Object.keys(value as Record<string, unknown>).sort();

  //按排序后的键名递归拼出 JSON 风格字符串。as any 是为了让 TypeScript 允许按动态键读取值。
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
}

//定义一个私有哈希函数
function hash(input: string): string {
  //创建 SHA-256 哈希器 ->  写入字符串 -> 生成十六进制摘要 -> 只取前 16 个字符
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

//导出工具调用指纹函数
export function hashToolCall(toolName: string, params: unknown): string {
  //工具名和参数哈希组合起来.
  //eg:hashToolCall('search', { q: 'TypeScript' }) -> 'search:a1b2c3d4...'
  //工具名也纳入指纹，所以不同工具即使参数相同，也不会被当作同一次调用。
  return `${toolName}:${hash(stableStringify(params))}`;
}

//结果也会稳定序列化后哈希，用于判断“结果是否真的没有变化”。
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

const history: ToolCallRecord[] = []; //模块级全局数组，存储近期调用历史。它在这个 Node.js 进程中共享。

//每次调用工具前，记录一次调用。
export function recordCall(toolName: string, params: unknown): void {
  //向历史数组末尾添加记录
  history.push({
    toolName, //工具名称
    argsHash: hashToolCall(toolName, params), //计算并记录工具参数指纹。
    timestamp: Date.now(), //记录当前调用时间。
  });
  if (history.length > HISTORY_SIZE) history.shift(); //如果数量超过滑动窗口大小(30)，删除最旧的一条，确保窗口大小固定。
}

//工具执行完成后，把结果补写回对应的调用记录
export function recordResult(
  toolName: string,
  params: unknown,
  result: unknown,
): void {
  const argsHash = hashToolCall(toolName, params); //重新计算调用参数哈希，以定位对应历史记录。
  const resultH = hashResult(result); //计算执行结果的哈希。

  //从最新记录向前查找
  for (let i = history.length - 1; i >= 0; i--) {
    //找到最新的一条满足以下条件的记录：工具名相同、参数指纹相同、还没有结果
    if (
      history[i].toolName === toolName &&
      history[i].argsHash === argsHash &&
      !history[i].resultHash
    ) {
      history[i].resultHash = resultH; //把结果哈希写入该记录。
      break; //只更新一条，找到后停止遍历。
    }
  }
}

//清空调用历史。
export function resetHistory(): void {
  history.length = 0; //直接改数组长度，保留原数组引用。
}

// --- 检测器 ---

//1 无进展重复检测
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0; //当前连续无进展次数
  let lastResultHash: string | undefined; //保存最新一次有效结果的哈希，后面的历史结果要与它比较。

  //从最新调用开始，向旧记录回溯。
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]; //取当前历史记录，简化后续访问。
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue; //如果不是目标工具或目标参数，跳过它。
    if (!r.resultHash) continue; //没有结果的调用也跳过，因为无法判断是否有进展。
    //第一次遇到有结果的记录时，把它作为基准，并把连续次数设为 1。
    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    //如果当前历史记录的结果哈希不等最后的结果哈希， 结果变了 -> 说明有进展
    if (r.resultHash !== lastResultHash) break;
    streak++; //结果相同，连续无进展。次数+1
  }
  return streak; // 返回最终连续无进展次数
}

//2 乒乓循环检测
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0; //历史小于三条数据时，不足以判断为交替模式（A->B->A），直接返回0
  const last = history[history.length - 1]; //取最近一次调用记录
  let otherHash: string | undefined; //保存其他哈希指纹
  //从倒数第二条开始向前寻找。
  for (let i = history.length - 2; i >= 0; i--) {
    //找到第一条与最近调用不同的参数指纹，并把它认定为交替模式中的另一方。

    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0; //如果所有历史调用都与最新调用相同，则不是乒乓循环。
  let count = 0; //开始统计末尾交替序列长度
  //从最近记录向前扫描
  for (let i = history.length - 1; i >= 0; i--) {
    //count为偶数，与最新调用一致。为奇数时，为另一种调用。
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    //如果不符合A->B->A->B的交替规律，就停止
    if (history[i].argsHash !== expected) break;
    count++; //符合规律，计数+1
  }

  //如果当前准备调用的参数恰好是“另一方”，且历史里至少已经形成两次交替，则预测这次调用会让循环长度再加一。
  //eg: history: A, B, A, B   current: A   历史交替长度是 4；当前调用会形成 A, B, A, B, A，因此返回 5。
  if (currentHash === otherHash && count >= 2) return count + 1;

  return 0; //当前调用不能延续交替模式时，不认为是乒乓循环。
}

// --- 主检测函数 ---

//对“准备执行”的工具调用进行检测。
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params); //计算当前调用的唯一指纹
  const noProgress = getNoProgressStreak(toolName, argsHash); //统计此前同一调用、同一结果连续出现的次数

  //如果无进展次数达到了10次
  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: "critical", // 全局熔断
      detector: "global_circuit_breaker",
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  //检查当前调用是否会延续 A-B-A-B 式循环。
  const pingPong = getPingPongCount(argsHash);
  //交替次数达到 8 次，判定严重。
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical", //严重
      detector: "ping_pong",
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  //如果还没到严重阈值，但交替次数已经达到 5 次。
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning", //警告
      detector: "ping_pong",
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  //统计滑动窗口内，当前工具名和参数组合已经出现过多少次。这里不关心是否有结果、结果是否相同。
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash,
  ).length;

  //如果相同调用已在窗口中出现至少 8 次。
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical", //严重
      detector: "generic_repeat",
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  //相同调用达到 5 次时给出警告。
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning", //警告
      detector: "generic_repeat",
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  return { stuck: false }; //所有检测都没有命中，说明这次调用暂未表现出卡住或循环风险。
}
```

# 二.API容错

```bash
核心是分类：哪些值得重试，哪些直接抛。
```

```typescript
// --- 错误分类 ---

//导出一个函数，接收未知类型的 error。返回布尔值：true：建议重试；false：不建议重试；
//使用 unknown 比 any 更安全，强制函数内部先判断类型。
export function isRetryable(error: unknown): boolean {
  // 只处理原生 Error 实例。
  // 非 Error 对象（例如字符串、数字）无法判断，直接视为不可重试。
  if (!(error instanceof Error)) return false;

  const message = error.message || ""; //读取错误信息。 || ''： 主要是防御性处理。

  // HTTP 状态码判断
  const statusMatch = message.match(/(\d{3})/); // 查找消息中出现的第一个连续三位数字。

  //如果找到三位数字，就进入状态码判断。
  if (statusMatch) {
    const status = parseInt(statusMatch[1]); //把字符串转换为数字。
    if ([429, 529, 408].includes(status)) return true; // 明确可重试的状态码：限流 429、服务过载 529、请求超时 408
    if (status >= 500 && status < 600) return true; // 5xx 服务端内部错误通常属于临时故障，值得重试
    if (status >= 400 && status < 500) return false; // 4xx 客户端错误属于请求本身有问题，重试也没用
  }

  // 网络错误
  if (message.includes("ECONNRESET") || message.includes("EPIPE")) return true; // 网络层常见错误：连接被重置、管道破裂，多为临时问题
  // 超时相关：连接超时或显式 timeout 关键字
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) return true;
  // 通用网络/ fetch 失败
  if (message.includes("fetch failed") || message.includes("network"))
    return true;
  // AI SDK 常见临时失败：模型没有生成输出，可重试
  if (message.includes("No output generated")) return true;

  // 不属于以上任何一种，默认不重试
  return false;
}

// --- 指数退避 + 随机抖动 ---

// 根据第几次重试计算等待时间：指数增长，并加上 25% 随机抖动，避免所有重试同时发起
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30000,
): number {
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

# 三.Token预算

最小可用版本——把每步的 token 用量累加起来，超了就停。

```typescript
import { streamText, type ModelMessage } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay, sleep } from './retry.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

//1 定义预算状态
export interface BudgetState {
  used: number;//已使用Token
  limit: number;//最大允许Token
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) {
  let step = 0;
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({ model, system, tools, messages, maxRetries: 0, onError: () => {} });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    messages.push(...stepResponse!.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计

    //2 获取本轮输入Token
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : (stepUsage?.inputTokens?.total ?? 0);
    //3 获取本轮输出Token
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : (stepUsage?.outputTokens?.total ?? 0);
    //4 累计Token
    budget.used += inp + out;//本轮消耗 = 输入 Token + 输出 Token
    //5 计算预算使用率
    const pct = Math.round(budget.used / budget.limit * 100);
    //6 输出预算信息
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`); // eg:[Token] 7500/10000 (75%)
    //7 判断是否超出预算
    if (budget.used > budget.limit) {
      console.log('\n[Token 预算耗尽，强制停止]');//当已使用 Token 超过上限时，停止 Agent 主循环。
      break;
    }

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  → 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}

```
