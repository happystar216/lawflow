import os
import math
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# 1. Register Chinese Font
FONT_PATH = '/System/Library/Fonts/STHeiti Light.ttc'
if not os.path.exists(FONT_PATH):
    FONT_PATH = '/System/Library/Fonts/Supplemental/Songti.ttc'

pdfmetrics.registerFont(TTFont('ChineseFont', FONT_PATH, subfontIndex=0))

OUTPUT_PATH = 'test-data/benchmark_5pages.pdf'
os.makedirs('test-data', exist_ok=True)

def draw_header(c, width, height, bank_title, account_name, account_num, bank_branch, period, page_num):
    c.setFont('ChineseFont', 15)
    c.setFillColor(colors.HexColor('#1a365d'))
    c.drawCentredString(width / 2.0, height - 38, bank_title)
    
    c.setFont('ChineseFont', 8.5)
    c.setFillColor(colors.HexColor('#4a5568'))
    c.drawString(40, height - 58, f"户名：{account_name}")
    c.drawString(200, height - 58, f"账号：{account_num}")
    c.drawString(420, height - 58, f"币种：人民币 (CNY)")
    c.drawString(550, height - 58, f"开户机构：{bank_branch}")
    
    c.drawString(40, height - 72, f"查询期间：{period}")
    c.drawString(420, height - 72, f"钞汇标志：钞户")
    c.drawRightString(width - 40, height - 72, f"第 {page_num} 页 / 共 5 页")
    
    # Divider line
    c.setStrokeColor(colors.HexColor('#2b6cb0'))
    c.setLineWidth(1.2)
    c.line(40, height - 78, width - 40, height - 78)

def draw_table_headers(c, y, col_widths, headers):
    c.setFillColor(colors.HexColor('#ebf8ff'))
    c.rect(40, y - 18, sum(col_widths), 22, fill=1, stroke=0)
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.setLineWidth(0.6)
    c.line(40, y - 18, 40 + sum(col_widths), y - 18)
    c.line(40, y + 4, 40 + sum(col_widths), y + 4)
    
    c.setFont('ChineseFont', 8.5)
    c.setFillColor(colors.HexColor('#2d3748'))
    x = 40
    for header, w in zip(headers, col_widths):
        c.drawString(x + 4, y - 11, header)
        x += w

def draw_red_seal(c, x, y, title="某某市中级人民法院", sub="执行局调证专用章"):
    """Draw a semi-transparent red judicial seal stamp over rows"""
    c.saveState()
    c.translate(x, y)
    
    seal_color = colors.Color(0.88, 0.15, 0.15, alpha=0.55)
    c.setStrokeColor(seal_color)
    c.setFillColor(seal_color)
    c.setLineWidth(1.8)
    
    # Outer circle
    c.circle(0, 0, 48, stroke=1, fill=0)
    c.setLineWidth(0.8)
    c.circle(0, 0, 44, stroke=1, fill=0)
    
    # Center five-pointed star
    c.setFont('ChineseFont', 16)
    c.drawCentredString(0, -6, "★")
    
    # Circular text around top
    c.setFont('ChineseFont', 7.5)
    c.drawCentredString(0, 24, title)
    c.setFont('ChineseFont', 7)
    c.drawCentredString(0, -28, sub)
    c.drawCentredString(0, -38, "2023.10.15")
    
    c.restoreState()

