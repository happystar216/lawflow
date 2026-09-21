interface QwenEnvironment {
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_BASE_URL?: string;
  QWEN_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export type PageMapType =
  | 'TRANSACTIONS'
  | 'ACCOUNT_LIST'
  | 'ACCOUNT_INFO'
  | 'INVESTIGATION_ORDER'
  | 'BANK_REPLY'
  | 'COVER'
  | 'OTHER_DOCUMENT'
  | 'DOCUMENT'
  | 'BLANK'
  | 'UNKNOWN';

export interface PageMapItem {
  page: number;
  pageType: PageMapType;
  rotation: 0 | 90 | 180 | 270;
  bankName: string;
  accountName: string;
  accountNumbers: string[];
  density: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  documentBoundary: 'START' | 'CONTINUE' | 'UNCERTAIN';
  documentLabel: string;
  investigationOrderNo: string;
}

export async function classifyBankPageSheet(
  file: File,
  pageNumbers: number[],
  env: QwenEnvironment,
  signal?: AbortSignal
): Promise<PageMapItem[]> {
  if (!env.GEMINI_API_KEY && (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL)) {
    throw new Error('页面分类服务尚未完成配置');
  }
  if (!file.type.startsWith('image/')) throw new Error('页面分类仅接收缩略图');
  const uniquePages = [...new Set(pageNumbers.filter(page => Number.isInteger(page) && page > 0))];
  if (!uniquePages.length || uniquePages.length > 12) throw new Error('页面分类批次范围无效');
  const mimeType = file.type || 'image/jpeg';
  const base64Data = arrayBufferToBase64(await file.arrayBuffer());
  const prompt = `你是银行流水卷宗的页面导航分类器。图片是一张缩略图拼图，每格顶部有醒目的“原PDF第 N 页”标签。

只做页面地图，不提取交易明细和金额。必须为这些页各返回一项：${uniquePages.join('、')}。

判断：
- pageType 必须逐页选择最具体的一类：
  - TRANSACTIONS：有日期、金额等逐笔记录的交易流水明细；
  - ACCOUNT_LIST：集中列出一个或多个账号/卡号的账户清单、查询账户列表；
  - ACCOUNT_INFO：单一账户的开户资料、余额资料、账户基本信息；
  - INVESTIGATION_ORDER：法院调查令、协助调查通知等司法调查文书；
  - BANK_REPLY：银行回函、查询结果说明、无明细说明；
  - COVER：封面、目录、分隔页；
  - OTHER_DOCUMENT：说明页、授权材料或其他非流水资料；
  - BLANK：真正空白页；
  - UNKNOWN：缩略图无法可靠判断。
  兼容旧值 DOCUMENT，但能判断时不要使用笼统的 DOCUMENT。
- rotation: 为了让正文正向阅读，原页面需要顺时针旋转的角度，只能是 0/90/180/270。
- bankName、accountName、accountNumbers：只填写页面抬头或本方账户栏明确可见的信息；绝不能把对手方、贷款账号、客户号、凭证号或辅助卡号当成本方账号。看不清留空。
- density: 交易表格行数观感，LOW/MEDIUM/HIGH；非交易页填 LOW。
- confidence: 0 到 1。缩略图不足以判断时用 UNKNOWN 或降低 confidence，不得猜测。
- documentBoundary：直接判断该页在卷宗中的银行材料区间。
  - START：该页明确是下一个银行材料区间的起始页。证据可以是银行抬头发生切换、新银行回函首页、新银行对应的调查令首页，或第一张明确属于新银行的账户/流水页；
  - CONTINUE：该页仍属于前面已经开始的同一银行材料区间；
  - UNCERTAIN：缩略图不足以判断。不要因为普通流水换页、账号变化或同一回函续页而误报 START。
  拼图中的第一格只是本次扫描批次的第一格，不代表原 PDF 或银行材料区间从这里开始，绝不能因此标为 START。
- investigationOrderNo：只抄录本页明确可见的调查令编号，看不清留空。
- documentLabel：给这一银行材料区间的简短名称，优先使用银行名称；调查令编号明确可见时可作为辅助说明。只能依据当前拼图中可见证据填写，看不清留空。
- 分档的第一优先级是银行切换。同一银行内部出现调查令、账户清单、多个账号和流水续页时都保持 CONTINUE；只有进入下一个银行的材料时才标记 START。

严格输出 JSON：
{"pages":[{"page":1,"pageType":"TRANSACTIONS","rotation":0,"bankName":"中国光大银行","accountName":"","accountNumbers":[],"density":"MEDIUM","confidence":0.95,"documentBoundary":"CONTINUE","documentLabel":"中国光大银行","investigationOrderNo":"285号之十二"}]}`;
  let parsed: any;
  let firstError: unknown;
  if (env.GEMINI_API_KEY) {
    try {
      parsed = await classifyWithGemini(prompt, mimeType, base64Data, env, signal);
    } catch (error) {
      firstError = error;
    }
  }
  if (!parsed && env.DASHSCOPE_API_KEY && env.DASHSCOPE_BASE_URL) {
    try {
      parsed = await classifyWithQwen(prompt, mimeType, base64Data, env, signal);
    } catch (error) {
      throw new Error(`页面分类服务均未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!parsed) throw firstError instanceof Error ? firstError : new Error('页面分类服务未返回结果');
  const rawPages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  const byPage = new Map<number, PageMapItem>();
  for (const item of rawPages) {
    const page = Number(item?.page);
    if (!uniquePages.includes(page)) continue;
    byPage.set(page, {
      page,
      pageType: pageType(item?.pageType),
      rotation: rotation(item?.rotation),
      bankName: text(item?.bankName),
      accountName: text(item?.accountName),
      accountNumbers: [...new Set<string>((Array.isArray(item?.accountNumbers) ? item.accountNumbers : [])
        .map((value: unknown) => text(value).replace(/[^0-9A-Za-z]/g, ''))
        .filter((value: string) => value.length >= 8))],
      density: /^(LOW|MEDIUM|HIGH)$/.test(text(item?.density).toUpperCase())
        ? text(item?.density).toUpperCase() as PageMapItem['density'] : 'LOW',
      confidence: confidence(item?.confidence),
      documentBoundary: documentBoundary(item?.documentBoundary),
      documentLabel: text(item?.documentLabel),
      investigationOrderNo: text(item?.investigationOrderNo)
    });
  }
  return uniquePages.map(page => byPage.get(page) || {
    page, pageType: 'UNKNOWN', rotation: 0, bankName: '', accountName: '', accountNumbers: [], density: 'LOW', confidence: 0,
    documentBoundary: 'UNCERTAIN', documentLabel: '', investigationOrderNo: ''
  });
}

async function classifyWithQwen(
  prompt: string,
  mimeType: string,
  base64Data: string,
  env: QwenEnvironment,
  signal?: AbortSignal
): Promise<any> {
  const response = await fetch(`${env.DASHSCOPE_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.QWEN_MODEL || 'qwen3.8-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
      ] }],
      stream: false,
      response_format: { type: 'json_object' },
      enable_thinking: false,
      temperature: 0,
      max_tokens: 2048
    })
  });
  if (!response.ok) throw new Error(`页面分类服务请求失败（${response.status}）`);
  const payload = await response.json() as any;
  return parseJson(payload?.choices?.[0]?.message?.content);
}

