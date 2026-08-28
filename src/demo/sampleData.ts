import { CaseMetadata } from '../types/case';
import { BankAccount, StandardTransaction } from '../types/transaction';

export const SAMPLE_CASE: CaseMetadata = {
  id: 'CASE_SAMPLE_HUYANHONG_001',
  caseNumber: '(2024)京0105执8890号',
  courtName: '北京市朝阳区人民法院',
  applicantName: '北京中泰合创投资管理有限公司',
  respondentName: '胡艳红',
  respondentIdCard: '11010519820315****',
  targetAmount: 1200000, // 120万元标的
  createdAt: '2024-05-10',
  updatedAt: '2024-06-15',
  timeline: {
    debtFormationDate: '2022-03-15', // T0 借款日
    lawsuitFilingDate: '2023-04-10', // T1 起诉保全
    judgmentEffectiveDate: '2023-11-20', // T2 判决生效
    executionFilingDate: '2024-01-15', // T3 执行立案
    reportOrderServedDate: '2024-02-01', // T4 报告财产令送达
    freezeDate: '2024-02-10', // T5 冻结
    settlementDate: '2024-03-05', // T6 和解协议
    customNodes: []
  },
  declaredAssets: [
    {
      id: 'DEC_1',
      category: 'income',
      declaredContent: '无固定工作与稳定收入，仅靠零工生活',
      declaredValue: 0,
      notes: '声称无收入'
    },
    {
      id: 'DEC_2',
      category: 'bank_account',
      declaredContent: '名下仅建行卡一张，余额12.50元',
      declaredValue: 12.5,
      notes: '隐瞒工行与招行卡'
    }
  ]
};

export const SAMPLE_ACCOUNTS: BankAccount[] = [
  {
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '胡艳红_建行流水_2023-2024.xlsx',
    fileType: 'excel',
    totalIn: 850000,
    totalOut: 849500,
    transactionCount: 8,
    startDate: '2023-01-01',
    endDate: '2024-05-30',
    startBalance: 500,
    endBalance: 1000,
    isBalanced: true,
    balanceDiff: 0
  },
  {
    accountNumber: '6222020200039988456',
    accountName: '胡艳红',
    bankName: '中国工商银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '胡艳红_工行明细.pdf',
    fileType: 'pdf',
    totalIn: 450000,
    totalOut: 450000,
    transactionCount: 6,
    startDate: '2023-06-01',
    endDate: '2024-05-30',
    startBalance: 0,
    endBalance: 0,
    isBalanced: true,
    balanceDiff: 0
  }
];

