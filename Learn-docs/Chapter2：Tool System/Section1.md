# 一.Tool到底是什么？
## 1 三样东西
```bash
1 一段描述————告诉模型"这个工具干什么、什么时候该用"
2 一份参数 Schema——告诉模型"调用时需要传什么参数、什么类型"
3 一个执行函数——真正干活的代码
```
## 2 定义的工具接口长什么样子？
```typescript
//工具定义
interface ToolDefinition {
  name: string;               //工具名
  description: string;        // 给模型看的描述
  parameters: Record<string, unknown>;  // JSON Schema
  execute: (input: any) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean;  // 能否并行
  isReadOnly?: boolean;         // 是否只读
  maxResultChars?: number;      // 结果最大长度
}
```
前三个字段是模型需要的,后三个是Agent Loop需要的.
**模型只关心"怎么调",Agent Loop关心"怎么管"**

# 二.搭建ToolRegistry
ToolRegistry(工具注册表)做三件事：<br>
1 注册工具<br>
2 查找工具<br>
3 转化成AI SDK需要的格式<br>

```typescript
import { jsonSchema } from 'ai';//jsonSchema：把jsonSchema包装成AI SDK需要的输入参数格式

//定义并导出一个 TypeScript 接口，表示一个工具的结构。
export interface ToolDefinition {
  name: string; //工具名称
  description: string;//工具描述，通常会提供给模型，告诉模型这个工具的用途。
  parameters: Record<string, unknown>;//定义工具的参数 Schema。
  isConcurrencySafe?: boolean;//可选字段，表示这个工具是否可以并发执行。
  isReadOnly?: boolean;//可选字段，表示工具是否是只读操作。
  maxResultChars?: number;//可选字段，限制工具结果最多返回多少字符。
  execute: (input: any) => Promise<unknown>;//工具真正的执行函数。
}

const DEFAULT_MAX_RESULT_CHARS = 3000; //默认最大结果字符数，如果某个工具没有配置 maxResultChars，就默认最多返回 3000 个字符。

//定义并导出ToolRegistry类。
//这个类就是工具注册中心，负责管理所有工具。
export class ToolRegistry {
  /*
  1 创建一个私有Map，用于保存工具。结构大致是：Map<工具名称, 工具定义>
  2 例如:
  'getWeather' -> {
   name: 'getWeather',
   description: '查询天气',
   ...
   } 
  3 private 表示外部代码不能直接访问 tools。
  */
  private tools = new Map<string, ToolDefinition>();//结构：Map<工具名称, 工具定义>

  //注册工具的方法，一次可以传入多个工具
  register(...tools: ToolDefinition[]): void {
    //遍历传入的每一个工具
    for (const tool of tools) {
      this.tools.set(tool.name, tool);//按照工具名称，把工具存入 Map。
    }
  }

  //根据工具名称获取工具。
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);//从 Map 中查找指定名称的工具。
  }
  
  //获取所有已注册工具。返回一个工具数组。
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());//取出 Map 中所有的工具值，并转换成数组。
  }

  //内部的工具定义转成Vercel AI SDK需要的对象格式，同时在execute里包了一层截断逻辑
  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};//创建一个空对象，用于存储转换后的工具。工具名称会作为对象的键。

    //遍历Map
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;//读取工具配置的最大结果长度。
      const executeFn = tool.execute;//把原始执行函数保存到局部变量中。这样后面包装 execute 函数时，可以调用原始函数。
        //以工具名称为键，创建 AI SDK 工具定义。例如：result['getWeather'] = {...};
        result[name] = {                   
        description: tool.description,                  //把工具描述传给 AI SDK。模型会通过这个描述理解工具用途。
        inputSchema: jsonSchema(tool.parameters as any),//把工具参数 Schema 转换成 AI SDK 的 inputSchema。
        //定义 AI SDK 实际调用的执行函数。模型生成参数后，AI SDK 会把参数传入这里。
        execute: async (input: any) => {              
          //调用原始工具函数，并等待执行完成。
          const raw = await executeFn(input);         
          //把工具结果统一转换成字符串。
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2); 
          return truncateResult(text, maxChars);//截断结果，防止工具返回过长内容。
        },
      };
    }
    //结束工具遍历，并返回全部转换后的工具。
    return result;
  }
}

//定义并导出一个截断字符串的函数。
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;//如果文本长度没有超过限制，就直接返回原文本。

  const headSize = Math.floor(maxChars * 0.6);//保留前 60% 的空间。
  const tailSize = maxChars - headSize;       //剩余空间分配给文本末尾。
  const head = text.slice(0, headSize);       //截取文本开头的一部分。
  const tail = text.slice(-tailSize);         //截取文本末尾的一部分。
  const dropped = text.length - headSize - tailSize;//计算中间被省略了多少字符。

  /*
  * 拼接最终结果：
  * 开头内容
  * ... [省略 1200 字符] ...
  * 结尾内容
  */
  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}

```
## 整体调用示例
```typescript
import { allTools } from './tools.js';

const registry = new ToolRegistry();//1 创建一个 ToolRegistry 实例
registry.register(...allTools);     //2 把 allTools 中的所有工具注册到 registry 中。

const tools = registry.toAISDKFormat();//3 把注册中心里的所有工具转换成 AI SDK 可以使用的格式。

/*
转换后大致是：
{
  search: {
    description: '搜索信息',
    inputSchema: ...,
    execute: async (input) => {
      ...
    }
  },
  weather: {
    description: '查询天气',
    inputSchema: ...,
    execute: async (input) => {
      ...
    }
  }
}
*/
```
```text
allTools 数组
    ↓
创建 ToolRegistry
    ↓
注册所有工具
    ↓
转换成 AI SDK 格式
    ↓
传给模型使用
```

# 三.并发控制
```typescript
import { jsonSchema } from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false;          // 当前是否有独占锁持有者
  private concurrentCount = 0;            // 当前共享锁持有数
  private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}

```

# 四.做的事情
1 **ToolRegistry** 解耦了工具定义和使用——注册一次，Agent Loop 和 AI SDK 都能用。加新工具只需要写一个 ToolDefinition 对象，调一下 registry.register()，不用改 Agent Loop 的任何代码。<br>
2 **结果截断** 是上下文工程的第一道防线——不让单个工具的输出吃掉整个推理空间。Head/Tail 60/40 分割比简单截头更聪明，保留了文件两端的关键信息。<br>
3 **读写锁并发控制** 让只读工具并行跑、读写工具独占执行，Agent Loop 完全不需要感知并发细节。<br>