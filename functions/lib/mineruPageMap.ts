import type { PageMapItem } from './qwenPageMap';

interface ClassifierEnvironment {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export interface MinerUPageInput {
  page: number;
  text: string;
}

export async function classifyMinerUPageTexts(
  inputs: MinerUPageInput[],
  env: ClassifierEnvironment,
  signal?: AbortSignal
): Promise<PageMapItem[]> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('页面分类服务尚未完成配置');
  }
  const pages = inputs
    .filter(item => Number.isInteger(item.page) && item.page > 0)
    .slice(0, 12)
    .map(item => ({ page: item.page, text: String(item.text || '').slice(0, 8_000) }));
  if (!pages.length) throw new Error('没有可分类的 MinerU 页面文字');
  const prompt = `你是银行流水卷宗的页面导航分类器。下面是 MinerU 从原 PDF 逐页提取的结构化文字。只建立页面地图，不提取交易金额，不补写看不到的内容。

必须为第 ${pages.map(item => item.page).join('、')} 页各返回一项。pageType 只能是 TRANSACTIONS、ACCOUNT_LIST、ACCOUNT_INFO、INVESTIGATION_ORDER、BANK_REPLY、COVER、OTHER_DOCUMENT、BLANK、UNKNOWN。

判断要求：
- TRANSACTIONS 是有日期、金额、余额等逐笔记录的流水明细；ACCOUNT_LIST 是集中列出多个本方账号；ACCOUNT_INFO 是单一账户资料；INVESTIGATION_ORDER 是法院调查令；BANK_REPLY 是银行回函或查询结果说明。
- bankName、accountName、accountNumbers 只取本方账户栏明确出现的信息，不能把对手方、贷款账号、客户号、凭证号当成本方账号。
- documentBoundary 判断银行材料区间：新银行材料开始填 START；仍属前一银行填 CONTINUE；证据不足填 UNCERTAIN。同一银行内换账号或流水换页不是 START。
- confidence 为 0 到 1。OCR 文字为空或不足时必须降低 confidence，不得猜测。
- rotation 固定填 0；density 按流水行数填 LOW/MEDIUM/HIGH；documentLabel 优先填银行名称；investigationOrderNo 仅抄录明确编号。

页面文字：
${pages.map(item => `\n===== 原 PDF 第 ${item.page} 页 =====\n${item.text || '[未提取到文字]'}`).join('\n')}

严格输出 JSON：
{"pages":[{"page":1,"pageType":"TRANSACTIONS","rotation":0,"bankName":"中国工商银行","accountName":"","accountNumbers":[],"density":"HIGH","confidence":0.95,"documentBoundary":"CONTINUE","documentLabel":"中国工商银行","investigationOrderNo":""}]}`;

  const parsed = await withGemini(prompt, env, signal);
  const byPage = new Map<number, PageMapItem>();
  for (const item of Array.isArray(parsed?.pages) ? parsed.pages : []) {
    const page = Number(item?.page);
    if (!pages.some(input => input.page === page)) continue;
    byPage.set(page, normalizeItem(page, item));
  }
  return pages.map(input => byPage.get(input.page) || unknown(input.page));
}

async function withGemini(prompt: string, env: ClassifierEnvironment, signal?: AbortSignal): Promise<any> {
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json', temperature: 0, max_output_tokens: 4096 }
      })
    }
  );
  if (!response.ok) throw new Error(`MinerU 页面分类失败（${response.status}）`);
  const payload = await response.json() as any;
  const content = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('') || '';
  return parseJson(content);
}

function normalizeItem(page: number, item: any): PageMapItem {
  const pageTypeValue = text(item?.pageType).toUpperCase();
  const densityValue = text(item?.density).toUpperCase();
  const boundaryValue = text(item?.documentBoundary).toUpperCase();
  return {
    page,
    pageType: /^(TRANSACTIONS|ACCOUNT_LIST|ACCOUNT_INFO|INVESTIGATION_ORDER|BANK_REPLY|COVER|OTHER_DOCUMENT|DOCUMENT|BLANK|UNKNOWN)$/.test(pageTypeValue)
      ? pageTypeValue as PageMapItem['pageType'] : 'UNKNOWN',
    rotation: 0,
    bankName: text(item?.bankName),
    accountName: text(item?.accountName),
    accountNumbers: [...new Set<string>((Array.isArray(item?.accountNumbers) ? item.accountNumbers : [])
      .map((value: unknown) => text(value).replace(/[^0-9A-Za-z]/g, ''))
      .filter((value: string) => value.length >= 8))],
    density: /^(LOW|MEDIUM|HIGH)$/.test(densityValue) ? densityValue as PageMapItem['density'] : 'LOW',
    confidence: clamp(item?.confidence),
    documentBoundary: boundaryValue === 'START' || boundaryValue === 'CONTINUE' ? boundaryValue : 'UNCERTAIN',
    documentLabel: text(item?.documentLabel),
    investigationOrderNo: text(item?.investigationOrderNo)
  };
}

function unknown(page: number): PageMapItem {
  return {
    page, pageType: 'UNKNOWN', rotation: 0, bankName: '', accountName: '', accountNumbers: [], density: 'LOW',
    confidence: 0, documentBoundary: 'UNCERTAIN', documentLabel: '', investigationOrderNo: ''
  };
}

function parseJson(value: unknown): any {
  const content = text(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('MinerU 页面分类结果结构不完整');
  return JSON.parse(content.slice(start, end + 1));
}

function clamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}
