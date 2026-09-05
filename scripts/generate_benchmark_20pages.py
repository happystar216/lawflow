import os
import math
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Register Chinese Font
FONT_PATH = '/System/Library/Fonts/STHeiti Light.ttc'
if not os.path.exists(FONT_PATH):
    FONT_PATH = '/System/Library/Fonts/Supplemental/Songti.ttc'

pdfmetrics.registerFont(TTFont('ChineseFont', FONT_PATH, subfontIndex=0))

OUTPUT_PATH = 'test-data/benchmark_20pages.pdf'
os.makedirs('test-data', exist_ok=True)

def draw_header(c, width, height, bank_title, account_name, account_num, bank_branch, period, page_num, total_pages=20):
    c.setFont('ChineseFont', 14)
    c.setFillColor(colors.HexColor('#1a365d'))
    c.drawCentredString(width / 2.0, height - 36, bank_title)
    
    c.setFont('ChineseFont', 8.5)
    c.setFillColor(colors.HexColor('#4a5568'))
    c.drawString(40, height - 54, f"户名：{account_name}")
    c.drawString(210, height - 54, f"账号：{account_num}")
    c.drawString(430, height - 54, f"币种：人民币 (CNY)")
    c.drawString(560, height - 54, f"开户机构：{bank_branch}")
    
    c.drawString(40, height - 68, f"查询期间：{period}")
    c.drawString(430, height - 68, f"业务类型：借记卡活期")
    c.drawRightString(width - 40, height - 68, f"第 {page_num} 页 / 共 {total_pages} 页")
    
    c.setStrokeColor(colors.HexColor('#2b6cb0'))
    c.setLineWidth(1.2)
    c.line(40, height - 74, width - 40, height - 74)

def draw_table_headers(c, y, col_widths, headers):
    c.setFillColor(colors.HexColor('#edf2f7'))
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

def draw_red_seal(c, x, y, title="某某市中级人民法院", sub="执行实施庭调证专用章", date_str="2023.11.20"):
    c.saveState()
    c.translate(x, y)
    
    seal_color = colors.Color(0.86, 0.12, 0.12, alpha=0.55)
    c.setStrokeColor(seal_color)
    c.setFillColor(seal_color)
    c.setLineWidth(1.8)
    
    c.circle(0, 0, 46, stroke=1, fill=0)
    c.setLineWidth(0.8)
    c.circle(0, 0, 42, stroke=1, fill=0)
    
    c.setFont('ChineseFont', 15)
    c.drawCentredString(0, -5, "★")
    
    c.setFont('ChineseFont', 7.5)
    c.drawCentredString(0, 23, title)
    c.setFont('ChineseFont', 7)
    c.drawCentredString(0, -26, sub)
    c.drawCentredString(0, -36, date_str)
    
    c.restoreState()

def draw_blank_page(c, width, height, page_num, total_pages=20):
    c.setFont('ChineseFont', 8.5)
    c.setFillColor(colors.HexColor('#a0aec0'))
    c.drawCentredString(width / 2.0, height / 2.0 + 12, "【 本 页 无 交 易 正 文 · 案 卷 双 面 复 印 留 白 页 】")
    c.drawCentredString(width / 2.0, height / 2.0 - 12, "--- OFFICIAL ARCHIVE BLANK PHOTOCOPY BACKSIDE ---")
    c.drawRightString(width - 40, 25, f"第 {page_num} 页 / 共 {total_pages} 页")
    c.showPage()

def draw_rows(c, y, cols, rows, line_height=22):
    for r in rows:
        c.setFont('ChineseFont', 8)
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + 4, y, str(r[0]))
        
        # Color for direction
        d = str(r[1])
        c.setFillColor(colors.HexColor('#276749') if ('入' in d or 'IN' in d) else colors.HexColor('#c53030'))
        c.drawString(40 + cols[0] + 4, y, d)
        
        c.setFillColor(colors.HexColor('#2d3748'))
        c.drawString(40 + sum(cols[:2]) + 4, y, str(r[2]))
        c.drawString(40 + sum(cols[:3]) + 4, y, str(r[3]))
        c.drawString(40 + sum(cols[:4]) + 4, y, str(r[4]))
        c.drawString(40 + sum(cols[:5]) + 4, y, str(r[5]))
        
        # Text wrapping for summary
        summary = str(r[6])
        if len(summary) > 18:
            c.drawString(40 + sum(cols[:6]) + 4, y + 3, summary[:18])
            c.drawString(40 + sum(cols[:6]) + 4, y - 7, summary[18:])
        else:
            c.drawString(40 + sum(cols[:6]) + 4, y, summary)
            
        c.drawString(40 + sum(cols[:7]) + 4, y, str(r[7]))
        
        c.setStrokeColor(colors.HexColor('#edf2f7'))
        c.line(40, y - 7, 40 + sum(cols), y - 7)
        y -= line_height
    return y

