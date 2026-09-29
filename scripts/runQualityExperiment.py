"""Compatibility launcher: production web upload is the sole regression path.

The historical provider-specific orchestration remains in Git history.
See docs/recognition-web-pipeline.md. No provider credential is read here.
"""
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    os.execvp('node', ['node', str(root / 'node_modules/tsx/dist/cli.mjs'),
                      str(root / 'scripts/runRecognitionRegression.ts'), *sys.argv[1:]])