async function classifyWithGemini(
  prompt: string,
  mimeType: string,
  base64Data: string,
  env: QwenEnvironment,
  signal?: AbortSignal
): Promise<any> {
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0,
          max_output_tokens: 4096
        }
      })
    }
  );
  if (!response.ok) throw new Error(`页面分类服务请求失败（${response.status}）`);
  const payload = await response.json() as any;
  const content = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
  return parseJson(content);
}

function parseJson(value: unknown): any {
  const content = text(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('页面分类结果结构不完整');
  return JSON.parse(content.slice(start, end + 1));
}

function pageType(value: unknown): PageMapType {
  const normalized = text(value).toUpperCase();
  return /^(TRANSACTIONS|ACCOUNT_LIST|ACCOUNT_INFO|INVESTIGATION_ORDER|BANK_REPLY|COVER|OTHER_DOCUMENT|DOCUMENT|BLANK|UNKNOWN)$/.test(normalized)
    ? normalized as PageMapType : 'UNKNOWN';
}

function rotation(value: unknown): 0 | 90 | 180 | 270 {
  const parsed = Number(value);
  return parsed === 90 || parsed === 180 || parsed === 270 ? parsed : 0;
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function documentBoundary(value: unknown): PageMapItem['documentBoundary'] {
  const normalized = text(value).toUpperCase();
  return normalized === 'START' || normalized === 'CONTINUE' ? normalized : 'UNCERTAIN';
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
