import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Eye,
  FilePlus2,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  BankAccount,
  EvidenceReviewIssue,
  ReviewIssueStatus,
  StandardTransaction,
} from "../types/transaction";
import { auditAccountBalance } from "../parsers/sanityChecker";
import { buildEvidenceReviewIssues } from "../review/buildEvidenceReviewIssues";
import { getSourceDocument } from "../store/sourceDocumentStore";
import { PdfEvidencePage } from "./PdfEvidencePage";
import {
  accountIdentityKey,
  transactionBelongsToAccount,
} from "../utils/accountIdentity";

interface Step2Props {
  caseId: string;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onAccountsUpdated: (updated: BankAccount[]) => void;
  onTransactionsUpdated: (updated: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

interface MissingTransactionDraft {
  transactionTime: string;
  direction: "IN" | "OUT";
  amount: string;
  balance: string;
  counterpartyName: string;
  summary: string;
}

interface EvidenceReviewGroup {
  key: string;
  account: BankAccount;
  pageNumber?: number;
  issues: EvidenceReviewIssue[];
}

const emptyDraft = (): MissingTransactionDraft => ({
  transactionTime: "",
  direction: "OUT",
  amount: "",
  balance: "",
  counterpartyName: "",
  summary: "",
});

export const Step2Verify: React.FC<Step2Props> = ({
  caseId,
  accounts,
  transactions,
  onAccountsUpdated,
  onTransactionsUpdated,
  onNext,
  onPrev,
}) => {
  const [selectedAccNum, setSelectedAccNum] = useState(
    accounts[0] ? accountIdentityKey(accounts[0]) : "",
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [isSourceLoading, setIsSourceLoading] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState<MissingTransactionDraft>(emptyDraft());
  const [transactionFilter, setTransactionFilter] = useState<
    "ALL" | "PENDING" | "VERIFIED" | "CORRECTED" | "AUTO"
  >("ALL");
  const [expandedTransactionId, setExpandedTransactionId] = useState("");
  const [selectedTransactionId, setSelectedTransactionId] = useState("");
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [selectedRemovalIds, setSelectedRemovalIds] = useState<string[]>([]);

  const selectedAccount =
    accounts.find(
      (account) => accountIdentityKey(account) === selectedAccNum,
    ) || accounts[0];
  const auditReport = selectedAccount
    ? auditAccountBalance(selectedAccount, transactions)
    : null;
  const issues = useMemo(
    () =>
      selectedAccount
        ? buildEvidenceReviewIssues(selectedAccount, transactions)
        : [],
    [selectedAccount, transactions],
  );
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId);
  const selectedIssueGroup = selectedIssue
    ? issues.filter((issue) => sameReviewPage(issue, selectedIssue))
    : [];
  const affectedTransactionIds = [
    ...new Set(selectedIssueGroup.flatMap((issue) => issue.transactionIds)),
  ];
  const affectedTransactions = affectedTransactionIds
    .map((id) => transactions.find((transaction) => transaction.id === id))
    .filter(Boolean) as StandardTransaction[];
  const allAccountIssues = useMemo(
    () =>
      accounts.flatMap((account) =>
        buildEvidenceReviewIssues(account, transactions),
      ),
    [accounts, transactions],
  );
  const allRequiredOutstanding = allAccountIssues.filter(
    (issue) =>
      issue.severity === "REQUIRED" &&
      (issue.status === "PENDING" || issue.status === "UNRESOLVED"),
  );
  const reviewQueueGroups = useMemo(
    () => buildReviewGroups(accounts, transactions),
    [accounts, transactions],
  );
  const pageLevelIssueGroups = reviewQueueGroups.filter((group) =>
    Boolean(group.pageNumber) && group.issues.some((issue) => !isTransactionLevelIssue(issue)),
  );
  const documentAdvisoryGroups = reviewQueueGroups.filter((group) => !group.pageNumber);
  const pendingReviewGroups = reviewQueueGroups.filter((group) =>
    group.issues.some(isOutstandingRequired),
  );
  const pendingReviewCount = pendingReviewGroups.length;
  const issuesByTransaction = useMemo(() => {
    const result = new Map<string, EvidenceReviewIssue[]>();
    for (const issue of allAccountIssues.filter(isTransactionLevelIssue))
      for (const transactionId of issue.transactionIds)
        result.set(transactionId, [
          ...(result.get(transactionId) || []),
          issue,
        ]);
    return result;
  }, [allAccountIssues]);
  const selectedTransaction = transactions.find(
    (transaction) => transaction.id === selectedTransactionId,
  );
  const selectedCountComparison = selectedIssueGroup
    .map(issueCountComparison)
    .find(Boolean);
  const selectedIssueHasLocation =
    !selectedIssue ||
    (selectedCountComparison
      ? Boolean(selectedIssue.pageNumber && affectedTransactions.length > 0)
      : Boolean(selectedIssue.pageNumber || selectedTransaction));

  useEffect(() => {
    let cancelled = false;
    if (!selectedAccount || selectedAccount.fileType !== "pdf") {
      setSourceFile(null);
      return;
    }
    setIsSourceLoading(true);
    getSourceDocument(caseId, selectedAccount.fileName).then((file) => {
      if (!cancelled) {
        setSourceFile(file);
        setIsSourceLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [caseId, selectedAccount?.fileName, selectedAccount?.fileType]);

  useEffect(() => {
    setResolutionNote(selectedIssue?.resolutionNote || "");
    setShowAddForm(false);
    setDraft(emptyDraft());
    setSelectedRemovalIds([]);
  }, [selectedIssue?.id]);

  const displayedTransactions = transactions
    .filter((transaction) => {
      if (!searchTerm) return true;
      const query = searchTerm.toLowerCase();
      return (
        transaction.counterpartyName.toLowerCase().includes(query) ||
        transaction.summary.toLowerCase().includes(query) ||
        String(transaction.amount).includes(query) ||
        transaction.transactionDate.includes(query) ||
        transaction.bankName.toLowerCase().includes(query) ||
        transaction.accountNumber.includes(query)
      );
    })
    .filter(
      (transaction) =>
        transactionFilter === "ALL" ||
        transactionReviewState(
          transaction,
          issuesByTransaction.get(transaction.id) || [],
        ) === transactionFilter,
    );
  const statusCounts = transactions.reduce(
    (counts, transaction) => {
      const status = transactionReviewState(
        transaction,
        issuesByTransaction.get(transaction.id) || [],
      );
      counts[status] += 1;
      return counts;
    },
    { PENDING: 0, VERIFIED: 0, CORRECTED: 0, AUTO: 0 },
  );

  const openTransactionReview = (
    transaction: StandardTransaction,
    issue?: EvidenceReviewIssue,
  ) => {
    const account = accounts.find((item) =>
      transactionBelongsToAccount(transaction, item),
    );
    if (account) setSelectedAccNum(accountIdentityKey(account));
    setSelectedTransactionId(transaction.id);
    if (issue) setSelectedIssueId(issue.id);
    else setSelectedIssueId("");
    setIsReviewOpen(true);
  };

  const openIssueReview = (
    account: BankAccount,
    issue: EvidenceReviewIssue,
  ) => {
    setSelectedAccNum(accountIdentityKey(account));
    setSelectedIssueId(issue.id);
    setSelectedTransactionId(issue.transactionIds[0] || "");
    setIsReviewOpen(true);
  };

  const navigatePendingIssue = (direction: 1 | -1) => {
    if (!reviewQueueGroups.length) return;
    const currentIndex = Math.max(
      0,
      reviewQueueGroups.findIndex((group) =>
        group.issues.some((issue) => issue.id === selectedIssueId),
      ),
    );
    for (let offset = 1; offset <= reviewQueueGroups.length; offset += 1) {
      const index =
        (currentIndex + direction * offset + reviewQueueGroups.length) %
        reviewQueueGroups.length;
      const group = reviewQueueGroups[index];
      const pendingIssue = group.issues.find(
        isOutstandingRequired,
      );
      if (pendingIssue) {
        openIssueReview(group.account, pendingIssue);
        return;
      }
    }
  };

  const advanceAfterResolution = (resolvedIssueId: string) => {
    const currentIndex = Math.max(
      0,
      reviewQueueGroups.findIndex((group) =>
        group.issues.some((issue) => issue.id === resolvedIssueId),
      ),
    );
    for (let offset = 1; offset <= reviewQueueGroups.length; offset += 1) {
      const group =
        reviewQueueGroups[(currentIndex + offset) % reviewQueueGroups.length];
      const pendingIssue = group.issues.find(
        isOutstandingRequired,
      );
      if (
        pendingIssue &&
        !group.issues.some((issue) => issue.id === resolvedIssueId)
      ) {
        openIssueReview(group.account, pendingIssue);
        return;
      }
    }
    setIsReviewOpen(false);
  };

  const commitTransactions = (updated: StandardTransaction[]) => {
    onTransactionsUpdated(updated);
    if (!selectedAccount) return;
    const accountTransactions = updated.filter((transaction) =>
      transactionBelongsToAccount(transaction, selectedAccount),
    );
    const dates = accountTransactions
      .map((transaction) => transaction.transactionDate)
      .filter(Boolean)
      .sort();
    onAccountsUpdated(
      accounts.map((account) =>
        accountIdentityKey(account) === accountIdentityKey(selectedAccount)
          ? {
              ...account,
              transactionCount: accountTransactions.length,
              totalIn: accountTransactions
                .filter((transaction) => transaction.direction === "IN")
                .reduce((sum, transaction) => sum + transaction.amount, 0),
              totalOut: accountTransactions
                .filter((transaction) => transaction.direction === "OUT")
                .reduce((sum, transaction) => sum + transaction.amount, 0),
              startDate: dates[0] || account.startDate,
              endDate: dates[dates.length - 1] || account.endDate,
            }
          : account,
      ),
    );
  };

  const saveIssueStatus = (
    issue: EvidenceReviewIssue,
    status: ReviewIssueStatus,
    defaultNote = "",
    transactionSource = transactions,
  ) => {
    const groupIssues = issues.filter((item) => sameReviewPage(item, issue));
    const groupIssueIds = new Set(groupIssues.map((item) => item.id));
    const reviewedAt = new Date().toISOString();
    const updatedIssues = issues.map((item) =>
      groupIssueIds.has(item.id)
        ? {
            ...item,
            status,
            resolutionNote: resolutionNote.trim() || defaultNote,
            reviewedAt,
          }
        : item,
    );
    onAccountsUpdated(
      accounts.map((account) =>
        selectedAccount &&
        accountIdentityKey(account) === accountIdentityKey(selectedAccount)
          ? summarizeAccount(
              { ...account, reviewIssues: updatedIssues },
              transactionSource,
            )
          : account,
      ),
    );
    const groupTransactionIds = new Set(
      groupIssues
        .filter(isTransactionLevelIssue)
        .flatMap((item) => item.transactionIds),
    );
    if (groupTransactionIds.size) {
      onTransactionsUpdated(
        transactionSource.map((transaction) =>
          groupTransactionIds.has(transaction.id)
            ? {
                ...transaction,
                reviewStatus:
                  status === "CORRECTED"
                    ? "CORRECTED"
                    : status === "CONFIRMED"
                      ? "VERIFIED"
                      : "PENDING",
                reviewedAt,
              }
            : transaction,
        ),
      );
    }
  };

  const resolveIssueAndAdvance = (
    issue: EvidenceReviewIssue,
    status: "CONFIRMED" | "CORRECTED" | "UNRESOLVED",
    note: string,
  ) => {
    saveIssueStatus(issue, status, note);
    advanceAfterResolution(issue.id);
  };

  const removeSelectedTransactions = () => {
    if (!selectedIssue || selectedRemovalIds.length === 0) return;
    if (
      !window.confirm(
        `确定从结构化明细中删除选中的 ${selectedRemovalIds.length} 笔记录吗？原始PDF不会被修改。`,
      )
    )
      return;
    const updated = transactions.filter(
      (transaction) => !selectedRemovalIds.includes(transaction.id),
    );
    commitTransactions(updated);
    saveIssueStatus(
      selectedIssue,
      "CORRECTED",
      `已对照原件删除 ${selectedRemovalIds.length} 笔重复或误识别记录`,
      updated,
    );
    setSelectedRemovalIds([]);
    advanceAfterResolution(selectedIssue.id);
  };

  const handleCellEdit = (
    transactionId: string,
    field: keyof StandardTransaction,
    value: any,
  ) => {
    const updated = transactions.map((transaction) => {
      if (transaction.id !== transactionId) return transaction;
      const next = {
        ...transaction,
        [field]: value,
        reviewStatus: "CORRECTED" as const,
        reviewedAt: new Date().toISOString(),
      };
      if (field === "transactionTime")
        next.transactionDate = String(value).slice(0, 10);
      const qualityIssues = new Set(next.dataQualityIssues || []);
      if (field === "transactionTime" && /^20\d{2}-\d{2}-\d{2}/.test(String(value)))
        qualityIssues.delete("INVALID_DATE");
      if (field === "amount" && Number(value) > 0)
        qualityIssues.delete("INVALID_AMOUNT");
      if (field === "direction" && value !== "UNKNOWN")
        qualityIssues.delete("UNKNOWN_DIRECTION");
      next.dataQualityIssues = [...qualityIssues];
      return next;
    });
    commitTransactions(updated);
    if (selectedIssue && affectedTransactionIds.includes(transactionId))
      saveIssueStatus(
        selectedIssue,
        "CORRECTED",
        "已根据原始流水修正本页结构化数据",
        updated,
      );
  };

  const addMissingTransaction = () => {
    if (!selectedAccount || !selectedIssue) return;
    const amount = Number(draft.amount);
    if (!draft.transactionTime || !Number.isFinite(amount) || amount <= 0) {
      window.alert("请至少填写有效的交易日期和金额。");
      return;
    }
    const page = selectedIssue.pageNumber || 1;
    const pageTransactions = transactions.filter(
      (transaction) =>
        transactionBelongsToAccount(transaction, selectedAccount) &&
        transaction.rawPageNumber === page,
    );
    const added: StandardTransaction = {
      id: `TX_MANUAL_${Date.now()}`,
      accountNumber: selectedAccount.accountNumber,
      accountName: selectedAccount.accountName,
      bankName: selectedAccount.bankName,
      transactionTime: draft.transactionTime,
      transactionDate: draft.transactionTime.slice(0, 10),
      direction: draft.direction,
      amount,
      balance: Number(draft.balance) || 0,
      balanceAvailable: draft.balance !== "",
      counterpartyName: draft.counterpartyName,
      summary: draft.summary,
      rawSourceFile: selectedAccount.fileName,
      rawPageNumber: page,
      rawRowIndex:
        Math.max(0, ...pageTransactions.map((item) => item.rawRowIndex || 0)) +
        1,
      extractionMethod: "MANUAL",
      extractionConfidence: 1,
      reviewStatus: "CORRECTED",
      reviewedAt: new Date().toISOString(),
      lawyerNote: "律师根据原始流水补录",
    };
    const updated = [...transactions, added];
    commitTransactions(updated);
    saveIssueStatus(
      selectedIssue,
      "CORRECTED",
      "律师已根据原始流水补录遗漏交易",
      updated,
    );
    setShowAddForm(false);
    setDraft(emptyDraft());
    advanceAfterResolution(selectedIssue.id);
  };

  const continueToNext = () => {
    if (
      allRequiredOutstanding.length > 0 &&
      !window.confirm(
        `仍有 ${pendingReviewGroups.length} 页尚未核对。继续后，这些问题会作为证据限制保留在分析中。是否继续？`,
      )
    )
      return;
    onNext();
  };

  return (
    <div className="max-w-[1500px] mx-auto py-8 px-4 sm:px-6 space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 2 / 6 原件核对
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">
          银行流水数据准确性复核
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          逐项对照原始文件，确认页数、交易笔数、日期、方向、金额、余额、对手方及摘要。这里只确认“是否读取正确”，不判断交易原因是否真实。
        </p>
        <div className="flex items-center gap-2 mt-5 overflow-x-auto pb-1">
          {accounts.map((account) => {
            const pending = buildReviewGroups([account], transactions).filter(
              (group) =>
                group.issues.some(isOutstandingRequired),
            ).length;
            const identity = accountIdentityKey(account);
            return (
              <button
                key={identity}
                onClick={() => {
                  setSelectedAccNum(identity);
                  setSelectedIssueId("");
                  setSelectedTransactionId("");
                }}
                className={`px-4 py-2 rounded-xl text-xs font-medium flex items-center gap-2 flex-shrink-0 ${selectedAccNum === identity ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                <span>
                  {account.bankName}（{account.accountNumber.slice(-4)}）
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] ${pending ? "bg-amber-400 text-amber-950" : "bg-emerald-400 text-emerald-950"}`}
                >
                  {pending || "已核对"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {pageLevelIssueGroups.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-bold text-sm text-amber-950 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                待核对页面（{pageLevelIssueGroups.length} 页）
              </div>
              <p className="text-[11px] text-amber-800 mt-1">
                同一页发现的多个问题已合并；打开一次即可在同一弹窗内全部核对。
              </p>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto mt-3 pb-1">
            {pageLevelIssueGroups.map((group) => {
              const pendingIssue =
                group.issues.find(
                  (issue) =>
                    issue.status === "PENDING" || issue.status === "UNRESOLVED",
                ) || group.issues[0];
              const state = reviewGroupStatus(group);
              return (
                <button
                  key={group.key}
                  onClick={() => openIssueReview(group.account, pendingIssue)}
                  className="min-w-64 max-w-sm text-left bg-white border border-amber-200 rounded-xl p-3 hover:border-amber-400"
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-[10px] font-semibold text-amber-800">
                      {group.account.bankName} · 第{group.pageNumber || "?"}页
                    </span>
                    <span className={`text-[10px] ${statusColor(state)}`}>
                      {statusLabel(state)}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-800 mt-1">
                    本页共 {group.issues.length} 个核对问题
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                    {group.issues.map((issue) => issue.title).join("；")}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {documentAdvisoryGroups.length > 0 && (
        <details className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">
            文件整体提示（不计入必须核对项）
          </summary>
          <div className="mt-2 space-y-2 text-[11px] text-slate-600">
            {documentAdvisoryGroups.flatMap(group => group.issues).map(issue => (
              <p key={issue.id}>{issue.description}</p>
            ))}
          </div>
        </details>
      )}

      {selectedAccount && auditReport && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <AuditCard
            title="平账审计状态"
            value={
              !auditReport.isAuditable
                ? "缺少余额，无法自动平账"
                : auditReport.isBalanced
                  ? "借贷平衡"
                  : `差额 ¥${auditReport.difference.toFixed(2)}`
            }
            alert={!auditReport.isBalanced}
          />
          <AuditCard
            title="账户收入总计"
            value={`¥ ${auditReport.totalIncome.toLocaleString()}`}
          />
          <AuditCard
            title="账户支出总计"
            value={`¥ ${auditReport.totalExpense.toLocaleString()}`}
          />
          <AuditCard
            title="流水时间跨度"
            value={`${selectedAccount.startDate || "待核对"} ～ ${selectedAccount.endDate || "待核对"}`}
          />
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-bold">
                全部账户交易明细（{transactions.length} 笔）
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                正常记录与问题记录统一列示；点击任意一行可展开核对原因。
              </p>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索账户、对手方、金额、附言"
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border w-64"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ["ALL", "全部", transactions.length],
                ["PENDING", "待核对", statusCounts.PENDING],
                ["VERIFIED", "已确认", statusCounts.VERIFIED],
                ["CORRECTED", "已修正", statusCounts.CORRECTED],
                ["AUTO", "自动通过", statusCounts.AUTO],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setTransactionFilter(value)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-medium border ${transactionFilter === value ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600"}`}
              >
                {label} {count}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-rose-200" />
              待核对
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-blue-200" />
              已修正
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-emerald-200" />
              已确认
            </span>
            <span className="flex items-center gap-1">
              <i className="w-2.5 h-2.5 rounded-sm bg-white border" />
              自动通过
            </span>
          </div>
        </div>
        <div className="overflow-auto max-h-[560px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="p-3">序号</th>
                <th className="p-3">账户</th>
                <th className="p-3">交易时间</th>
                <th className="p-3">方向</th>
                <th className="p-3">金额</th>
                <th className="p-3">余额</th>
                <th className="p-3">对手方</th>
                <th className="p-3">摘要</th>
                <th className="p-3">原件位置</th>
                <th className="p-3">核对状态</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {displayedTransactions.map((transaction, index) => {
                const transactionIssues =
                  issuesByTransaction.get(transaction.id) || [];
                const state = transactionReviewState(
                  transaction,
                  transactionIssues,
                );
                const expanded = expandedTransactionId === transaction.id;
                return (
                  <React.Fragment key={transaction.id}>
                    <tr
                      onClick={() =>
                        setExpandedTransactionId(expanded ? "" : transaction.id)
                      }
                      className={`cursor-pointer transition ${rowBackground(state)}`}
                    >
                      <td
                        className={`p-3 text-slate-400 border-l-4 ${rowBorder(state)}`}
                      >
                        {index + 1}
                      </td>
                      <td className="p-3">
                        <div className="font-medium">
                          {transaction.bankName}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          尾号 {transaction.accountNumber.slice(-4)}
                        </div>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {transaction.transactionTime || "待核对"}
                      </td>
                      <td
                        className={`p-3 font-semibold ${transaction.direction === "IN" ? "text-emerald-700" : transaction.direction === "OUT" ? "text-rose-700" : "text-amber-700"}`}
                      >
                        {transaction.direction === "IN" ? "收入" : transaction.direction === "OUT" ? "支出" : "待核对"}
                      </td>
                      <td className="p-3 font-mono">
                        ¥{transaction.amount.toLocaleString()}
                      </td>
                      <td className="p-3 font-mono">
                        {transaction.balanceAvailable === false
                          ? "—"
                          : `¥${transaction.balance.toLocaleString()}`}
                      </td>
                      <td className="p-3">{transaction.counterpartyName}</td>
                      <td className="p-3 max-w-44 truncate">
                        {transaction.summary}
                      </td>
                      <td className="p-3 text-blue-600">
                        <span className="inline-flex items-center gap-1">
                          <Eye className="w-3.5 h-3.5" />第
                          {transaction.rawPageNumber || "?"}页
                        </span>
                      </td>
                      <td className="p-3 text-[11px] font-medium">
                        {transactionStateLabel(state)}
                      </td>
                      <td className="p-3">
                        {expanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={11} className="p-0">
                          <div className="px-6 py-4 bg-slate-50 border-l-4 border-blue-400 flex items-start justify-between gap-4">
                            <div className="space-y-2">
                              <div className="font-semibold text-xs text-slate-800">
                                {transactionIssues.length
                                  ? `该笔涉及 ${transactionIssues.length} 项核对问题`
                                  : "自动检查未发现明确问题"}
                              </div>
                              {transactionIssues.length ? (
                                <ul className="space-y-1">
                                  {transactionIssues.map((issue) => (
                                    <li
                                      key={issue.id}
                                      className="text-[11px] text-slate-600"
                                    >
                                      • {issue.title}：{issue.description}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-[11px] text-slate-500">
                                  仍可抽查原始页面；自动通过不代表交易用途或法律事实已经证实。
                                </p>
                              )}
                              {transaction.rawText && (
                                <p className="text-[11px] text-slate-500">
                                  识别原文：{transaction.rawText}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                openTransactionReview(
                                  transaction,
                                  transactionIssues.find(
                                    (issue) =>
                                      issue.status === "PENDING" ||
                                      issue.status === "UNRESOLVED",
                                  ) || transactionIssues[0],
                                );
                              }}
                              className="flex-shrink-0 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-medium"
                            >
                              查看原件并处理
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {!displayedTransactions.length && (
            <div className="py-12 text-center text-sm text-slate-500">
              当前筛选条件下没有交易记录。
            </div>
          )}
        </div>
        <div className="p-4 bg-slate-50 border-t flex justify-between items-center">
          <button
            onClick={onPrev}
            className="flex items-center gap-1.5 px-4 py-2 text-slate-600 text-xs"
          >
            <ArrowLeft className="w-4 h-4" />
            返回上传
          </button>
          <div className="flex items-center gap-3">
            {pendingReviewGroups.length > 0 && (
              <span className="text-xs text-amber-700 flex items-center gap-1">
                <CircleHelp className="w-4 h-4" />
                全部账户仍有 {pendingReviewGroups.length} 页待核对
              </span>
            )}
            <button
              onClick={continueToNext}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium"
            >
              <Check className="w-4 h-4" />
              {pendingReviewGroups.length
                ? "保留未核对页并继续"
                : "完成核对，进入下一步"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {isReviewOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm p-3 sm:p-6 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[1380px] max-h-[94vh] overflow-hidden">
            <div className="h-14 px-5 border-b flex items-center justify-between gap-3">
              <div>
                <div className="font-bold text-sm text-slate-900">
                  原始文件核对
                </div>
                <div className="text-[11px] text-slate-500">
                  {selectedAccount?.fileName} · 第{" "}
                  {selectedIssue?.pageNumber ||
                    selectedTransaction?.rawPageNumber ||
                    1}{" "}
                  页
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedIssue && (
                  <>
                    <span className="text-[11px] text-slate-500">
                      还有 {pendingReviewCount} 页待核对
                    </span>
                    <button
                      onClick={() => navigatePendingIssue(-1)}
                      className="px-3 py-1.5 rounded-lg border text-xs text-slate-600 hover:bg-slate-50"
                    >
                      上一页
                    </button>
                    <button
                      onClick={() => navigatePendingIssue(1)}
                      className="px-3 py-1.5 rounded-lg border text-xs text-slate-600 hover:bg-slate-50"
                    >
                      下一待核对页
                    </button>
                  </>
                )}
                <button
                  onClick={() => setIsReviewOpen(false)}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(520px,1fr)_410px] max-h-[calc(94vh-56px)] overflow-hidden">
              <section className="relative min-w-0">
                {isSourceLoading ? (
                  <div className="h-[620px] flex items-center justify-center text-sm text-slate-500">
                    正在打开原始文件…
                  </div>
                ) : (
                  <PdfEvidencePage
                    file={sourceFile}
                    pageNumber={
                      selectedIssue?.pageNumber ||
                      selectedTransaction?.rawPageNumber ||
                      affectedTransactions[0]?.rawPageNumber ||
                      1
                    }
                  />
                )}
              </section>
              <section className="border-l border-slate-200 p-4 overflow-y-auto max-h-[calc(94vh-56px)]">
                {!selectedIssue ? (
                  selectedTransaction ? (
                    <NormalTransactionPanel
                      transaction={selectedTransaction}
                      onEdit={handleCellEdit}
                    />
                  ) : (
                    <div className="text-center text-sm text-slate-500 py-16">
                      请选择一笔交易或页面问题。
                    </div>
                  )
                ) : (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="w-4 h-4 text-amber-600" />
                        <h3 className="font-bold text-sm text-slate-900">
                          本页共 {selectedIssueGroup.length} 个核对问题
                        </h3>
                      </div>
                      <div className="mt-2 space-y-2">
                        {selectedIssueGroup.map((issue, index) => (
                          <div
                            key={issue.id}
                            className="border border-slate-200 rounded-xl p-3"
                          >
                            <div className="text-xs font-semibold text-slate-800">
                              {index + 1}. {issue.title}
                            </div>
                            <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                              {issue.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                    {selectedCountComparison && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
                        <div className="font-semibold">
                          这两个数字都不是“已核实数量”
                        </div>
                        <p className="mt-1 leading-relaxed">
                          {selectedCountComparison.summaryCount}{" "}
                          笔是一次页面计数，
                          {selectedCountComparison.detailCount}{" "}
                          笔是逐笔提取结果。请直接清点左侧原始页面，以原件实际行数为准。
                        </p>
                      </div>
                    )}
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                      <div className="text-xs font-semibold text-blue-900">
                        本页请统一核对
                      </div>
                      <ol className="list-decimal pl-4 mt-2 space-y-1 text-[11px] text-blue-800">
                        {[
                          ...new Set(
                            selectedIssueGroup.flatMap(
                              (issue) => issue.instructions,
                            ),
                          ),
                        ].map((instruction, index) => (
                          <li key={index}>{instruction}</li>
                        ))}
                      </ol>
                    </div>
                    {!selectedIssueHasLocation ? (
                      <>
                        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-800">
                          <div className="font-semibold">
                            暂时无法列出对应明细
                          </div>
                          <p className="mt-1 leading-relaxed">
                            这条历史核对记录缺少原件页码，无法安全判断应展示哪一页的交易。请返回上传步骤重新选择原始
                            PDF，系统会重新建立逐页定位后再核对。
                          </p>
                        </div>
                        <button
                          onClick={() =>
                            resolveIssueAndAdvance(
                              selectedIssue,
                              "UNRESOLVED",
                              "历史核对记录缺少原件页码，暂时无法定位",
                            )
                          }
                          className="w-full border border-amber-300 text-amber-800 rounded-xl py-2 text-xs font-medium"
                        >
                          暂记为无法定位，进入下一项
                        </button>
                      </>
                    ) : (
                      <>
                        {selectedIssueGroup.every(isTransactionLevelIssue) ? (
                          affectedTransactions
                            .slice(0, 3)
                            .map((transaction) => (
                              <TransactionEditor
                                key={transaction.id}
                                transaction={transaction}
                                onEdit={handleCellEdit}
                              />
                            ))
                        ) : (
                          <PageTransactionSelector
                            transactions={affectedTransactions}
                            selectedIds={selectedRemovalIds}
                            onToggle={(id) =>
                              setSelectedRemovalIds((current) =>
                                current.includes(id)
                                  ? current.filter((item) => item !== id)
                                  : [...current, id],
                              )
                            }
                          />
                        )}
                        {selectedRemovalIds.length > 0 && (
                          <button
                            onClick={removeSelectedTransactions}
                            className="w-full border border-rose-300 bg-rose-50 text-rose-700 rounded-xl py-2 text-xs font-medium"
                          >
                            删除选中的 {selectedRemovalIds.length} 笔多余记录
                          </button>
                        )}
                        <button
                          onClick={() => setShowAddForm((value) => !value)}
                          className="w-full flex items-center justify-center gap-1.5 border border-blue-200 text-blue-700 rounded-xl py-2 text-xs font-medium hover:bg-blue-50"
                        >
                          <FilePlus2 className="w-4 h-4" />
                          补录遗漏交易
                        </button>
                        {showAddForm && (
                          <MissingTransactionForm
                            draft={draft}
                            onChange={setDraft}
                            onSave={addMissingTransaction}
                          />
                        )}
                        <label className="block text-xs text-slate-600">
                          核对说明
                          <textarea
                            value={resolutionNote}
                            onChange={(event) =>
                              setResolutionNote(event.target.value)
                            }
                            placeholder="可记录原件实际笔数、删除或补录内容"
                            className="mt-1 w-full min-h-16 border rounded-xl p-2 text-xs"
                          />
                        </label>
                        <div className="grid grid-cols-1 gap-2">
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "CONFIRMED",
                                selectedCountComparison
                                  ? `已清点原件，确认实际为 ${selectedCountComparison.detailCount} 笔并保留全部明细`
                                  : "已对照原件确认本页记录正确",
                              )
                            }
                            className="bg-emerald-600 text-white rounded-xl py-2 text-xs font-medium"
                          >
                            {selectedCountComparison
                              ? `原件确有 ${selectedCountComparison.detailCount} 笔，本页全部确认`
                              : "与原件一致，本页全部确认"}
                          </button>
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "CORRECTED",
                                "已根据原件完成本页全部修正",
                              )
                            }
                            className="bg-blue-600 text-white rounded-xl py-2 text-xs font-medium"
                          >
                            本页已完成修正
                          </button>
                          <button
                            onClick={() =>
                              resolveIssueAndAdvance(
                                selectedIssue,
                                "UNRESOLVED",
                                "原件不清晰或证据不足，暂时无法确认",
                              )
                            }
                            className="border border-amber-300 text-amber-800 rounded-xl py-2 text-xs font-medium"
                          >
                            原件不清晰／无法确认
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const TransactionEditor: React.FC<{
  transaction: StandardTransaction;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
}> = ({ transaction, onEdit }) => (
  <div className="border border-slate-200 rounded-xl p-3 text-xs space-y-2">
    <div className="font-semibold text-slate-800">
      第 {transaction.rawRowIndex || "?"} 笔 · {transaction.transactionTime}
    </div>
    <label className="block text-[11px] text-slate-500">
      日期时间
      <input
        value={transaction.transactionTime}
        onChange={(event) =>
          onEdit(transaction.id, "transactionTime", event.target.value)
        }
        className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
      />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-[11px] text-slate-500">
        收支方向
        <select
          value={transaction.direction}
          onChange={(event) =>
            onEdit(transaction.id, "direction", event.target.value)
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        >
          <option value="IN">收入</option>
          <option value="OUT">支出</option>
          <option value="UNKNOWN">待核对</option>
        </select>
      </label>
      <label className="text-[11px] text-slate-500">
        金额
        <input
          type="number"
          value={transaction.amount}
          onChange={(event) =>
            onEdit(transaction.id, "amount", Number(event.target.value))
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
      <label className="text-[11px] text-slate-500">
        交易后余额
        <input
          type="number"
          value={transaction.balance}
          onChange={(event) =>
            onEdit(transaction.id, "balance", Number(event.target.value))
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
      <label className="text-[11px] text-slate-500">
        对手方
        <input
          value={transaction.counterpartyName}
          onChange={(event) =>
            onEdit(transaction.id, "counterpartyName", event.target.value)
          }
          className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
    </div>
    <label className="block text-[11px] text-slate-500">
      摘要
      <input
        value={transaction.summary}
        onChange={(event) =>
          onEdit(transaction.id, "summary", event.target.value)
        }
        className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs text-slate-800"
      />
    </label>
    {transaction.rawText && (
      <div className="bg-slate-50 p-2 rounded text-[11px] text-slate-600">
        识别原文：{transaction.rawText}
      </div>
    )}
  </div>
);

const NormalTransactionPanel: React.FC<{
  transaction: StandardTransaction;
  onEdit: (id: string, field: keyof StandardTransaction, value: any) => void;
}> = ({ transaction, onEdit }) => (
  <div className="space-y-4">
    <div className="flex items-center gap-2">
      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
      <div>
        <h3 className="font-bold text-sm text-slate-900">
          自动检查未发现明确问题
        </h3>
        <p className="text-[11px] text-slate-500 mt-1">
          仍可对照左侧原件抽查；这不代表交易用途或法律事实已经证实。
        </p>
      </div>
    </div>
    <TransactionEditor transaction={transaction} onEdit={onEdit} />
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-800">
      如果抽查发现错误，直接修改字段即可，系统会将该笔标记为“已修正”。
    </div>
  </div>
);

const PageTransactionSelector: React.FC<{
  transactions: StandardTransaction[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}> = ({ transactions, selectedIds, onToggle }) => (
  <div className="border border-slate-200 rounded-xl overflow-hidden">
    <div className="px-3 py-2 bg-slate-50 border-b flex justify-between text-[11px]">
      <span className="font-semibold text-slate-700">
        当前已提取 {transactions.length} 条逐笔明细
      </span>
      <span className="text-slate-500">仅勾选重复或误识别项</span>
    </div>
    <div className="max-h-72 overflow-y-auto divide-y">
      {transactions.map((transaction, index) => (
        <label
          key={transaction.id}
          className={`flex items-center gap-2 px-3 py-2 text-[11px] cursor-pointer ${selectedIds.includes(transaction.id) ? "bg-rose-50" : "bg-white hover:bg-slate-50"}`}
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(transaction.id)}
            onChange={() => onToggle(transaction.id)}
          />
          <span className="w-6 text-slate-400">{index + 1}</span>
          <span className="w-20 text-slate-600 truncate">
            {transaction.transactionTime.slice(0, 10)}
          </span>
          <span
            className={`w-12 font-medium ${transaction.direction === "IN" ? "text-emerald-700" : transaction.direction === "OUT" ? "text-rose-700" : "text-amber-700"}`}
          >
            {transaction.direction === "IN" ? "收入" : transaction.direction === "OUT" ? "支出" : "待核"}
          </span>
          <span className="w-24 text-right font-mono">
            ¥{transaction.amount.toLocaleString()}
          </span>
          <span className="flex-1 truncate text-slate-600">
            {transaction.counterpartyName ||
              transaction.summary ||
              "无对手方信息"}
          </span>
        </label>
      ))}
    </div>
  </div>
);

const MissingTransactionForm: React.FC<{
  draft: MissingTransactionDraft;
  onChange: (draft: MissingTransactionDraft) => void;
  onSave: () => void;
}> = ({ draft, onChange, onSave }) => (
  <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-3 space-y-2">
    <div className="text-xs font-semibold">根据原件补录</div>
    <input
      placeholder="日期时间，如 2023-08-09"
      value={draft.transactionTime}
      onChange={(event) =>
        onChange({ ...draft, transactionTime: event.target.value })
      }
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <div className="grid grid-cols-2 gap-2">
      <select
        value={draft.direction}
        onChange={(event) =>
          onChange({ ...draft, direction: event.target.value as "IN" | "OUT" })
        }
        className="border rounded-lg px-2 py-1.5 text-xs"
      >
        <option value="IN">收入</option>
        <option value="OUT">支出</option>
      </select>
      <input
        type="number"
        placeholder="金额"
        value={draft.amount}
        onChange={(event) => onChange({ ...draft, amount: event.target.value })}
        className="border rounded-lg px-2 py-1.5 text-xs"
      />
    </div>
    <input
      type="number"
      placeholder="交易后余额（可不填）"
      value={draft.balance}
      onChange={(event) => onChange({ ...draft, balance: event.target.value })}
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <input
      placeholder="对手方"
      value={draft.counterpartyName}
      onChange={(event) =>
        onChange({ ...draft, counterpartyName: event.target.value })
      }
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <input
      placeholder="摘要／附言"
      value={draft.summary}
      onChange={(event) => onChange({ ...draft, summary: event.target.value })}
      className="w-full border rounded-lg px-2 py-1.5 text-xs"
    />
    <button
      onClick={onSave}
      className="w-full bg-blue-600 text-white rounded-lg py-2 text-xs font-medium"
    >
      保存补录
    </button>
  </div>
);

const AuditCard: React.FC<{
  title: string;
  value: string;
  alert?: boolean;
}> = ({ title, value, alert }) => (
  <div className="bg-white rounded-xl border border-slate-200 p-4">
    <div className="text-xs text-slate-400">{title}</div>
    <div
      className={`mt-1 text-sm font-bold ${alert ? "text-rose-700" : "text-slate-800"}`}
    >
      {alert && <AlertTriangle className="w-4 h-4 inline mr-1" />}
      {value}
    </div>
  </div>
);

function statusLabel(status: ReviewIssueStatus): string {
  return status === "CONFIRMED"
    ? "已确认"
    : status === "CORRECTED"
      ? "已修正"
      : status === "UNRESOLVED"
        ? "无法确认"
        : "未核对";
}
function statusColor(status: ReviewIssueStatus): string {
  return status === "CONFIRMED"
    ? "text-emerald-700"
    : status === "CORRECTED"
      ? "text-blue-700"
      : status === "UNRESOLVED"
        ? "text-amber-700"
        : "text-rose-700";
}

type TransactionReviewState = "PENDING" | "VERIFIED" | "CORRECTED" | "AUTO";

function transactionReviewState(
  transaction: StandardTransaction,
  issues: EvidenceReviewIssue[],
): TransactionReviewState {
  if (
    issues.some(
      (issue) => issue.status === "PENDING" || issue.status === "UNRESOLVED",
    ) ||
    transaction.reviewStatus === "PENDING"
  )
    return "PENDING";
  if (
    transaction.reviewStatus === "CORRECTED" ||
    issues.some((issue) => issue.status === "CORRECTED")
  )
    return "CORRECTED";
  if (
    transaction.reviewStatus === "VERIFIED" ||
    (issues.length > 0 && issues.every((issue) => issue.status === "CONFIRMED"))
  )
    return "VERIFIED";
  return "AUTO";
}

function isTransactionLevelIssue(issue: EvidenceReviewIssue): boolean {
  return (
    issue.category === "LOW_CONFIDENCE" ||
    issue.category === "BALANCE_BREAK" ||
    issue.category === "INVALID_AMOUNT"
  );
}

function isOutstandingRequired(issue: EvidenceReviewIssue): boolean {
  return issue.severity === "REQUIRED"
    && (issue.status === "PENDING" || issue.status === "UNRESOLVED");
}

function issueCountComparison(
  issue: EvidenceReviewIssue,
): { summaryCount: number; detailCount: number } | undefined {
  const match =
    issue.description.match(
      /页面计数为\s*(\d+)\s*笔，逐笔提取为\s*(\d+)\s*笔/,
    ) || issue.title.match(/计数不一致（(\d+)\s*\/\s*(\d+)）/);
  return match
    ? { summaryCount: Number(match[1]), detailCount: Number(match[2]) }
    : undefined;
}

function sameReviewPage(
  left: EvidenceReviewIssue,
  right: EvidenceReviewIssue,
): boolean {
  return left.pageNumber && right.pageNumber
    ? left.pageNumber === right.pageNumber
    : left.id === right.id;
}

function buildReviewGroups(
  accounts: BankAccount[],
  transactions: StandardTransaction[],
): EvidenceReviewGroup[] {
  const groups = new Map<string, EvidenceReviewGroup>();
  for (const account of accounts) {
    for (const issue of buildEvidenceReviewIssues(account, transactions)) {
      const key = `${accountIdentityKey(account)}|${issue.pageNumber ? `page:${issue.pageNumber}` : `issue:${issue.id}`}`;
      const existing = groups.get(key);
      if (existing) existing.issues.push(issue);
      else
        groups.set(key, {
          key,
          account,
          pageNumber: issue.pageNumber,
          issues: [issue],
        });
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      accountIdentityKey(left.account).localeCompare(
        accountIdentityKey(right.account),
      ) ||
      (left.pageNumber || Number.MAX_SAFE_INTEGER) -
        (right.pageNumber || Number.MAX_SAFE_INTEGER),
  );
}

function reviewGroupStatus(group: EvidenceReviewGroup): ReviewIssueStatus {
  if (group.issues.some((issue) => issue.status === "PENDING"))
    return "PENDING";
  if (group.issues.some((issue) => issue.status === "UNRESOLVED"))
    return "UNRESOLVED";
  if (group.issues.some((issue) => issue.status === "CORRECTED"))
    return "CORRECTED";
  return "CONFIRMED";
}

function transactionStateLabel(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "待核对"
    : state === "CORRECTED"
      ? "已修正"
      : state === "VERIFIED"
        ? "已确认"
        : "自动通过";
}

function rowBackground(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "bg-rose-50/70 hover:bg-rose-100/70"
    : state === "CORRECTED"
      ? "bg-blue-50/60 hover:bg-blue-100/60"
      : state === "VERIFIED"
        ? "bg-emerald-50/50 hover:bg-emerald-100/60"
        : "bg-white hover:bg-slate-50";
}

function rowBorder(state: TransactionReviewState): string {
  return state === "PENDING"
    ? "border-rose-400"
    : state === "CORRECTED"
      ? "border-blue-400"
      : state === "VERIFIED"
        ? "border-emerald-400"
        : "border-transparent";
}

function summarizeAccount(
  account: BankAccount,
  allTransactions: StandardTransaction[],
): BankAccount {
  const accountTransactions = allTransactions.filter((transaction) =>
    transactionBelongsToAccount(transaction, account),
  );
  const dates = accountTransactions
    .map((transaction) => transaction.transactionDate)
    .filter(Boolean)
    .sort();
  return {
    ...account,
    transactionCount: accountTransactions.length,
    totalIn: accountTransactions
      .filter((transaction) => transaction.direction === "IN")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
    totalOut: accountTransactions
      .filter((transaction) => transaction.direction === "OUT")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
    startDate: dates[0] || account.startDate,
    endDate: dates[dates.length - 1] || account.endDate,
  };
}
