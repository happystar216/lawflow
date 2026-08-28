#!/bin/bash
set -e

echo "========================================================"
echo "  LawFlow PaddleOCR 后端一键部署到 Hugging Face Spaces"
echo "========================================================"

if [ -z "$1" ]; then
  echo "使用方法: ./deploy-hf.sh <你的HuggingFace用户名>/<你的Space名称>"
  echo "例如:     ./deploy-hf.sh happystar/lawflow-ocr"
  echo ""
  echo "步骤说明:"
  echo "1. 打开 https://huggingface.co/new-space 创建一个 Space"
  echo "   - SDK 选择: Docker"
  echo "   - 硬件选择: Free 16GB RAM"
  echo "2. 运行本脚本并输入 Space 路径"
  exit 1
fi

SPACE_REPO="$1"
TEMP_DIR=$(mktemp -d)

echo ">>> 正在准备部署包到临时目录: $TEMP_DIR"
cp Dockerfile requirements.txt README.md app.py "$TEMP_DIR/"

cd "$TEMP_DIR"
git init
git config user.name "LawFlow Deployer"
git config user.email "deploy@lawflow.ai"
git add .
git commit -m "feat: deploy Baidu PaddleOCR backend for LawFlow"
git branch -M main

echo ">>> 正在推送到 Hugging Face Space: $SPACE_REPO"
echo "提示: 如果提示输入密码，请输入你的 Hugging Face Access Token (带 Write 权限):"
echo "获取 Token 地址: https://huggingface.co/settings/tokens"

git remote add origin "https://huggingface.co/spaces/$SPACE_REPO.git"
git push -u origin main --force

echo ""
echo "========================================================"
echo "✨ 部署推送完成！"
echo "Hugging Face 正在自动构建 Docker 镜像 (约需 1~2 分钟)..."
echo "你的专属 PaddleOCR API 地址为:"
echo "https://${SPACE_REPO/\//-}.hf.space/api/parse-bank-statement"
echo "========================================================"
