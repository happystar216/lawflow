const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.resolve(__dirname, '../tmp/user-profile');
const URL = 'https://lawtool.cocoaiagent.com/';

async function inspectLiveGui() {
  console.log('🚀 正在启动真实 Chrome GUI 视窗查看用户实际上传后的界面...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: 'new',
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Capture initial Step 4 (or current screen)
    await page.screenshot({ path: 'test-data/gui_live_step4_full.png', fullPage: true });
    console.log('📸 当前页面完整截图已保存至: test-data/gui_live_step4_full.png');

    // Extract on-screen metrics
    const metrics = await page.evaluate(() => {
      const stats = Array.from(document.querySelectorAll('.font-bold, .font-mono, h2, h3, p, span'))
        .map(el => el.innerText?.trim())
        .filter(t => t && (t.includes('¥') || t.includes('%') || t.includes('对冲') || t.includes('涉嫌') || t.includes('命中') || t.includes('覆盖率')));
      
      const anomalyCards = Array.from(document.querySelectorAll('.bg-slate-50, .border-slate-200')).map(el => el.innerText.trim()).filter(t => t.includes('L0') || t.includes('L1') || t.includes('L2'));

      return {
        stats: [...new Set(stats)].slice(0, 15),
        anomalyCards: [...new Set(anomalyCards)].slice(0, 8),
        bodySnippet: document.body.innerText.slice(0, 1200)
      };
    });

    console.log('\n--- 界面核心指标与研判结论 ---');
    console.log(metrics.stats);
    console.log('\n--- 命中的异常特征证据项 ---');
    console.log(metrics.anomalyCards);

    // Now click '证据确认' in stepper to inspect Step 2 (Review Workstation)
    const stepperButtons = await page.$$('button, div, span');
    for (const el of stepperButtons) {
      const txt = await page.evaluate(e => e.innerText || '', el);
      if (txt.includes('证据确认') && txt.includes('平账审计')) {
        console.log('\n2. 正在点击导航栏进入【Step 2 证据确认工作台】...');
        await el.click();
        await new Promise(r => setTimeout(r, 2500));
        await page.screenshot({ path: 'test-data/gui_live_step2_full.png', fullPage: true });
        console.log('📸 Step 2 审查工作台截图已保存至: test-data/gui_live_step2_full.png');

        const step2Info = await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t.includes('银行') || t.includes('待核对'));
          const issues = Array.from(document.querySelectorAll('div, li, p')).map(e => e.innerText.trim()).filter(t => t.includes('第') && (t.includes('页') || t.includes('笔') || t.includes('失败') || t.includes('断层')));
          return {
            tabs: [...new Set(tabs)],
            issuesCount: issues.length,
            issuesSample: [...new Set(issues)].slice(0, 15)
          };
        });

        console.log('Step 2 账户 Tab 列表:', step2Info.tabs);
        console.log('Step 2 审查任务数:', step2Info.issuesCount);
        console.log('Step 2 审查任务预览:', step2Info.issuesSample);
        break;
      }
    }

  } catch (err) {
    console.error('❌ GUI 查看异常:', err);
  } finally {
    await browser.close();
    console.log('\n🏁 浏览器会话已完成。');
  }
}

inspectLiveGui();