def create_20page_benchmark_pdf():
    c = canvas.Canvas(OUTPUT_PATH, pagesize=landscape(A4))
    width, height = landscape(A4)
    cols = [75, 45, 65, 65, 145, 135, 180, 50]
    headers = ["交易时间", "方向", "交易金额", "账户余额", "交易对手方名称", "对手方账号/开户行", "交易摘要/用途", "渠道"]

    # -------------------------------------------------------------
    # ACCOUNT 1: 中国工商银行 个人结算卡 (赵立明 6222 0202 0019 9283 719)
    # PAGES 1 ~ 4
    # -------------------------------------------------------------
    # Page 1: 标准首页 + 连续正常收支流水
    draw_header(c, width, height, "中国工商银行 借记卡账户对账单", "赵立明", "6222 0202 0019 9283 719", "工商银行北京东四支行", "2023-01-01 至 2023-12-31", 1)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p1 = [
        ("2023-01-05 10:15:20", "转入", "80,000.00", "80,000.00", "北京华阳商贸发展有限公司", "110010293847561/工行", "工程前期劳务预付款结算", "企业网银"),
        ("2023-01-08 14:22:00", "转出", "20,000.00", "60,000.00", "钱志国", "6217000100288391028/建行", "往来借款归还", "手机银行"),
        ("2023-01-15 09:30:15", "转出", "3,500.00", "56,500.00", "北京市自来水集团有限责任公司", "110293847561029/招行", "水费缴纳", "网银"),
        ("2023-01-20 16:45:00", "转入", "50,000.00", "106,500.00", "河北顺天通物流有限公司", "130092837461524/农行", "运输劳务费结算", "网银电汇"),
        ("2023-01-28 11:10:05", "转出", "6,500.00", "100,000.00", "北京物美超市商业有限公司", "110928374618293/中行", "超市年货采购", "POS刷卡"),
        ("2023-02-10 15:30:20", "转出", "40,000.00", "60,000.00", "赵立明 (建行卡)", "6217000100288391028/建行", "个人多账户同名调拨", "手机转账"),
        ("2023-03-21 00:00:00", "转入", "68.50", "60,068.50", "结息", "--/系统结息", "活期存款季度结息", "系统自动"),
    ]
    draw_rows(c, y - 32, cols, p1)
    c.showPage()

    # Page 2: 司法红章遮挡 + 终身寿险大额扣费 + 跨行长摘要
    draw_header(c, width, height, "中国工商银行 借记卡账户对账单", "赵立明", "6222 0202 0019 9283 719", "工商银行北京东四支行", "2023-01-01 至 2023-12-31", 2)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p2 = [
        ("2023-04-02 09:10:00", "转入", "200,000.00", "260,068.50", "中铁建工集团北京工程分部", "110928374615201/工行", "分包结算进度款划转（第二批次款项）", "电汇"),
        ("2023-04-08 11:25:30", "转出", "150,000.00", "110,068.50", "新华人寿保险股份有限公司北京分公司", "110091827364519/工行", "大额终身年金保险投保保费扣划（保单号：XH9817264819）超长摘要折行", "代扣"),
        ("2023-04-15 16:20:10", "转出", "30,000.00", "80,068.50", "北京保利国际拍卖有限公司", "110293847561829/交行", "艺术品竞买保证金划转", "手机银行"),
        ("2023-04-25 14:00:00", "转出", "40,000.00", "40,068.50", "北京东方园林工程劳务队", "110928374618293/中行", "劳务工人工资代付", "网银代发"),
        ("2023-04-28 17:30:15", "转出", "10,000.00", "30,068.50", "某某汽车维修保养中心", "110928374619283/工行", "车辆大修及配件费用", "POS刷卡"),
    ]
    draw_rows(c, y - 32, cols, p2, 26)
    draw_red_seal(c, width - 260, height - 160, "北京市海淀区人民法院", "执行实施庭调证专用章", "2023.10.18")
    c.showPage()

    # Page 3: 续页无顶栏抬头 + 连续夜间 ATM 取现与大额柜面提现
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "工商银行借记卡对账单 · 续页（无顶栏抬头）")
    c.drawRightString(width - 40, height - 35, "第 3 页 / 共 20 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    p3 = [
        ("2023-05-02 22:30:00", "转出", "20,000.00", "10,068.50", "ATM现金取款", "--/夜间自助设备", "ATM大额自助现金支取（无对手方）", "ATM设备"),
        ("2023-05-03 23:15:10", "转出", "9,000.00", "1,068.50", "ATM现金取款", "--/夜间自助设备", "ATM跨行现金支取", "ATM设备"),
        ("2023-05-18 10:00:00", "转入", "100,000.00", "101,068.50", "李某某 (外部往来)", "6217000192837461/农行", "借款周转还款入账", "手机银行"),
        ("2023-05-19 14:10:00", "转出", "100,000.00", "1,068.50", "柜面大额现金支取", "--/东四支行柜台", "柜台个人现金结清大额提取（疑似转移财产规避执行）", "现金业务"),
    ]
    draw_rows(c, y - 32, cols, p3)
    c.showPage()

    # Page 4: 案卷双面复印留白页
    draw_blank_page(c, width, height, 4)

    # -------------------------------------------------------------
    # ACCOUNT 2: 中国建设银行 个人工资结算卡 (赵立明 6217 0001 0028 8391 028)
    # PAGES 5 ~ 8
    # -------------------------------------------------------------
    # Page 5: 建行开户抬头 + 工资薪金/津贴批量代发
    draw_header(c, width, height, "中国建设银行 个人活期对账单", "赵立明", "6217 0001 0028 8391 028", "建设银行北京朝阳支行", "2023-01-01 至 2023-12-31", 5)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p5 = [
        ("2023-01-10 09:00:00", "转入", "25,000.00", "25,000.00", "北京华阳商贸发展有限公司", "110010293847561/工行", "职工月度薪资代发", "批量代发"),
        ("2023-01-15 11:20:00", "转出", "8,000.00", "17,000.00", "北京链家房地产经纪有限公司", "110928374619283/建行", "房屋租赁租金支付", "手机银行"),
        ("2023-02-10 09:00:00", "转入", "25,000.00", "42,000.00", "北京华阳商贸发展有限公司", "110010293847561/工行", "职工月度薪资代发", "批量代发"),
        ("2023-02-10 16:00:00", "转入", "40,000.00", "82,000.00", "赵立明 (工行卡调拨)", "6222020200199283719/工行", "同名卡资金划转(内部转入)", "手机转账"),
        ("2023-02-28 15:30:00", "转出", "30,000.00", "52,000.00", "北京朝阳大悦城商业管理有限公司", "110928374618293/中行", "专柜奢侈品购物消费", "POS刷卡"),
    ]
    draw_rows(c, y - 32, cols, p5)
    c.showPage()

    # Page 6: 向配偶孙小燕转账 + 购房订金（财产转移嫌疑）
    draw_header(c, width, height, "中国建设银行 个人活期对账单", "赵立明", "6217 0001 0028 8391 028", "建设银行北京朝阳支行", "2023-01-01 至 2023-12-31", 6)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p6 = [
        ("2023-03-05 10:30:00", "转出", "40,000.00", "12,000.00", "孙小燕 (配偶)", "6217000192837461/建行", "个人生活费转账（立案前大额转移）", "手机银行"),
        ("2023-03-10 09:00:00", "转入", "25,000.00", "37,000.00", "北京华阳商贸发展有限公司", "110010293847561/工行", "职工月度薪资代发", "批量代发"),
        ("2023-03-25 14:15:00", "转出", "35,000.00", "2,000.00", "北京中原房地产经纪有限公司", "110928374619283/招行", "二手房买卖诚意金", "网银"),
    ]
    draw_rows(c, y - 32, cols, p6)
    c.showPage()

    # Page 7: 故意制造一笔余额跳跃断层 (Discontinuity)
    # Page 6 ended at 2,000.00.
    # Row 1: 2,000 + 50,000 = 52,000 (Normal)
    # Row 2: Drops to 20,000 with transaction of 10,000! (52,000 - 10,000 != 20,000, simulates missed row/print gap!)
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "建设银行活期对账单 · 续页（无顶栏抬头）")
    c.drawRightString(width - 40, height - 35, "第 7 页 / 共 20 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    p7 = [
        ("2023-04-01 10:00:00", "转入", "50,000.00", "52,000.00", "张某某", "6217000192837461/建行", "借款往来归还", "手机银行"),
        ("2023-04-10 11:30:00", "转出", "10,000.00", "20,000.00", "某某建材工程队", "110928374615201/农行", "装修材料款支付（此处发生余额跳跃断层）", "网银"),
        ("2023-04-20 16:00:00", "转出", "19,000.00", "1,000.00", "赵立明 (转招行卡)", "6214830192837461/招行", "个人资金归集调拨", "手机银行"),
    ]
    draw_rows(c, y - 32, cols, p7)
    c.showPage()

    # Page 8: 案卷双面复印留白页
    draw_blank_page(c, width, height, 8)

    # -------------------------------------------------------------
    # ACCOUNT 3: 招商银行 一卡通 (理财投资卡, 6214 8301 9283 7461)
    # PAGES 9 ~ 12
    # -------------------------------------------------------------
    # Page 9: 银证转账大额进出（华泰证券、中信证券）
    draw_header(c, width, height, "招商银行 个人一卡通历史对账单", "赵立明", "6214 8301 9283 7461", "招商银行北京建国路支行", "2023-01-01 至 2023-12-31", 9)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p9 = [
        ("2023-05-05 09:30:00", "转入", "200,000.00", "200,000.00", "华泰证券股份有限公司客户交易结算资金", "110092837461520/招行", "证券资金账户转出银证转账", "银证转账"),
        ("2023-05-12 14:40:00", "转出", "150,000.00", "50,000.00", "中信证券股份有限公司", "110092837461999/工行", "银证转账充值(转入证券保证金账户)", "银证转账"),
        ("2023-05-20 10:15:00", "转入", "19,000.00", "69,000.00", "赵立明 (建行卡转入)", "6217000100288391028/建行", "内部资金划转归集", "跨行转账"),
        ("2023-06-01 15:30:00", "转出", "60,000.00", "9,000.00", "北京东方资产管理中心", "110293847561829/中行", "信托理财产品申购款项", "网上银行"),
    ]
    draw_rows(c, y - 32, cols, p9)
    c.showPage()

    # Page 10: 购买基金信托理财 + 收益派发
    draw_header(c, width, height, "招商银行 个人一卡通历史对账单", "赵立明", "6214 8301 9283 7461", "招商银行北京建国路支行", "2023-01-01 至 2023-12-31", 10)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p10 = [
        ("2023-06-15 10:00:00", "转入", "80,000.00", "89,000.00", "招银理财有限责任公司", "110293847561001/招行", "定期理财产品到期本息兑付", "系统清算"),
        ("2023-06-18 11:20:00", "转出", "85,000.00", "4,000.00", "孙小燕 (配偶招行卡)", "6214830199998888/招行", "家庭生活与理财资金调配", "手机转账"),
        ("2023-06-30 00:00:00", "转入", "12.50", "4,012.50", "结息", "--/系统结息", "活期结息入账", "系统自动"),
    ]
    draw_rows(c, y - 32, cols, p10)
    c.showPage()

    # Page 11: 续表 + 第二枚红色法院公章遮挡
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "招商银行一卡通历史对账单 · 续页")
    c.drawRightString(width - 40, height - 35, "第 11 页 / 共 20 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    p11 = [
        ("2023-07-05 14:00:00", "转出", "3,500.00", "512.50", "中国平安财产保险股份有限公司", "110928374618293/平安银行", "商业车险保费代扣", "自动代扣"),
        ("2023-07-10 09:30:00", "转出", "500.00", "12.50", "招商银行信用卡还款", "6225750012345678/招行", "个人信用卡消费账单清偿", "手机转账"),
    ]
    draw_rows(c, y - 32, cols, p11)
    draw_red_seal(c, width - 250, height - 160, "北京市朝阳区人民法院", "执行局查控专用章", "2023.11.25")
    c.showPage()

    # Page 12: 案卷双面复印留白页
    draw_blank_page(c, width, height, 12)

    # -------------------------------------------------------------
    # ACCOUNT 4: 关联企业账户 (北京华阳商贸发展有限公司 对公户 1100 1029 3847 561)
    # PAGES 13 ~ 16
    # -------------------------------------------------------------
    # Page 13: 对公基本户对账单版式 + 巨额工程款进出
    draw_header(c, width, height, "中国工商银行 单位银行结算账户对账单 (对公户)", "北京华阳商贸发展有限公司 (关联公司)", "1100 1029 3847 561", "工商银行北京东四支行", "2023-01-01 至 2023-12-31", 13)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p13 = [
        ("2023-08-01 09:15:00", "转入", "500,000.00", "500,000.00", "中铁建工集团有限公司", "110928374619283/工行", "大兴新机场配套项目工程进度款", "大额跨行网银"),
        ("2023-08-05 14:20:00", "转出", "200,000.00", "300,000.00", "天津港通贸易有限责任公司", "120092837461524/建行", "钢材与建筑模板采购预付款", "企业网银"),
        ("2023-08-10 11:00:00", "转出", "150,000.00", "150,000.00", "北京顺通劳务服务有限公司", "110293847561829/农行", "劳务派遣工程款支付", "网银代发"),
    ]
    draw_rows(c, y - 32, cols, p13)
    c.showPage()

    # Page 14: 公司公账资金直接大额转给被执行人个人（法人人格否认/财产混同强证据）
    draw_header(c, width, height, "中国工商银行 单位银行结算账户对账单 (对公户)", "北京华阳商贸发展有限公司 (关联公司)", "1100 1029 3847 561", "工商银行北京东四支行", "2023-01-01 至 2023-12-31", 14)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p14 = [
        ("2023-08-15 10:30:00", "转出", "100,000.00", "50,000.00", "赵立明 (法定代表人借记卡)", "6222020200199283719/工行", "公司利润分红及高管备用金(财产混同线索)", "企业网银"),
        ("2023-08-20 15:45:00", "转出", "45,000.00", "5,000.00", "孙小燕 (关联人个人账户)", "6217000192837461/建行", "公司代垫股东日常开销与差旅费", "企业网银"),
        ("2023-08-31 16:00:00", "转出", "4,500.00", "500.00", "国家税务总局北京市东城区税务局", "110000000000000/人行国库", "增值税及附加税费扣缴", "税库银联动"),
    ]
    draw_rows(c, y - 32, cols, p14)
    c.showPage()

    # Page 15: 对公户跨页续表 + 账户管理费扣划
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "单位结算账户对账单 · 续页")
    c.drawRightString(width - 40, height - 35, "第 15 页 / 共 20 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    p15 = [
        ("2023-09-01 09:00:00", "转出", "300.00", "200.00", "中国工商银行", "--/内部收费", "企业网上银行年服务费", "系统自动"),
        ("2023-09-21 00:00:00", "转入", "1.50", "201.50", "单位存款结息", "--/内部结息", "单位活期存款季度结息", "系统自动"),
    ]
    draw_rows(c, y - 32, cols, p15)
    c.showPage()

    # Page 16: 案卷双面复印留白页
    draw_blank_page(c, width, height, 16)

    # -------------------------------------------------------------
    # ACCOUNT 5: 跨卡闭环同名内部互转与销户 (PAGES 17 ~ 19)
    # -------------------------------------------------------------
    # Page 17: 中国光大银行 同名二类卡 (6226 7210 0323 2085)
    draw_header(c, width, height, "中国光大银行 个人活期对账单 (二类卡)", "赵立明", "6226 7210 0323 2085", "光大银行北京西城支行", "2023-01-01 至 2023-12-31", 17)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p17 = [
        ("2023-10-01 10:00:00", "转入", "300,000.00", "300,000.00", "新疆某某影视传媒合伙企业", "650092837461524/光大", "合伙人投资收益分配划转", "电汇"),
        ("2023-10-02 11:30:00", "转出", "200,000.00", "100,000.00", "赵立明 (工行主卡)", "6222020200199283719/工行", "同名卡内部跨行调拨(资金池流转)", "网银转账"),
        ("2023-10-05 15:20:00", "转出", "99,000.00", "1,000.00", "赵立明 (建行卡)", "6217000100288391028/建行", "同名卡内部归集(轧差对冲)", "网银转账"),
    ]
    draw_rows(c, y - 32, cols, p17)
    c.showPage()

    # Page 18: 续表 + 第三枚银行结算专用章
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#718096'))
    c.drawString(40, height - 35, "中国光大银行个人活期对账单 · 续页")
    c.drawRightString(width - 40, height - 35, "第 18 页 / 共 20 页")
    c.setStrokeColor(colors.HexColor('#cbd5e0'))
    c.line(40, height - 42, width - 40, height - 42)
    y = height - 55
    draw_table_headers(c, y, cols, headers)
    p18 = [
        ("2023-11-01 10:00:00", "转出", "500.00", "500.00", "手机话费充值", "--/电信扣费", "中国电信手机话费充值缴费", "快捷支付"),
        ("2023-11-15 14:00:00", "转出", "400.00", "100.00", "北京燃气集团有限责任公司", "110928374618293/北京银行", "燃气费用缴纳", "生活缴费"),
    ]
    draw_rows(c, y - 32, cols, p18)
    draw_red_seal(c, width - 260, height - 150, "中国光大银行北京分行", "业务凭证打印专用章", "2023.12.01")
    c.showPage()

    # Page 19: 账户结清销户
    draw_header(c, width, height, "中国光大银行 个人活期对账单 (销户明细)", "赵立明", "6226 7210 0323 2085", "光大银行北京西城支行", "2023-01-01 至 2023-12-31", 19)
    y = height - 86
    draw_table_headers(c, y, cols, headers)
    p19 = [
        ("2023-12-30 16:30:00", "转出", "100.00", "0.00", "柜面账户结清注销", "--/网点柜面", "个人银行借记卡结清销户并注销", "柜面清零"),
    ]
    draw_rows(c, y - 32, cols, p19)
    c.showPage()

    # -------------------------------------------------------------
    # PAGE 20: 司法查询回执与清单汇总页 (0 交易文书页)
    # -------------------------------------------------------------
    c.setFont('ChineseFont', 16)
    c.setFillColor(colors.HexColor('#1a365d'))
    c.drawCentredString(width / 2.0, height - 60, "协助人民法院执行财产查询结果回执单")
    
    c.setFont('ChineseFont', 9)
    c.setFillColor(colors.HexColor('#4a5568'))
    c.drawString(60, height - 100, "致：北京市第一中级人民法院 执行实施庭")
    c.drawString(60, height - 120, "案由：(2023)京0105执19283号 申请执行人与被执行人合同纠纷执行一案。")
    c.drawString(60, height - 140, "根据贵院出具的《协助查询存款通知书》及相关执行裁定，我行已对被执行人【赵立明】名下账户完成调证。")
    c.drawString(60, height - 160, "本次调取流水清单共计 19 页账页，涵盖工商银行、建设银行、招商银行、光大银行及关联企业华阳商贸账户。")
    c.drawString(60, height - 180, "汇总结论：上述各账户累计发生资金流水总笔数 60 余笔，期末存量资金基本清零，发现存在关联大额划转。")
    
    c.drawString(60, height - 230, "经办柜员：工号 981203")
    c.drawString(240, height - 230, "复核主管：工号 980012")
    c.drawString(420, height - 230, "联系电话：010-65889988")
    c.drawString(600, height - 230, "日期：2023年12月31日")
    
    c.setStrokeColor(colors.HexColor('#a0aec0'))
    c.setLineWidth(0.8)
    c.line(60, height - 250, width - 60, height - 250)
    
    c.setFont('ChineseFont', 8)
    c.setFillColor(colors.HexColor('#a0aec0'))
    c.drawCentredString(width / 2.0, height - 270, "【 本 页 为 法 院 调 证 结 果 回 执 文 书 ， 无 具 体 交 易 明 细 】")
    c.drawRightString(width - 40, 25, "第 20 页 / 共 20 页")
    
    draw_red_seal(c, width - 200, height - 200, "中国工商银行北京市分行", "法律事务与协助执行专用章", "2023.12.31")
    c.showPage()

    c.save()
    print(f"✅ 成功生成 20 页超全司法测试银行流水 PDF: {OUTPUT_PATH}")

if __name__ == '__main__':
    create_20page_benchmark_pdf()
