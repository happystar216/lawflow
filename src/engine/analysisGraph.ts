import { CaseAnalysisGraph, AnalysisCounterpartyEntity } from '../types/analysis';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, transactionBelongsToAccount } from '../utils/accountIdentity';
import { effectiveCounterpartyName, isJudicialDeduction } from './bilateral';

function entityKey(prefix: string, value: string): string {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 16777619);
    right ^= code + index;
    right = Math.imul(right, 3266489909);
  }
  return `${prefix}_${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildCaseAnalysisGraph(
  accounts: BankAccount[],
  transactions: StandardTransaction[]
): CaseAnalysisGraph {
  const accountEntities = accounts.map(account => {
    const id = entityKey('account', accountIdentityKey(account));
    return {
      id,
      kind: 'ACCOUNT' as const,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      bankName: account.bankName,
      sourceDocumentId: account.sourceDocumentId,
      transactionIds: transactions.filter(transaction => transactionBelongsToAccount(transaction, account)).map(transaction => transaction.id)
    };
  });
  const accountEntityById = new Map(accountEntities.map(entity => [entity.id, entity]));
  const accountIdByTransaction = new Map<string, string>();
  for (const transaction of transactions) {
    const account = accounts.find(candidate => transactionBelongsToAccount(transaction, candidate));
    const fallbackKey = `${transaction.sourceDocumentId || transaction.rawSourceFile}|${transaction.bankName}|${transaction.accountNumber}`;
    const accountEntityId = account
      ? entityKey('account', accountIdentityKey(account))
      : entityKey('account', fallbackKey);
    accountIdByTransaction.set(transaction.id, accountEntityId);
    if (!accountEntityById.has(accountEntityId)) {
      const fallbackEntity = {
        id: accountEntityId,
        kind: 'ACCOUNT' as const,
        accountNumber: transaction.accountNumber,
        accountName: transaction.accountName,
        bankName: transaction.bankName,
        sourceDocumentId: transaction.sourceDocumentId,
        transactionIds: [transaction.id]
      };
      accountEntities.push(fallbackEntity);
      accountEntityById.set(accountEntityId, fallbackEntity);
    }
  }

  const counterparties = new Map<string, AnalysisCounterpartyEntity>();
  for (const transaction of transactions.filter(item => !item.isInternalTransfer)) {
    const name = effectiveCounterpartyName(transaction);
    const key = `${transaction.counterpartyAccount || ''}|${name}`;
    const id = entityKey('counterparty', key);
    const entity = counterparties.get(id) || {
      id,
      kind: 'COUNTERPARTY' as const,
      name,
      account: transaction.counterpartyAccount,
      transactionIds: [],
      incomingTransactionIds: [],
      outgoingTransactionIds: []
    };
    entity.transactionIds.push(transaction.id);
    if (transaction.direction === 'IN') entity.incomingTransactionIds.push(transaction.id);
    if (transaction.direction === 'OUT') entity.outgoingTransactionIds.push(transaction.id);
    counterparties.set(id, entity);
  }

  const relationships: CaseAnalysisGraph['relationships'] = [];
  for (const transaction of transactions) {
    const transactionEntityId = `transaction_${transaction.id}`;
    const accountEntityId = accountIdByTransaction.get(transaction.id)!;
    relationships.push({
      id: `account_tx_${transaction.id}`,
      type: 'ACCOUNT_HAS_TRANSACTION',
      fromEntityId: accountEntityId,
      toEntityId: transactionEntityId,
      transactionIds: [transaction.id],
      amount: transaction.amount
    });
    if (!transaction.isInternalTransfer) {
      const counterpartyName = effectiveCounterpartyName(transaction);
      const counterpartyId = entityKey('counterparty', `${transaction.counterpartyAccount || ''}|${counterpartyName}`);
      relationships.push({
        id: `tx_counterparty_${transaction.id}`,
        type: 'TRANSACTION_WITH_COUNTERPARTY',
        fromEntityId: transactionEntityId,
        toEntityId: counterpartyId,
        transactionIds: [transaction.id],
        amount: transaction.amount
      });
    }
    if (transaction.internalTransferPairId && transaction.id < transaction.internalTransferPairId) {
      relationships.push({
        id: `internal_${transaction.id}_${transaction.internalTransferPairId}`,
        type: 'INTERNAL_TRANSFER_PAIR',
        fromEntityId: transactionEntityId,
        toEntityId: `transaction_${transaction.internalTransferPairId}`,
        transactionIds: [transaction.id, transaction.internalTransferPairId],
        amount: transaction.amount
      });
    }
  }

  const judicialDeductions = transactions.filter(isJudicialDeduction).map(transaction => {
    const accountEntityId = accountIdByTransaction.get(transaction.id)!;
    const authorityName = effectiveCounterpartyName(transaction);
    const authorityEntityId = entityKey('counterparty', `${transaction.counterpartyAccount || ''}|${authorityName}`);
    const id = `judicial_${transaction.id}`;
    relationships.push({ id: `${id}_account`, type: 'JUDICIAL_DEDUCTION_FROM_ACCOUNT', fromEntityId: accountEntityId, toEntityId: id, transactionIds: [transaction.id], amount: transaction.amount });
    relationships.push({ id: `${id}_authority`, type: 'JUDICIAL_DEDUCTION_TO_AUTHORITY', fromEntityId: id, toEntityId: authorityEntityId, transactionIds: [transaction.id], amount: transaction.amount });
    return {
      id,
      kind: 'JUDICIAL_DEDUCTION' as const,
      transactionId: transaction.id,
      accountEntityId,
      authorityEntityId,
      amount: transaction.amount,
      transactionTime: transaction.transactionTime,
      summary: transaction.summary
    };
  });

  return {
    accounts: accountEntities,
    transactions: transactions.map(transaction => ({
      id: `transaction_${transaction.id}`,
      kind: 'TRANSACTION' as const,
      transactionId: transaction.id,
      accountEntityId: accountIdByTransaction.get(transaction.id)!,
      direction: transaction.direction,
      amount: transaction.amount,
      transactionTime: transaction.transactionTime,
      isInternalTransfer: Boolean(transaction.isInternalTransfer)
    })),
    counterparties: [...counterparties.values()],
    judicialDeductions,
    relationships
  };
}