def create_benchmark_pdf():
    # Landscape A4 for wide bank statements
    c = canvas.Canvas(OUTPUT_PATH, pagesize=landscape(A4))
    width, height = landscape(A4)
    
    cols = [75, 45, 65, 65, 145, 135, 180, 50]
    headers = ["交易时间", "方向", "交易金额", "账户余额", "交易对手方名称", "对手方账号/开户行", "交易摘要/用途", "渠道"]
    
    # ==========================================
    # PAGE 1: 标准首页 + 正常平账流水 (Baseline Chronological Balance)
    # ==========================================
    draw_header(c, width, height, "中国建设银行 客户交易结算清单 (对账单)", "赵立明", "6217 0001 0028 8391 028", "北京朝阳支行", "2023-01-01 至 2023-12-31", 1)
    y = height - 90
    draw_table_headers(c, y, cols, headers)
    
    p1_rows = [
        ("2023-01-05 10:22:15", "转入", "50,000.00", "50,000.00", "北京华阳商贸发展有限公司", "110010293847561/工行", "货款结算及预付定金", "网银"),
        ("2023-01-12 14:02:11", "转出", "12,500.00", "37,500.00", "钱志国", "6222020200192837192/建行", "往来还款(借款结清)", "手机银行"),
        ("2023-01-20 09:30:00", "转出", "5,000.00", "32,500.00", "国网北京市电力公司", "010092837461524/农行", "电费代扣缴费", "批量代扣"),
        ("2023-02-05 11:15:30", "转入", "20,000.00", "52,500.00", "赵立明 (本方跨行)", "6226721003232085/光大", "同名账户资金调拨", "网上跨行"),
        ("2023-02-18 16:40:22", "转出", "8,200.00", "44,300.00", "北京中汽丰田汽车销售有限公司", "110293847561029/招行", "车辆定金与保养服务费", "POS机"),
        ("2023-03-21 00:00:00", "转入", "38.50", "44,338.50", "结息", "--/内部账户", "活期存款结息", "系统自动"),
        ("2023-03-28 15:20:10", "转出", "4,338.50", "40,000.00", "李某某", "6214830192837461/招商", "咨询费与劳务报酬", "手机银行"),
    ]
    
    y -= 35
    for r in p1_rows:
        c.setFont('ChineseFont', 8)
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + 4, y, r[0])
        
        # Color direction
        c.setFillColor(colors.HexColor('#276749') if r[1] == '转入' else colors.HexColor('#c53030'))
        c.drawString(40 + cols[0] + 4, y, r[1])
        
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + sum(cols[:2]) + 4, y, r[2])
        c.drawString(40 + sum(cols[:3]) + 4, y, r[3])
        c.drawString(40 + sum(cols[:4]) + 4, y, r[4])
        c.drawString(40 + sum(cols[:5]) + 4, y, r[5])
        c.drawString(40 + sum(cols[:6]) + 4, y, r[6])
        c.drawString(40 + sum(cols[:7]) + 4, y, r[7])
        
        c.setStrokeColor(colors.HexColor('#edf2f7'))
        c.line(40, y - 5, 40 + sum(cols), y - 5)
        y -= 22
        
    c.setFont('ChineseFont', 7.5)
    c.setFillColor(colors.HexColor('#a0aec0'))
    c.drawString(40, 25, "温馨提示：本清单仅供参考，不作为司法审计唯一证明，真实发生以银行会计系统底册为准。")
    c.showPage()
    
    # ==========================================
    # PAGE 2: 司法印章遮挡 + 跨行长摘要 + 敏感转移资产线索
    # ==========================================
    draw_header(c, width, height, "中国建设银行 客户交易结算清单 (对账单)", "赵立明", "6217 0001 0028 8391 028", "北京朝阳支行", "2023-01-01 至 2023-12-31", 2)
    y = height - 90
    draw_table_headers(c, y, cols, headers)
    
    p2_rows = [
        ("2023-04-02 10:10:00", "转入", "150,000.00", "190,000.00", "中铁十六局集团第三工程有限公司", "110928374615201/建行", "工程分包劳务进度结算款（第三期进度款核定）", "网银电汇"),
        ("2023-04-10 14:25:30", "转出", "100,000.00", "90,000.00", "泰康人寿保险股份有限公司北京分公司", "110091827364519/工行", "个人终身寿险及年金理财大额保费划扣（保单号：TK98172648192736）跨行多文本展示", "自动代扣"),
        ("2023-04-12 21:45:10", "转出", "20,000.00", "70,000.00", "ATM取现", "--/自助设备", "ATM大额夜间现金支取（无交易对手方名称）", "ATM取现"),
        ("2023-04-15 08:30:19", "转出", "50,000.00", "20,000.00", "北京顺天通房地产经纪有限公司", "110928374618293/中行", "购房订金/车位转让意向金（被执行人资金转移嫌疑）", "手机转账"),
        ("2023-04-22 13:12:00", "转入", "5,000.00", "25,000.00", "张小丽", "6222839102938475/农行", "还上月欠款及个人借款", "手机银行"),
        ("2023-04-28 17:50:00", "转出", "15,000.00", "10,000.00", "北京某某典当有限责任公司", "110928374619283/北京银行", "借款利息及质押手续费", "网银"),
    ]
    
    y -= 35
    for r in p2_rows:
        c.setFont('ChineseFont', 8)
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + 4, y, r[0])
        
        c.setFillColor(colors.HexColor('#276749') if r[1] == '转入' else colors.HexColor('#c53030'))
        c.drawString(40 + cols[0] + 4, y, r[1])
        
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + sum(cols[:2]) + 4, y, r[2])
        c.drawString(40 + sum(cols[:3]) + 4, y, r[3])
        c.drawString(40 + sum(cols[:4]) + 4, y, r[4])
        c.drawString(40 + sum(cols[:5]) + 4, y, r[5])
        
        # Multiline summary
        summary_text = r[6]
        if len(summary_text) > 16:
            c.drawString(40 + sum(cols[:6]) + 4, y + 3, summary_text[:16])
            c.drawString(40 + sum(cols[:6]) + 4, y - 7, summary_text[16:])
        else:
            c.drawString(40 + sum(cols[:6]) + 4, y, summary_text)
            
        c.drawString(40 + sum(cols[:7]) + 4, y, r[7])
        
        c.setStrokeColor(colors.HexColor('#edf2f7'))
        c.line(40, y - 10, 40 + sum(cols), y - 10)
        y -= 26

    # Draw Judicial Seal obstructing lines 2 and 3!
    draw_red_seal(c, width - 260, height - 170, "北京市第三中级人民法院", "执行实施庭调证专用章")
    c.showPage()
    
    # ==========================================
    # PAGE 3: 续页无表头 + 故意制造一笔余额跳跃/断层 (Balance Discontinuity Edge Case)
    # ==========================================
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "建设银行流水账单 · 续页（无顶栏抬头）")
    c.drawRightString(width - 40, height - 35, "第 3 页 / 共 5 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    
    # Notice: Page 2 ended with balance 10,000.00
    # Row 1: 10,000 + 40,000 = 50,000.00 (Normal)
    # Row 2: 50,000 - 10,000 = 40,000.00 (Normal)
    # Row 3: Drops to 15,000.00 with transaction 5,000.00! (Simulates missed row/jump!)
    p3_rows = [
        ("2023-05-02 09:12:00", "转入", "40,000.00", "50,000.00", "孙小燕 (配偶)", "6217000192837461/建行", "家属汇款转入", "手机银行"),
        ("2023-05-10 11:30:15", "转出", "10,000.00", "40,000.00", "北京东方家园建材超市", "110928374615201/农行", "房屋装修材料款", "POS刷卡"),
        ("2023-05-25 15:40:00", "转出", "5,000.00", "15,000.00", "某某汽车租赁有限公司", "110928374619283/工行", "商务租车押金（注：此处发生余额跳跃断层）", "网银"),
        ("2023-06-01 10:00:00", "转入", "20,000.00", "35,000.00", "北京某某商贸有限责任公司", "110010293847561/工行", "补充预付款", "网银"),
        ("2023-06-18 14:20:00", "转出", "34,000.00", "1,000.00", "赵立明 (提现)", "--/现金柜台", "柜面大额现金结清提取", "柜面业务"),
    ]
    
    y -= 35
    for r in p3_rows:
        c.setFont('ChineseFont', 8)
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + 4, y, r[0])
        
        c.setFillColor(colors.HexColor('#276749') if r[1] == '转入' else colors.HexColor('#c53030'))
        c.drawString(40 + cols[0] + 4, y, r[1])
        
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + sum(cols[:2]) + 4, y, r[2])
        c.drawString(40 + sum(cols[:3]) + 4, y, r[3])
        c.drawString(40 + sum(cols[:4]) + 4, y, r[4])
        c.drawString(40 + sum(cols[:5]) + 4, y, r[5])
        c.drawString(40 + sum(cols[:6]) + 4, y, r[6])
        c.drawString(40 + sum(cols[:7]) + 4, y, r[7])
        
        c.setStrokeColor(colors.HexColor('#edf2f7'))
        c.line(40, y - 5, 40 + sum(cols), y - 5)
        y -= 22
        
    c.showPage()
    
    # ==========================================
    # PAGE 4: 常见复印机反面 / 空白页 (Blank Page / Photocopy Back)
    # ==========================================
    c.setFont('ChineseFont', 8)
    c.setFillColor(colors.HexColor('#a0aec0'))
    c.drawCentredString(width / 2.0, height / 2.0 + 10, "【 本 页 无 交 易 正 文 · 复 印 留 白 备 查 页 】")
    c.drawCentredString(width / 2.0, height / 2.0 - 10, "--- BLANK PAGE FOR DOUBLE-SIDED PHOTOCOPY ---")
    c.drawRightString(width - 40, 25, "第 4 页 / 共 5 页")
    c.showPage()
    
    # ==========================================
    # PAGE 5: 第二个账户 / 多账户同卷切换 (Multi-Account in Same File)
    # ==========================================
    draw_header(c, width, height, "中国光大银行 个人活期账户对账单 (同名二类卡)", "赵立明", "6226 7210 0323 2085", "光大银行北京西城支行", "2023-01-01 至 2023-12-31", 5)
    y = height - 90
    draw_table_headers(c, y, cols, headers)
    
    p5_rows = [
        ("2023-07-01 10:00:00", "转入", "100,000.00", "100,000.00", "霍尔果斯某某影视文化合伙企业", "120092837461928/浦发", "投资收益及项目股权分红", "网银跨行"),
        ("2023-07-02 11:20:00", "转出", "99,900.00", "100.00", "赵立明 (建行卡)", "6217000100288391028/建行", "个人资金调拨划转(两卡内部互转)", "网银转账"),
        ("2023-08-15 09:00:00", "转出", "10.00", "90.00", "光大银行", "--/内部收费", "小额账户管理年费扣收", "系统自动"),
        ("2023-12-31 16:30:00", "转出", "90.00", "0.00", "柜面结清注销", "--/网点柜面", "个人借记卡账户结清注销销户", "柜面结清"),
    ]
    
    y -= 35
    for r in p5_rows:
        c.setFont('ChineseFont', 8)
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + 4, y, r[0])
        
        c.setFillColor(colors.HexColor('#276749') if r[1] == '转入' else colors.HexColor('#c53030'))
        c.drawString(40 + cols[0] + 4, y, r[1])
        
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + sum(cols[:2]) + 4, y, r[2])
        c.drawString(40 + sum(cols[:3]) + 4, y, r[3])
        c.drawString(40 + sum(cols[:4]) + 4, y, r[4])
        c.drawString(40 + sum(cols[:5]) + 4, y, r[5])
        c.drawString(40 + sum(cols[:6]) + 4, y, r[6])
        c.drawString(40 + sum(cols[:7]) + 4, y, r[7])
        
        c.setStrokeColor(colors.HexColor('#edf2f7'))
        c.line(40, y - 5, 40 + sum(cols), y - 5)
        y -= 22

    # Footer note
    c.setFont('ChineseFont', 8)
    c.setFillColor(colors.HexColor('#4a5568'))
    c.drawString(40, 45, "=== 本报告全部打印完毕，共 5 页 3 个账页，打印员工号：98102，防伪码：CEB-2023-8FA91B ===")
    c.drawRightString(width - 40, 25, "第 5 页 / 共 5 页")
    
    c.showPage()
    c.save()
    print(f"SUCCESS: {OUTPUT_PATH}")

if __name__ == '__main__':
    create_benchmark_pdf()
