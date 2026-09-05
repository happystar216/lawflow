# Real PDF regression datasets

Real-case datasets are generated under `test-data/private/` and are intentionally ignored by Git because they contain personal and banking information.

Each dataset contains:

- `manifest.json`: immutable source fingerprint and build settings.
- `pages/`: stable page images used for visual comparison.
- `raw-pages/`: one resumable recognition result per source page.
- `benchmark.json`: consolidated accounts and transactions.
- `review-queue.json`: page-level discrepancies that still require source review.
- `summary.json`: compact counts suitable for automated regression checks.

Build or resume the Hu Yanhong dataset with:

```bash
npx tsx scripts/buildRealPdfBenchmark.ts \
  "/Users/happy/Downloads/胡艳红流水合并.pdf" \
  "test-data/private/hu-yanhong"
```

This generated dataset is a benchmark draft until every queued page has been checked against its page image. Do not treat an unreviewed machine extraction as legal ground truth.

The Hu Yanhong dataset records verified page-type, count and cross-page facts in `benchmark.json > verification.knownFacts`. They are the minimum non-regression contract; pages in `review-queue.json` remain source-review candidates rather than asserted ground truth.
