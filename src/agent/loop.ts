import { streamText, stepCountIs, type ModelMessage } from "ai"; // Vercel AI SDK：streamText 用于流式调用模型，ModelMessage 是消息类型
import { ToolRegistry } from "../tools/registry.js"; // 工具注册中心：管理可用工具，并转换为 AI SDK 所需的工具格式
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection.js"; // 循环检测：识别 Agent 重复调用工具的卡死行为
import { isRetryable, calculateDelay, sleep } from "./retry.js"; // 重试工具：判断是否可重试、计算退避延迟、休眠等待
import { type UsageTracker, normalizeUsage } from "../usage/tracker.js"; // 用量统计：累计 token 消耗与成本，统一不同厂商的 usage 格式

// --- 保护阈值 ---

const MAX_STEPS = 15;      // 最大步数上限：防止模型在工具调用间无限循环
const MAX_RETRIES = 3;     // 单步最大重试次数：网络抖动等临时错误最多重试 3 次
const TOKEN_BUDGET = 50000; // Token 预算：累计 token 超过此值强制停止，控制成本


// --- Agent 主循环 ---

// 参数说明：
//   model:     模型实例（AI SDK 的 LanguageModel）
//   registry:  工具注册中心，提供 toAISDKFormat() 供 streamText 使用
//   messages:  对话历史数组（引用类型，调用方共享，原地追加）
//   system:    系统提示词
//   tracker:   可选的用量统计器，用于累计 token 消耗和成本
export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
) {
  let step = 0;          // 当前步数（每轮模型调用+工具执行算一步）
  let totalTokens = 0;   // 累计 token 消耗
  resetHistory();        // 开始新会话前清空循环检测历史，避免上一次的记录干扰本次判断

  // 主循环：每轮 = 一次模型调用 + 若干工具执行
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // --- 本步的临时状态 ---
    let hasToolCall = false;                                  // 本步是否产生了工具调用（决定循环是否继续）
    let fullText = "";                                        // 本步模型生成的完整文本
    let shouldBreak = false;                                  // 循环检测触发 critical 时置 true，强制结束
    let lastToolCall: { name: string; input: unknown } | null = null; // 最近一次工具调用，用于给结果补录指纹
    let stepResponse: any;                                    // 本步模型完整响应（含 messages）
    let stepUsage: any;                                       // 本步 token 用量

    // --- 重试循环：网络错误时最多重试 MAX_RETRIES 次 ---
    for (let attempt = 1; ; attempt++) {
      try {
        // streamText 同步返回结果对象（不等模型生成完）：
        // - result.fullStream：异步事件流（text-delta / tool-call / tool-result / finish），下面 for await 逐块消费
        // - result.text / response / usage：Promise，生成结束后取完整文本、响应消息和 token 用量
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          // stopWhen: stepCountIs(5),// 自动循环
          /* Vercel AI SDK 自动循环:当模型返回工具调用时
            SDK 会自动执行工具、把结果喂回模型、让模型继续生成，直到模型不再调用工具为止
            生产级Agent里，Agent Loop把控制权交给开发者，
            因为需要在每一步之间做很多事：打日志、检查 token 用量、判断是不是陷入死循环、决定要不要中断。
          */
          providerOptions: { openai: { parallelToolCalls: true } }, // 允许模型一次性返回多个工具调用
          onError: () => {},                                        // 流式错误回调：吞掉错误，由外层 try/catch 处理
        });

        // 遍历异步数据流：数据一块一块地来，每块都要等
        for await (const part of result.fullStream) {
          // console.log(`  [模型输出] ${JSON.stringify(part)}`);// fullStream:包含完整的事件流,每个事件都有 type 字段知道发生了什么
          switch (part.type) {
            // 文本增量：模型生成的文字片段，流式打印到终端并累积到 fullText
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            // 工具调用：模型请求执行某个工具，记录调用信息并做循环检测
            case "tool-call": {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              // 循环检测：连续调用同一个工具、传同样的参数——明显是在兜圈子
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === "critical") {
                  // 严重级别：直接标记停止，不再给模型机会
                  shouldBreak = true;
                } else {
                  // 警告级别：不停止，但往对话里塞一条系统提醒，引导模型换思路
                  messages.push({
                    role: "user" as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input); // 把本次调用记入历史，供后续检测使用
              break;
            }

            // 工具结果：工具执行完毕返回输出，打印前 120 字符预览并记录结果
            case "tool-result": {
              const output =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output);
              const preview =
                output.length > 120 ? output.slice(0, 120) + "..." : output;
              console.log(`  [结果: ${part.toolName}] ${preview}`);
              if (lastToolCall) {
                // 为最近一次工具调用补录结果指纹，供“无进展”检测使用
                recordResult(
                  lastToolCall.name,
                  lastToolCall.input,
                  part.output,
                );
              }
              break;
            }
          }
        }

        stepResponse = await result.response; // 流式输出结束后取本步完整响应：里面带着模型生成的消息（回复文本 + 工具调用/结果）
        stepUsage = await result.usage;       // 取本步 token 用量
        break; // 成功执行完本步，跳出重试循环
      } catch (error) {
        // 超过最大重试次数，或错误不可重试（如 4xx），直接抛给上层
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`,
        );
        await sleep(delay);
        // 重试前重置本步状态，避免残留数据干扰下一轮
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    // --- 检查循环检测是否触发 critical ---
    if (shouldBreak) {
      console.log("\n[循环检测触发，Agent 已停止]");
      break;
    }

    messages.push(...stepResponse!.messages); // 把本步产生的消息原地追加进 messages（调用方传入的同一个数组），作为下一步 streamText 的输入，形成多步对话历史

    // --- 用量统计与预算控制 ---

    // 把 usage 喂给 tracker；tracker 内部按四类 token 分别累加并算 cost
    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(model?.modelId || "mock-model", norm);
    totalTokens +=
      norm.inputTokens +
      norm.outputTokens +
      norm.cacheReadTokens +
      norm.cacheWriteTokens;

    // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
    if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
      const tag =
        norm.cacheReadTokens > 0
          ? `\x1b[38;5;36m✓ cache hit\x1b[0m`
          : `\x1b[38;5;220m✎ cache write\x1b[0m`;
      const detail =
        norm.cacheReadTokens > 0
          ? `read ${norm.cacheReadTokens}`
          : `write ${norm.cacheWriteTokens}`;
      console.log(
        `  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`,
      );
    }

    // 接近预算时打印警告（超过 90%）
    if (totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(
        `  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round((totalTokens / TOKEN_BUDGET) * 100)}%)`,
      );
    }
    // 超过预算：强制停止
    if (totalTokens > TOKEN_BUDGET) {
      console.log("\n[Token 预算耗尽]");
      break;
    }

    // --- 判断是否继续下一步 ---

    // 本步没有工具调用：说明模型直接给出了最终文本回复，任务完成，退出循环
    if (!hasToolCall) {
      if (fullText) console.log(); // 补一个换行，让输出格式整齐
      break;
    }

    console.log("  → 继续下一步...");
  }

  // 走到这里说明是 MAX_STEPS 上限截断，而非自然结束
  if (step >= MAX_STEPS) {
    console.log("\n[达到最大步数]");
  }
}

/**
 * while循环的结构：
 * 调一次 streamText，不设 stopWhen（默认只跑一步）
 * 遍历 fullStream，收集文本和工具调用
 * 把这一步的消息追加到 messages
 * 判断退出条件：如果这一步没有工具调用，说明模型直接给出了文本回复，循环结束
 * 如果有工具调用，回到步骤 1，模型会看到工具的执行结果，决定下一步做什么
 * 
 * 是否进行下一步：有退出条件，根据退出路径会选择结束循环还是继续下一步
 * 生产环境里，退出条件会复杂得多：
 * 步数上限：防止模型陷入无限循环（我们这里的 MAX_STEPS）
 * Token 预算：累计输出超过阈值就强制停止
 * 重复检测：连续调用同一个工具、传同样的参数——明显是在兜圈子
 * 用户中断：AbortSignal 随时可以打断
 * 等等
 */
