#!/usr/bin/env python3
"""EastGenesis · 各平台应用图标生成

输入：assets/brand/icons/icon-1024.png（由 extract_brand_assets.py 生成）
输出：src-tauri/icons/（Tauri 标准文件名）

按顺序尝试：
  1. 本机 `tauri` 可执行文件
  2. `cargo tauri`
  3. `npx --yes @tauri-apps/cli@2.5.0`（固定版本，需要网络，会临时下载 CLI）
  4. Pillow 兜底：按 `tauri icon` 的文件名与尺寸生成 PNG / ICO / ICNS / Windows 磁贴
外部命令一律以参数列表执行，不经过 shell。
执行记录写入 assets/brand/platform-icons.json，供校验脚本和报告使用。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC_REL = "assets/brand/icons/icon-1024.png"
OUT_REL = "src-tauri/icons"
SRC, OUT = ROOT / SRC_REL, ROOT / OUT_REL
RECORD = ROOT / "assets" / "brand" / "platform-icons.json"
TAURI_CLI = "@tauri-apps/cli@2.5.0"  # 固定版本，避免浮动依赖

# tauri icon（v2）的桌面端产物：文件名 -> 边长
PNGS = {"32x32.png": 32, "64x64.png": 64, "128x128.png": 128,
        "128x128@2x.png": 256, "icon.png": 512}
APPX = {f"Square{s}x{s}Logo.png": s for s in (30, 44, 71, 89, 107, 142, 150, 284, 310)}
APPX["StoreLogo.png"] = 50
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZES = (32, 64, 128, 256, 512)  # 1024 层直接用主图


# 命令输出里可能出现的本机绝对路径（npm 缓存、临时目录等）
ABS_PATH = re.compile(r"(?:/(?:sessions|Users|home|root|tmp|private|var)/|[A-Za-z]:\\Users\\)[^\s'\"]*")


def scrub(text: str) -> str:
    """记录里只保留相对路径：项目根目录换成 .，家目录换成 ~，其余绝对路径打码。"""
    text = text.replace(str(ROOT), ".").replace(str(Path.home()), "~")
    return ABS_PATH.sub("<abs-path>", text)


def run(cmd: list[str]) -> tuple[bool, str]:
    """执行外部命令（参数列表，不经 shell），返回 (成功, 输出尾部)。"""
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, scrub(f"{type(e).__name__}: {e}")
    out = scrub((p.stdout + "\n" + p.stderr).strip())
    return p.returncode == 0, out[-3000:]


def via_cli(attempts: list[dict]) -> str | None:
    """依次尝试 tauri CLI，成功时返回所用方式。"""
    args = ["icon", SRC_REL, "-o", OUT_REL]
    candidates = []
    if shutil.which("tauri"):
        candidates.append(("tauri", ["tauri", *args]))
    if shutil.which("cargo"):
        candidates.append(("cargo tauri", ["cargo", "tauri", *args]))
    if shutil.which("npx"):
        candidates.append((f"npx {TAURI_CLI}", ["npx", "--yes", TAURI_CLI, *args]))
    for label, cmd in candidates:
        ok, out = run(cmd)
        attempts.append({"method": label, "ok": ok, "output": out})
        print(f"[{'成功' if ok else '失败'}] {label}")
        if ok and (OUT / "icon.png").exists():
            return label
    return None


def resized(src: Image.Image, side: int) -> Image.Image:
    return src.resize((side, side), Image.LANCZOS)


def via_pillow(src: Image.Image) -> str:
    """兜底：按 tauri icon 的命名与尺寸生成桌面端图标。"""
    for name, side in {**PNGS, **APPX}.items():
        resized(src, side).save(OUT / name)
    ico = [resized(src, s) for s in ICO_SIZES]
    ico[-1].save(OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES],
                 append_images=ico[:-1])
    try:
        src.save(OUT / "icon.icns", format="ICNS",
                 append_images=[resized(src, s) for s in ICNS_SIZES])
    except Exception as e:  # ICNS 写入能力取决于 Pillow 版本，失败时记录原因
        print(f"[警告] icon.icns 生成失败：{e}")
    return "pillow-fallback"


def inventory() -> list[dict]:
    """列出输出目录中的全部文件及像素尺寸（ICO/ICNS 取最大层）。"""
    files = []
    for p in sorted(OUT.rglob("*")):
        if not p.is_file():
            continue
        size = None
        try:
            with Image.open(p) as im:
                size = list(im.size)
        except Exception:
            pass
        files.append({"file": p.relative_to(ROOT).as_posix(), "size": size})
    return files


def main() -> int:
    if not SRC.exists():
        print(f"缺少 {SRC_REL}，请先运行 extract_brand_assets.py")
        return 1
    with Image.open(SRC) as im:
        src = im.convert("RGBA")
    if src.size != (1024, 1024):
        print(f"{SRC_REL} 尺寸为 {src.size}，应为 1024×1024")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    attempts: list[dict] = []
    method = via_cli(attempts) or via_pillow(src)
    record = {"source": SRC_REL, "output_dir": OUT_REL, "method": method,
              "attempts": attempts, "files": inventory()}
    RECORD.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完成：方式 = {method}，共 {len(record['files'])} 个文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