export const SAMPLE_TRANSACTIONS: StandardTransaction[] = [
  // 1. Post Report Order Large Transfer (L0 Red line)
  {
    id: 'TX_DEMO_01',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-02-05 14:20:00',
    transactionDate: '2024-02-05',
    direction: 'OUT',
    amount: 180000,
    balance: 5000,
    counterpartyName: '张明海',
    counterpartyAccount: '6228480100098877123',
    counterpartyBank: '中国农业银行',
    summary: '借款往来',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 12,
    rawRowIndex: 45
  },
  // 2. Cash Smurfing (L0 Red line)
  {
    id: 'TX_DEMO_02',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-02-08 10:15:00',
    transactionDate: '2024-02-08',
    direction: 'OUT',
    amount: 49500,
    balance: 5500,
    counterpartyName: 'ATM/现金支取',
    summary: '柜面大额现金取款',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 14,
    rawRowIndex: 58
  },
  {
    id: 'TX_DEMO_03',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-02-09 09:30:00',
    transactionDate: '2024-02-09',
    direction: 'OUT',
    amount: 49000,
    balance: 500,
    counterpartyName: 'ATM/现金支取',
    summary: 'ATM现金取款',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 14,
    rawRowIndex: 62
  },
  // 3. Ant moving to close relative (L1)
  {
    id: 'TX_DEMO_04',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-01-20 16:00:00',
    transactionDate: '2024-01-20',
    direction: 'OUT',
    amount: 25000,
    balance: 185000,
    counterpartyName: '胡艳丽',
    summary: '生活费',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 8,
    rawRowIndex: 25
  },
  {
    id: 'TX_DEMO_05',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-02-15 11:00:00',
    transactionDate: '2024-02-15',
    direction: 'OUT',
    amount: 30000,
    balance: 155000,
    counterpartyName: '胡艳丽',
    summary: '给姐姐生活费',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 15,
    rawRowIndex: 70
  },
  {
    id: 'TX_DEMO_06',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-03-01 15:30:00',
    transactionDate: '2024-03-01',
    direction: 'OUT',
    amount: 28000,
    balance: 127000,
    counterpartyName: '胡艳丽',
    summary: '转账',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 18,
    rawRowIndex: 85
  },
  // 4. Wealth / Insurance diversion (L0)
  {
    id: 'TX_DEMO_07',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2023-12-10 10:00:00',
    transactionDate: '2023-12-10',
    direction: 'OUT',
    amount: 150000,
    balance: 350000,
    counterpartyName: '中信建投证券股份有限公司',
    summary: '第三方存管银证转账',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 5,
    rawRowIndex: 12
  },
  // 5. Internal Transfer: CCB -> ICBC (Should be netted)
  {
    id: 'TX_DEMO_08',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-01-10 09:00:00',
    transactionDate: '2024-01-10',
    direction: 'OUT',
    amount: 100000,
    balance: 250000,
    counterpartyName: '胡艳红',
    counterpartyAccount: '6222020200039988456',
    summary: '本人账户互转',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 7,
    rawRowIndex: 20
  },
  {
    id: 'TX_DEMO_09',
    accountNumber: '6222020200039988456',
    accountName: '胡艳红',
    bankName: '中国工商银行',
    transactionTime: '2024-01-10 09:05:00',
    transactionDate: '2024-01-10',
    direction: 'IN',
    amount: 100000,
    balance: 100000,
    counterpartyName: '胡艳红',
    counterpartyAccount: '6217000100028899123',
    summary: '网银转入',
    rawSourceFile: '胡艳红_工行明细.pdf',
    rawPageNumber: 1,
    rawRowIndex: 3
  },
  // 6. Fast In Fast Out (L1)
  {
    id: 'TX_DEMO_10',
    accountNumber: '6222020200039988456',
    accountName: '胡艳红',
    bankName: '中国工商银行',
    transactionTime: '2024-02-20 10:00:00',
    transactionDate: '2024-02-20',
    direction: 'IN',
    amount: 200000,
    balance: 200000,
    counterpartyName: '北京通达工程设备有限公司',
    summary: '工程款结算',
    rawSourceFile: '胡艳红_工行明细.pdf',
    rawPageNumber: 2,
    rawRowIndex: 8
  },
  {
    id: 'TX_DEMO_11',
    accountNumber: '6222020200039988456',
    accountName: '胡艳红',
    bankName: '中国工商银行',
    transactionTime: '2024-02-21 09:15:00',
    transactionDate: '2024-02-21',
    direction: 'OUT',
    amount: 198000,
    balance: 2000,
    counterpartyName: '李建军',
    summary: '还借款',
    rawSourceFile: '胡艳红_工行明细.pdf',
    rawPageNumber: 2,
    rawRowIndex: 12
  },
  // 7. Continuous Stable Income (L2 Solvency Proof)
  {
    id: 'TX_DEMO_12',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-01-25 10:00:00',
    transactionDate: '2024-01-25',
    direction: 'IN',
    amount: 35000,
    balance: 285000,
    counterpartyName: '北京华誉商贸有限公司',
    summary: '工资及奖金发放',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 9,
    rawRowIndex: 30
  },
  {
    id: 'TX_DEMO_13',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-02-25 10:00:00',
    transactionDate: '2024-02-25',
    direction: 'IN',
    amount: 35000,
    balance: 40000,
    counterpartyName: '北京华誉商贸有限公司',
    summary: '工资及奖金发放',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 16,
    rawRowIndex: 78
  },
  {
    id: 'TX_DEMO_14',
    accountNumber: '6217000100028899123',
    accountName: '胡艳红',
    bankName: '中国建设银行',
    transactionTime: '2024-03-25 10:00:00',
    transactionDate: '2024-03-25',
    direction: 'IN',
    amount: 35000,
    balance: 162000,
    counterpartyName: '北京华誉商贸有限公司',
    summary: '工资及奖金发放',
    rawSourceFile: '胡艳红_建行流水_2023-2024.xlsx',
    rawPageNumber: 20,
    rawRowIndex: 95
  }
];
