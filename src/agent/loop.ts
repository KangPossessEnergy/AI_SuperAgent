import { streamText, stepCountIs, type ModelMessage } from "ai";
import { ToolRegistry } from "../tools/registry.js";
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection.js";
import { isRetryable, calculateDelay, sleep } from "./retry.js";
import { type UsageTracker, normalizeUsage } from "../usage/tracker.js";
import type { LocalTraceRecorder } from "../trace/recorder.js";

const MAX_STEPS = 15; // 最大步数上限：防止模型在工具调用间无限循环
const MAX_RETRIES = 3; // 单步最大重试次数：网络抖动等临时错误最多重试 3 次
const TOKEN_BUDGET = 50000; // Token 预算：累计 token 超过此值强制停止，控制成本

// Agent 主循环：每轮 = 一次模型调用 + 若干工具执行，直到模型给出纯文本回复，或触发停止条件（步数上限 / Token 预算 / 循环熔断 / 用户取消）
export async function agentLoop(
  model: any, // model: 模型实例（AI SDK 的 LanguageModel）
  registry: ToolRegistry, // registry: 工具注册中心，提供 toAISDKFormat() 供 streamText 使用
  messages: ModelMessage[], // messages: 对话历史数组（引用类型，调用方共享，原地追加）
  system: string, // system: 系统提示词
  tracker?: UsageTracker, // tracker: 可选，用量统计器，累计 token 消耗与成本
  tag?: string, // tag: 可选，日志前缀标签，用于区分子 agent 的输出
  maxSteps?: number, // maxSteps: 可选，覆盖默认的 MAX_STEPS 步数上限
  signal?: AbortSignal, // signal: 可选，外部中断信号，随时取消循环
  trace?: LocalTraceRecorder, // trace: 可选，本地 trace 记录器，落盘每步输入输出
) {
  let step = 0; // 当前步数（每轮模型调用 + 工具执行算一步）
  let totalTokens = 0; // 累计 token 消耗
  resetHistory(); // 清空循环检测历史，避免上一次会话的记录干扰本次判断
  const prefix = tag ? `  ${tag} ` : "";
  const stepLimit = maxSteps ?? MAX_STEPS;

  // 主循环：每轮 = 一次模型调用 + 若干工具执行
  while (step < stepLimit) {
    // 外部请求取消（如用户按 Ctrl+C），直接退出
    if (signal?.aborted) {
      if (tag) console.log(`${prefix}已取消`);
      break;
    }

    step++;

    if (tag) {
      console.log(`${prefix}Step ${step}/${stepLimit}`);
    } else {
      console.log(`\n--- Step ${step} ---`);
    }

    await trace?.recordStepStarted({ step, system, messages });

    // 本步的临时状态
    let hasToolCall = false; // 本步是否产生工具调用（决定循环是否继续）
    let fullText = ""; // 本步模型生成的完整文本
    let shouldBreak = false; // 循环检测触发 critical 时置 true，强制结束
    let lastToolCall: { name: string; input: unknown } | null = null; // 最近一次工具调用，用于给结果补录指纹
    let stepResponse: any; // 本步模型完整响应（含 messages）
    let stepUsage: any; // 本步 token 用量

    // 重试循环：可重试错误（网络抖动、5xx 等）最多重试 MAX_RETRIES 次
    for (let attempt = 1; ; attempt++) {
      try {
        // 手动循环而非 SDK 自动循环（stopWhen）：把每步控制权留在自己手里，才能在步间打日志、控预算、做循环检测、响应中断
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          providerOptions: { openai: { parallelToolCalls: true } }, // 允许模型一次返回多个工具调用
          onError: () => {}, // 流内错误统一交给外层 try/catch 处理
        });

        // 逐块消费流式事件：文本增量 / 工具调用 / 工具结果
        for await (const part of result.fullStream) {
          switch (part.type) {
            // 文本增量：流式打印到终端并累积
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            // 工具调用：记录调用信息，并做循环检测
            case "tool-call": {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              // 循环检测：同一工具反复调、参数相同或 A-B 交替，说明在兜圈子
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === "critical") {
                  // 严重级别：标记停止，不再给模型机会
                  shouldBreak = true;
                } else {
                  // 警告级别：不停止，但塞一条系统提醒引导模型换思路
                  messages.push({
                    role: "user" as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input); // 记入历史，供后续检测使用
              break;
            }

            // 工具结果：打印前 120 字符预览，并为最近一次调用补录结果指纹
            case "tool-result": {
              const output =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output);
              const preview =
                output.length > 120 ? output.slice(0, 120) + "..." : output;
              console.log(`  [结果: ${part.toolName}] ${preview}`);
              if (lastToolCall) {
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

        stepResponse = await result.response; // 流结束后取完整响应（含本步生成的消息）
        stepUsage = await result.usage; // 取本步 token 用量
        break; // 本步成功，跳出重试循环
      } catch (error) {
        await trace?.recordAttemptError(step, attempt, error);
        // 超过重试上限，或错误不可重试（如 4xx），抛给上层
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`,
        );
        await sleep(delay);
        // 重置本步状态，避免残留数据干扰重试
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    // 循环检测触发 critical：强制停止
    if (shouldBreak) {
      console.log("\n[循环检测触发，Agent 已停止]");
      break;
    }

    // 把本步生成的消息原地追加进 messages，作为下一步的输入，形成多步对话历史
    messages.push(...stepResponse!.messages);

    // 用量统计与预算控制
    const norm = normalizeUsage(stepUsage);
    await trace?.recordStepCompleted({
      step,
      text: fullText,
      outputMessages: stepResponse!.messages,
      usage: norm,
    })
    const stepRecord = tracker?.record(model?.modelId || "mock-model", norm);
    totalTokens +=
      norm.inputTokens +
      norm.outputTokens +
      norm.cacheReadTokens +
      norm.cacheWriteTokens;

    // cache 命中时打印一行状态，让缓存效果立刻可见
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

    // 接近预算（超过 90%）时打印警告
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

    // 本步没有工具调用：模型已给出最终文本回复，任务完成，退出循环
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 继续下一步...");
  }

  // 循环因步数上限退出（而非自然结束）时提示
  if (step >= stepLimit) {
    console.log("\n[达到最大步数]");
  }
}
