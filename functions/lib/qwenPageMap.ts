interface QwenEnvironment {
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_BASE_URL?: string;
  QWEN_MODEL?: string;
}

export type PageMapType = 'TRANSACTIONS' | 'ACCOUNT_INFO' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';

export interface PageMapItem {
  page: number;
  pageType: PageMapType;
  rotation: 0 | 90 | 180 | 270;
  bankName: string;
  accountName: string;
  accountNumbers: string[];
  density: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
}

export async function classifyBankPageSheet(
  file: File,
  pageNumbers: number[],
  env: QwenEnvironment,
  signal?: AbortSignal
): Promise<PageMapItem[]> {
  if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL) throw new Error('页面分类服务尚未完成配置');
  if (!file.type.startsWith('image/')) throw new Error('页面分类仅接收缩略图');
  const uniquePages = [...new Set(pageNumbers.filter(page => Number.isInteger(page) && page > 0))];
  if (!uniquePages.length || uniquePages.length > 12) throw new Error('页面分类批次范围无效');
  const dataUrl = `data:${file.type || 'image/jpeg'};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
  const prompt = `你是银行流水卷宗的页面导航分类器。图片是一张缩略图拼图，每格顶部有醒目的“原PDF第 N 页”标签。

只做页面地图，不提取交易明细和金额。必须为这些页各返回一项：${uniquePages.join('、')}。

判断：
- pageType: TRANSACTIONS（含交易明细表）、ACCOUNT_INFO（账户清单/开户资料/余额清单）、DOCUMENT（法院文书、回函、封面）、BLANK（真正空白）、UNKNOWN。
- rotation: 为了让正文正向阅读，原页面需要顺时针旋转的角度，只能是 0/90/180/270。
- bankName、accountName、accountNumbers：只填写页面抬头或本方账户栏明确可见的信息；绝不能把对手方、贷款账号、客户号、凭证号或辅助卡号当成本方账号。看不清留空。
- density: 交易表格行数观感，LOW/MEDIUM/HIGH；非交易页填 LOW。
- confidence: 0 到 1。缩略图不足以判断时用 UNKNOWN 或降低 confidence，不得猜测。

严格输出 JSON：
{"pages":[{"page":1,"pageType":"TRANSACTIONS","rotation":0,"bankName":"","accountName":"","accountNumbers":[],"density":"MEDIUM","confidence":0.95}]}`;
  const response = await fetch(`${env.DASHSCOPE_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.QWEN_MODEL || 'qwen3.8-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
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
  const parsed = parseJson(payload?.choices?.[0]?.message?.content);
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
      confidence: confidence(item?.confidence)
    });
  }
  return uniquePages.map(page => byPage.get(page) || {
    page, pageType: 'UNKNOWN', rotation: 0, bankName: '', accountName: '', accountNumbers: [], density: 'LOW', confidence: 0
  });
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
  return /^(TRANSACTIONS|ACCOUNT_INFO|DOCUMENT|BLANK|UNKNOWN)$/.test(normalized)
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
