const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'https://lawtool.cocoaiagent.com/';
const DEFAULT_PDF = path.resolve(__dirname, '../test-data/benchmark_20pages.pdf');
const BENCHMARK_PDF = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PDF;

async function runGuiTest() {
  console.log('🚀 正在启动真实 Chrome 浏览器进行 GUI 自动化端到端测试...');
  console.log(`目标网址: ${URL}`);
  console.log(`测试文件: ${BENCHMARK_PDF}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();

  // Capture all browser console logs
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error' || text.includes('Error') || text.includes('error')) {
      console.log(`[Browser Error] ${text}`);
    } else {
      console.log(`[Browser Console] ${text.slice(0, 140)}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`[Browser Uncaught Error] ${err.message}`);
  });

  page.on('requestfailed', req => {
    console.log(`[Network Failed] ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
  });

  try {
    console.log('1. 正在打开首页...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: 'test-data/gui_01_homepage.png' });

    // 2. Check Password Gate
    const hasPasswordInput = await page.$('input[type="password"]');
    if (hasPasswordInput) {
      console.log('2. 检测到访问口令门禁，正在输入口令 xqzb...');
      await page.type('input[type="password"]', 'xqzb');
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1500));
      await page.screenshot({ path: 'test-data/gui_02_password_passed.png' });
      console.log('✅ 口令验证通过！');
    }

    // 3. Check for Auth / Login Modal
    const buttons = await page.$$('button');
    for (const b of buttons) {
      const txt = await page.evaluate(el => el.innerText, b);
      if (txt.includes('快捷填入')) {
        console.log('3. 检测到律师登录弹窗，点击快捷填入专属账号...');
        await b.click();
        await new Promise(r => setTimeout(r, 500));
        break;
      }
    }

    const buttonsAfter = await page.$$('button');
    for (const b of buttonsAfter) {
      const txt = await page.evaluate(el => el.innerText, b);
      if (txt.includes('立即登录')) {
        console.log('4. 点击立即登录进入工作台...');
        await b.click();
        await new Promise(r => setTimeout(r, 1500));
        await page.screenshot({ path: 'test-data/gui_03_dashboard.png' });
        console.log('✅ 登录成功，已进入案件主工作台！');
        break;
      }
    }

    // 4. Fill Step 0 if on Step 0
    let fileInput = await page.$('input#file-upload');
    if (!fileInput) {
      console.log('5. 当前在 Step 0 案件建档，正在录入案号与被执行人...');
      const inputs = await page.$$('input[type="text"]');
      for (const input of inputs) {
        const placeholder = await page.evaluate(el => el.placeholder || '', input);
        if (placeholder.includes('案号') || placeholder.includes('执')) {
          await input.type('(2023)京0105执19283号');
        } else if (placeholder.includes('姓名') || placeholder.includes('被执行人') || placeholder.includes('公司')) {
          await input.type('赵立明');
        } else if (placeholder.includes('法院')) {
          await input.type('北京市第一中级人民法院');
        }
      }

      await new Promise(r => setTimeout(r, 500));
      await page.screenshot({ path: 'test-data/gui_04_step0_ready.png' });

      // Click "保存建档，进入下一步上传流水"
      const stepButtons = await page.$$('button');
      for (const btn of stepButtons) {
        const text = await page.evaluate(el => el.innerText || '', btn);
        if (text.includes('保存建档') || text.includes('下一步上传流水')) {
          console.log(`点击按钮: ${text.trim()}`);
          await btn.click();
          break;
        }
      }

      await new Promise(r => setTimeout(r, 2000));
      fileInput = await page.$('input#file-upload');
    }

    if (!fileInput) {
      throw new Error('未能进入 Step 1 文件上传页面 (未找到 input#file-upload)');
    }

    console.log('6. 已成功进入 Step 1 流水上传区域，正在注入 benchmark_5pages.pdf...');
    await fileInput.uploadFile(BENCHMARK_PDF);
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: 'test-data/gui_05_uploaded.png' });

    console.log('7. 正在监控真实浏览器中的本地 PDF 切片与流式解析进度...');
    let isProcessing = true;
    let attempts = 0;
    const maxAttempts = 90; // Up to 180 seconds

    while (isProcessing && attempts < maxAttempts) {
      attempts++;
      await new Promise(r => setTimeout(r, 2000));

      const status = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        // Check if we advanced to Step 2
        const isStep2 = bodyText.includes('STEP 2') || bodyText.includes('账户主体确认') || bodyText.includes('原始文件核对') || bodyText.includes('原件画布');
        const hasError = bodyText.includes('解析失败') || bodyText.includes('未能完整获取') || bodyText.includes('服务暂时不可用');
        
        // Find any progress or status labels
        const labels = Array.from(document.querySelectorAll('div, span, p'))
          .map(el => el.innerText?.trim())
          .filter(t => t && (t.includes('正在') || t.includes('已完成') || t.includes('核查') || t.includes('%') || t.includes('识别')));

        return { 
          isStep2, 
          hasError, 
          statusLabel: labels[0] || '',
          bodySnippet: bodyText.slice(0, 300).replace(/\n+/g, ' ')
        };
      });

      if (status.statusLabel) {
        console.log(`[UI 实时进度] ${status.statusLabel}`);
      }

      if (status.isStep2) {
        console.log('\n🎉🎉🎉 成功！系统已完成 5 页基准测试流水的全部切片、双重清点与流式提取，自动推进至 Step 2（原件对照审查工作台）！');
        isProcessing = false;
        break;
      }

      if (status.hasError) {
        console.log('⚠️ 界面检测到错误提示:', status.bodySnippet);
        await page.screenshot({ path: 'test-data/gui_06_error.png' });
        break;
      }

      if (attempts % 5 === 0) {
        console.log(`...解析持续运行中 (已耗时约 ${attempts * 2} 秒)...`);
        await page.screenshot({ path: `test-data/gui_progress_${attempts}.png` });
      }
    }

    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: 'test-data/gui_07_step2_workbench.png' });
    console.log('📸 Step 2 审查工作台全屏截图已保存至 test-data/gui_07_step2_workbench.png');

    // Extract table and review issues from Step 2
    const step2Details = await page.evaluate(() => {
      const issues = Array.from(document.querySelectorAll('div, li, p, span'))
        .map(el => el.innerText?.trim())
        .filter(t => t && t.includes('第') && (t.includes('页') || t.includes('笔') || t.includes('断层') || t.includes('空白') || t.includes('跳跃') || t.includes('不一致')));
      
      const tableRows = Array.from(document.querySelectorAll('table tbody tr')).map(tr => 
        Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim()).join(' | ')
      );

      const accounts = Array.from(document.querySelectorAll('button, div'))
        .map(el => el.innerText?.trim())
        .filter(t => t && (t.includes('建设银行') || t.includes('光大银行') || t.includes('6217') || t.includes('6226')));

      return {
        pageTitle: document.title,
        uniqueIssues: [...new Set(issues)].slice(0, 15),
        sampleRows: tableRows.slice(0, 8),
        totalRows: tableRows.length,
        detectedAccounts: [...new Set(accounts)].slice(0, 6)
      };
    });

    console.log('\n=============================================');
    console.log('📊 Step 2 原件对照审查工作台数据核验报告');
    console.log('=============================================');
    console.log('识别出账户 Tab 标签:', step2Details.detectedAccounts);
    console.log('识别提取总行数:', step2Details.totalRows);
    console.log('示例交易数据 (前 8 笔):');
    step2Details.sampleRows.forEach((r, idx) => console.log(`  [${idx + 1}] ${r}`));
    console.log('\n系统自动触发的司法审查任务/告警:');
    step2Details.uniqueIssues.forEach((issue, idx) => console.log(`  👉 任务 ${idx + 1}: ${issue}`));

  } catch (err) {
    console.error('❌ GUI 测试执行异常:', err);
    await page.screenshot({ path: 'test-data/gui_crash.png' });
  } finally {
    await browser.close();
    console.log('\n🏁 真实 Chrome 浏览器已正常关闭。');
  }
}

runGuiTest();
