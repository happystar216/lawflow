const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.resolve(__dirname, '../tmp/user-profile');
const URL = 'https://lawtool.cocoaiagent.com/';

async function inspectUserSession() {
  console.log('🚀 正在挂载用户本地 Chrome 会话与 IndexedDB 历史案件数据...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  page.on('console', msg => console.log(`[Browser] ${msg.text().slice(0, 160)}`));

  try {
    console.log('1. 正在加载用户当前页面...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: 'test-data/user_session_screen.png' });

    // Inspect IndexedDB cases
    const dbData = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const req = indexedDB.open('LawFlow_Cases_DB_v2', 1);
        req.onerror = () => resolve({ error: '无法打开数据库' });
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('cases')) {
            resolve({ error: '未找到 cases 表' });
            return;
          }
          const tx = db.transaction('cases', 'readonly');
          const store = tx.objectStore('cases');
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const cases = getAll.result || [];
            resolve({
              casesCount: cases.length,
              casesSummary: cases.map(c => ({
                id: c.metadata?.id,
                respondent: c.metadata?.respondentName,
                caseNumber: c.metadata?.caseNumber,
                accountsCount: c.accounts?.length,
                accounts: c.accounts?.map((a) => ({
                  bankName: a.bankName,
                  accountNumber: a.accountNumber,
                  accountName: a.accountName,
                  transactionCount: a.transactionCount,
                  totalIn: a.totalIn,
                  totalOut: a.totalOut,
                  isBalanced: a.isBalanced,
                  balanceDiff: a.balanceDiff,
                  warnings: a.parseWarnings || []
                })),
                transactionsCount: c.transactions?.length,
                updatedAt: c.updatedAt
              }))
            });
          };
          getAll.onerror = () => resolve({ error: '读取 cases 失败' });
        };
      });
    });

    console.log('\n--- 用户本地数据库中的案件数据 ---');
    console.log(JSON.stringify(dbData, null, 2));

    // Also inspect current DOM state
    const domState = await page.evaluate(() => {
      return {
        title: document.title,
        bodyText: document.body.innerText.slice(0, 1500)
      };
    });

    console.log('\n--- 页面当前渲染状态 ---');
    console.log(domState.bodyText);

  } catch (err) {
    console.error('❌ 读取用户会话失败:', err);
  } finally {
    await browser.close();
    console.log('🏁 完成会话数据读取。');
  }
}

inspectUserSession();
