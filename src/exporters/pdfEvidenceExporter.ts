import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { saveAs } from 'file-saver';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';

/**
 * Generates an official court-grade Evidence PDF Booklet with evidence badges and highlighting.
 */
export async function exportEvidencePdfBooklet(
  caseMeta: CaseMetadata,
  report: CaseEvaluationReport,
  transactions: StandardTransaction[]
): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const adoptedMatches = report.matches.filter(m => m.lawyerAdopted);
  const txMap = new Map<string, StandardTransaction>();
  transactions.forEach(t => txMap.set(t.id, t));

  // 1. Cover / Summary Page (A4: 595 x 842)
  const page1 = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page1.getSize();

  // Header Banner
  page1.drawRectangle({
    x: 40,
    y: height - 120,
    width: width - 80,
    height: 70,
    color: rgb(0.08, 0.18, 0.36) // Deep Navy
  });

  page1.drawText('LawFlow Evidence Binder', {
    x: 60,
    y: height - 85,
    size: 20,
    font: fontBold,
    color: rgb(1, 1, 1)
  });

  page1.drawText('Execution Bank Statement Evidence Cross-Examination Package', {
    x: 60,
    y: height - 105,
    size: 10,
    font: font,
    color: rgb(0.8, 0.85, 0.95)
  });

  // Case Metadata Card
  page1.drawRectangle({
    x: 40,
    y: height - 280,
    width: width - 80,
    height: 140,
    color: rgb(0.96, 0.97, 0.99),
    borderColor: rgb(0.85, 0.88, 0.92),
    borderWidth: 1
  });

  const caseLines = [
    `Case Number: ${caseMeta.caseNumber || 'N/A'}`,
    `Court: ${caseMeta.courtName || 'N/A'}`,
    `Applicant: ${caseMeta.applicantName || 'N/A'}`,
    `Respondent: ${caseMeta.respondentName || 'N/A'}`,
    `Target Debt: RMB ${(caseMeta.targetAmount || 0).toLocaleString()}`,
    `Execution Date: ${caseMeta.timeline.executionFilingDate || 'N/A'} | Report Order Date: ${caseMeta.timeline.reportOrderServedDate || 'N/A'}`
  ];

  let yPos = height - 160;
  caseLines.forEach(line => {
    page1.drawText(line, {
      x: 60,
      y: yPos,
      size: 10,
      font: fontBold,
      color: rgb(0.15, 0.2, 0.3)
    });
    yPos -= 20;
  });

  // Summary Metrics Box
  page1.drawRectangle({
    x: 40,
    y: height - 420,
    width: width - 80,
    height: 120,
    color: rgb(0.99, 0.96, 0.96),
    borderColor: rgb(0.95, 0.8, 0.8),
    borderWidth: 1
  });

  page1.drawText('Audit & Evidence Summary:', {
    x: 60,
    y: height - 320,
    size: 12,
    font: fontBold,
    color: rgb(0.7, 0.1, 0.1)
  });

  const summaryLines = [
    `* Gross Outflow: RMB ${report.totalRawOut.toLocaleString()} | Internal Transfers Netted: RMB ${report.internalTransferAmount.toLocaleString()}`,
    `* True External Outflow: RMB ${report.netExternalOut.toLocaleString()}`,
    `* Post-Execution Suspected Transfer: RMB ${report.postExecutionTransferAmount.toLocaleString()}`,
    `* Confirmed Income During Execution: RMB ${report.totalIncomeDuringExecution.toLocaleString()} (${(report.solvencyCoverageRate * 100).toFixed(0)}% Solvency Coverage)`,
    `* Total Adopted Evidence Items: ${adoptedMatches.length} items`
  ];

  yPos = height - 340;
  summaryLines.forEach(line => {
    page1.drawText(line, {
      x: 60,
      y: yPos,
      size: 9.5,
      font: font,
      color: rgb(0.2, 0.25, 0.35)
    });
    yPos -= 18;
  });

  // 2. Evidence Detail Cards Pages
  let currentPage = page1;
  let cardY = height - 460;

  for (let i = 0; i < adoptedMatches.length; i++) {
    const match = adoptedMatches[i];
    const firstTx = match.transactionIds.length > 0 ? txMap.get(match.transactionIds[0]) : undefined;
    const pageIndexStr = firstTx?.rawPageNumber ? `Page ${firstTx.rawPageNumber}` : (firstTx?.rawRowIndex ? `Row ${firstTx.rawRowIndex}` : 'Source Doc');

    // Need new page if overflow
    if (cardY < 180) {
      currentPage = pdfDoc.addPage([595.28, 841.89]);
      cardY = height - 60;
    }

    // Evidence Card Box
    currentPage.drawRectangle({
      x: 40,
      y: cardY - 140,
      width: width - 80,
      height: 140,
      color: rgb(1, 1, 1),
      borderColor: match.severity === 'L0' ? rgb(0.85, 0.2, 0.2) : rgb(0.85, 0.55, 0.1),
      borderWidth: 1.5
    });

    // Badge
    currentPage.drawRectangle({
      x: 40,
      y: cardY - 26,
      width: 140,
      height: 26,
      color: match.severity === 'L0' ? rgb(0.85, 0.15, 0.15) : rgb(0.85, 0.5, 0.1)
    });

    currentPage.drawText(`EVIDENCE #${i + 1} [${match.severity}]`, {
      x: 50,
      y: cardY - 18,
      size: 9,
      font: fontBold,
      color: rgb(1, 1, 1)
    });

    // Rule Name & Amount
    currentPage.drawText(`${match.ruleName}  |  RMB ${match.totalAmount.toLocaleString()}`, {
      x: 190,
      y: cardY - 18,
      size: 11,
      font: fontBold,
      color: rgb(0.1, 0.15, 0.25)
    });

    // Info details
    const details = [
      `Phase: ${match.timePhase} | Date: ${firstTx?.transactionDate || 'N/A'} | Location: ${firstTx?.rawSourceFile || 'Statement'} (${pageIndexStr})`,
      `Counterparty: ${match.counterpartyName || 'Cash/ATM'} (${firstTx?.counterpartyRoleTag || 'Verified'})`,
      `Statute: ${match.statutoryBasis[0] || 'Civil Procedure Law'}`,
      `Finding: ${(match.lawyerNotes || match.aiReasoning).slice(0, 100)}...`
    ];

    let detailY = cardY - 45;
    details.forEach(d => {
      currentPage.drawText(d, {
        x: 55,
        y: detailY,
        size: 8.5,
        font: font,
        color: rgb(0.2, 0.25, 0.3)
      });
      detailY -= 18;
    });

    cardY -= 160;
  }

  // Save and download with clean ArrayBuffer conversion
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const fileName = `${caseMeta.respondentName || '被执行人'}_银行流水证据对照册_${new Date().toISOString().slice(0, 10)}.pdf`;
  saveAs(blob, fileName);
}
