#!/usr/bin/env python3
"""EastGenesis · 品牌资产自检（仅依赖 Pillow + 标准库）

依据 manifest.json / colors.json / platform-icons.json 逐项校验：
原图指纹未变、清单文件齐全、Logo 边缘无截断、字标金色 i 点保留、透明 Logo 无孤立噪点、
图标方正居中、icon-1024 留白且与板上彩色图标一致、启动页素材完整、品牌色偏差、
各平台图标齐全、生成文件中无本机绝对路径。
另生成 assets/brand/verify/contact-sheet.png（每个素材分别叠在浅底和深底上，供目检），
结果写入 assets/brand/verify/report.json。有“失败”项时退出码为 1。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"
OUT = BRAND / "verify"
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail: str = "", warn: bool = False) -> bool:
    status = "通过" if ok else ("警告" if warn else "失败")
    CHECKS.append({"name": name, "status": status, "detail": detail})
    print(f"[{status}] {name}  {detail}")
    return ok


def load_json(rel: str):
    p = ROOT / rel
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def rgba(p: Path) -> Image.Image:
    with Image.open(p) as im:
        return im.convert("RGBA")


def pixels(im: Image.Image):
    """逐像素序列。Pillow 12.3 起 getdata() 已弃用（14 移除），有 get_flattened_data() 时优先用。"""
    f = getattr(im, "get_flattened_data", None)
    return f() if f else im.getdata()


def ring(im: Image.Image) -> list:
    """1px 外圈的全部像素。"""
    w, h = im.size
    px = im.load()
    return ([px[x, y] for x in range(w) for y in (0, h - 1)] +
            [px[x, y] for y in range(1, h - 1) for x in (0, w - 1)])


def dist(a, b) -> float:
    return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5


def hex_rgb(h: str) -> list[int]:
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def check_board(man: dict) -> None:
    h = hashlib.sha256((BRAND / "brand-board.png").read_bytes()).hexdigest()
    check("原图未被修改", h == man["sha256"] == man["sha256_after"], f"SHA-256 {h[:16]}…")


def check_outputs(man: dict) -> None:
    bad = []
    for o in man["outputs"]:
        p = ROOT / o["file"]
        if not p.exists():
            bad.append(f"缺失 {o['file']}")
        elif "size" in o:
            with Image.open(p) as im:
                if list(im.size) != o["size"]:
                    bad.append(f"{o['file']} 尺寸 {im.size} ≠ {o['size']}")
    check("清单文件齐全且尺寸一致", not bad, "; ".join(bad) or f"{len(man['outputs'])} 个文件")
    flags = [m for m in man["log"] if "复核" in m]
    check("区域定位无贴边 / 无兜底", not flags, "; ".join(flags), warn=True)


LOGOS = ["logo-light-transparent", "logo-dark-transparent", "mark-color", "mark-for-dark-bg",
         "wordmark-dark", "wordmark-light", "mark-mono", "mark-mono-white"]


def check_logos() -> None:
    """透明 Logo 外圈应近乎全透明（没被裁断）；带底色的组合外圈应为纯底色。"""
    for n in LOGOS:
        p = BRAND / "logo" / f"{n}.png"
        if not check(f"{n} 存在", p.exists()):
            continue
        im = rgba(p)
        edge = max(c[3] for c in ring(im))
        bb = im.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
        margin = min(bb[0], bb[1], im.width - bb[2], im.height - bb[3]) if bb else -1
        check(f"{n} 边缘完整", edge <= 16 and bb is not None,
              f"外圈最大 alpha {edge}，内容离边 {margin}px")
    for n in ("logo-light", "logo-dark"):
        p = BRAND / "logo" / f"{n}.png"
        if p.exists():
            px = ring(rgba(p))
            med = sorted(px, key=sum)[len(px) // 2]
            dev = max(dist(c, med) for c in px)
            # 深色版底部靠近地平线辉光，外圈本身有渐变，只作警告
            check(f"{n} 外圈为纯底色", dev <= 40, f"外圈最大色差 {dev:.0f}", warn=n == "logo-dark")


def isolated_specks(im: Image.Image) -> int:
    """离实心部分（alpha>=128）3px 以外、alpha 比 5x5 中值高 24 以上的淡像素，即孤立噪点。"""
    a = im.getchannel("A")
    solid = a.point(lambda v: 255 if v >= 128 else 0).filter(ImageFilter.MaxFilter(7))
    med = a.filter(ImageFilter.MedianFilter(5))
    A, M, S = a.load(), med.load(), solid.load()
    return sum(1 for y in range(a.height) for x in range(a.width) if S[x, y] == 0 and A[x, y] - M[x, y] > 24)


def check_logo_quality() -> None:
    """字标 i 上的点是金色，抠图后应保留；深色底抠图不应把夜空星点带成孤立噪点。"""
    for n in ("wordmark-dark", "wordmark-light"):
        p = BRAND / "logo" / f"{n}.png"
        if p.exists():
            k = sum(1 for c in pixels(rgba(p)) if c[3] > 200 and c[1] - c[2] > 80 and c[0] > 180)
            check(f"{n} 金色 i 点", k >= 40, f"不透明金色像素 {k}（下限 40）")
    for n in LOGOS:
        p = BRAND / "logo" / f"{n}.png"
        if p.exists():
            k = isolated_specks(rgba(p))
            check(f"{n} 无孤立噪点", k <= 3, f"孤立淡像素 {k}（上限 3）")


def check_icons(man: dict) -> None:
    """板上图标：正方形、四角透明、中心不透明；各版本字形偏移与彩色版一致。"""
    meas = man["measurements"]
    ref = meas["icon_color"]["glyph"]["offset"]
    check("彩色图标字形接近居中", max(map(abs, ref)) <= 0.06, f"偏移 {ref}", warn=True)
    for v in ("color", "dark", "light", "mono"):
        p = BRAND / "icons" / f"icon-{v}.png"
        if not check(f"icon-{v} 存在", p.exists()):
            continue
        im = rgba(p)
        w, h = im.size
        px = im.load()
        corner = max(px[x, y][3] for x in (0, w - 1) for y in (0, h - 1))
        check(f"icon-{v} 方正、圆角外透明", w == h and corner == 0 and px[w // 2, h // 2][3] == 255,
              f"{w}x{h}，四角 alpha {corner}")
        off = meas[f"icon_{v}"]["glyph"]["offset"]
        dev = max(abs(off[0] - ref[0]), abs(off[1] - ref[1]))
        check(f"icon-{v} 居中", dev <= 0.03,
              f"字形偏移 ({off[0]:+.3f}, {off[1]:+.3f})，彩色版 ({ref[0]:+.3f}, {ref[1]:+.3f})")


def check_master(man: dict) -> None:
    """icon-1024：macOS 网格（四周 100px 透明）；标志中心与比例与板上彩色图标一致。"""
    p = BRAND / "icons" / "icon-1024.png"
    if not check("icon-1024 存在", p.exists()):
        return
    im = rgba(p)
    bb = im.getchannel("A").getbbox()
    check("icon-1024 尺寸与留白", im.size == (1024, 1024) and bb == (100, 100, 924, 924),
          f"{im.size}，不透明区域 {bb}")
    spec = man["measurements"]["icon_master"]
    coef = spec["coef"]  # 底色平面：c = k0 + k1*u + k2*v
    px, side = im.load(), 824
    xs, ys = [], []
    for y in range(100, 924, 2):  # 已知底色平面，与之差异大的像素即标志
        v = (y - 100 + .5) / side
        for x in range(100, 924, 2):
            u = (x - 100 + .5) / side
            body = [max(0, min(255, k[0] + k[1] * u + k[2] * v)) for k in coef]
            c = px[x, y]
            if c[3] == 255 and dist(c, body) > 60:
                xs.append(x)
                ys.append(y)
    if not check("icon-1024 检测到标志", bool(xs)):
        return
    gw = (max(xs) - min(xs) + 2) / side
    dx = ((min(xs) + max(xs) + 2) / 2 - 512) / side
    dy = ((min(ys) + max(ys) + 2) / 2 - 512) / side
    off = spec["offset"]
    check("icon-1024 标志居中", abs(dx - off[0]) <= 0.02 and abs(dy - off[1]) <= 0.02,
          f"偏移 ({dx:+.3f}, {dy:+.3f})，目标 ({off[0]:+.3f}, {off[1]:+.3f})")
    check("icon-1024 标志比例", abs(gw - spec["ratio"]) <= 0.06,
          f"宽度比 {gw:.3f}，目标 {spec['ratio']:.3f}（含辉光，仅供参考）", warn=True)


def check_fidelity(man: dict) -> None:
    """icon-1024 本体缩到板上彩色图标的尺寸，与板上图标逐像素比较（圆角内缩 4px，避开投影）。"""
    meas = man["measurements"]
    sq, rr = meas["icon_sq"], meas["icon_rr"]
    side = sq[2] - sq[0]
    with Image.open(BRAND / "brand-board.png") as b:
        tile = b.convert("RGB").crop(tuple(sq))
    body = rgba(BRAND / "icons" / "icon-1024.png").crop((100, 100, 924, 924)).resize((side, side), Image.LANCZOS)
    keep = Image.new("L", (side, side), 0)
    ImageDraw.Draw(keep).rounded_rectangle((4, 4, side - 5, side - 5), radius=max(0, round(rr * side) - 4), fill=255)
    kp, tp, bp = keep.load(), tile.load(), body.load()
    d = [sum(abs(bp[x, y][i] - tp[x, y][i]) for i in range(3)) / 3
         for y in range(side) for x in range(side) if kp[x, y] == 255]
    mae = sum(d) / len(d)
    check("icon-1024 与板上彩色图标一致", mae <= 25,
          f"缩到 {side}px 后圆角内平均像素差 {mae:.1f}（上限 25；标志取自主视觉、底色为平面拟合，不会完全一致）")


def light_neutral(c) -> bool:
    return min(c[:3]) > 215 and max(c[:3]) - min(c[:3]) < 20


def check_splash(man: dict) -> None:
    """主视觉右/下边界：面板内侧没有浅色底，外侧是浅色底（既没截短，也没吃进浅色区）。"""
    x1, y1 = man["measurements"]["hero_panel"][2:]
    with Image.open(BRAND / "brand-board.png") as im:
        board = im.convert("RGB")
    px, m = board.load(), 12  # 跳过两端，容忍面板圆角
    inner = [px[x1 - 1, y] for y in range(m, y1 - m, 4)] + [px[x, y1 - 1] for x in range(m, x1 - m, 4)]
    outer = [px[x1, y] for y in range(m, y1 - m, 4)] + [px[x, y1] for x in range(m, x1 - m, 4)]
    n_in, n_out = sum(map(light_neutral, inner)), sum(map(light_neutral, outer))
    check("主视觉边界准确", n_in == 0 and n_out >= 0.9 * len(outer),
          f"面板 {x1}x{y1}；内侧浅色像素 {n_in}，外侧浅色 {n_out}/{len(outer)}")
    for n in ("hero-keyvisual", "splash-bg-horizon"):
        check(f"{n} 存在", (BRAND / "splash" / f"{n}.png").exists())
    p = BRAND / "splash" / "splash-bg-horizon.png"
    if p.exists():
        band = rgba(p)
        top = band.crop((0, 0, band.width, max(1, band.height // 5)))
        txt = sum(1 for c in pixels(top) if min(c[:3]) > 110 and max(c[:3]) - min(c[:3]) < 60)
        check("启动页背景无文字残留", txt < 20, f"顶部浅色文字像素 {txt}")


def check_colors() -> None:
    col = load_json("assets/brand/colors/colors.json")
    if not check("colors.json 存在", col is not None):
        return
    for key, c in col["canonical"].items():
        s = col["swatches"][key]
        check(f"{c['name']} 色值准确", s["delta_closest"] <= 30,
              f"标注 {c['hex']}，色块最接近 {s['closest']}（ΔRGB {s['delta_closest']}），中心 {s['center']}")


REQUIRED = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
            "StoreLogo.png": 50,
            **{f"Square{s}x{s}Logo.png": s for s in (30, 44, 71, 89, 107, 142, 150, 284, 310)}}


def flat(im: Image.Image) -> Image.Image:
    """叠到黑底再比较，消除全透明像素 RGB 取值不同带来的误差。"""
    return Image.alpha_composite(Image.new("RGBA", im.size, (0, 0, 0, 255)), im).convert("RGB")


def check_platform() -> None:
    rec = load_json("assets/brand/platform-icons.json")
    if not check("platform-icons.json 存在", rec is not None):
        return
    d, bad = ROOT / rec["output_dir"], []
    for n, s in REQUIRED.items():
        if not (d / n).exists():
            bad.append(f"缺失 {n}")
            continue
        with Image.open(d / n) as im:
            if im.size != (s, s):
                bad.append(f"{n} 为 {im.size[0]}x{im.size[1]}")
    for n in ("icon.ico", "icon.icns"):
        try:
            with Image.open(d / n) as im:
                im.load()
        except Exception as e:
            bad.append(f"{n} 不可读（{type(e).__name__}）")
    check("各平台图标齐全", not bad,
          f"生成方式 {rec['method']}；" + ("; ".join(bad) or f"共 {len(rec['files'])} 个文件"))
    if (d / "icon.png").exists():
        ref = rgba(ROOT / rec["source"]).resize((512, 512), Image.LANCZOS)
        diff = ImageStat.Stat(ImageChops.difference(flat(ref), flat(rgba(d / "icon.png")))).mean
        check("icon.png 由 icon-1024 派生", sum(diff) / 3 < 4, f"平均像素差 {sum(diff) / 3:.2f}")


def check_paths() -> None:
    """生成的 JSON / 文档里不应出现本机绝对路径。"""
    files = [p for p in BRAND.rglob("*.json") if OUT not in p.parents]
    files += [ROOT / "docs" / "BRAND.md", ROOT / "docs" / "TASKS.md", ROOT / "CLAUDE.md"]
    leaks = [p.relative_to(ROOT).as_posix() for p in files if p.exists() and any(
        s in p.read_text(encoding="utf-8") for s in (str(ROOT), "/sessions/", "/Users/"))]
    check("生成文件无本机绝对路径", not leaks, "; ".join(leaks))


def contact_sheet(man: dict) -> None:
    """每个 PNG 素材分别叠在浅底、深底上缩略，便于目检抠图与裁切。"""
    pngs = [o for o in man["outputs"] if o["file"].endswith(".png")]
    t, cols, pad = 140, 5, 12
    cw, ch = 2 * t + 3 * pad, t + 2 * pad + 16
    sheet = Image.new("RGB", (cols * cw, -(-len(pngs) // cols) * ch), (128, 128, 128))
    draw, font = ImageDraw.Draw(sheet), ImageFont.load_default()
    for i, o in enumerate(pngs):
        im = rgba(ROOT / o["file"])
        size = im.size
        im.thumbnail((t, t), Image.LANCZOS)
        x0, y0 = (i % cols) * cw + pad, (i // cols) * ch + pad
        for j, bg in enumerate(((245, 245, 245, 255), (24, 8, 8, 255))):
            cell = Image.new("RGBA", (t, t), bg)
            cell.alpha_composite(im, ((t - im.width) // 2, (t - im.height) // 2))
            sheet.paste(cell.convert("RGB"), (x0 + j * (t + pad), y0))
        label = f"{o['file'].split('assets/brand/')[-1]}  {size[0]}x{size[1]}"
        draw.text((x0, y0 + t + 3), label, fill=(255, 255, 255), font=font)
    OUT.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "contact-sheet.png")
    check("生成目检拼图", True, f"assets/brand/verify/contact-sheet.png（{len(pngs)} 个素材）")


def main() -> int:
    man = load_json("assets/brand/manifest.json")
    if man is None:
        print("缺少 assets/brand/manifest.json，请先运行 extract_brand_assets.py")
        return 1
    steps = [("原图", lambda: check_board(man)), ("清单", lambda: check_outputs(man)),
             ("Logo", check_logos), ("Logo 质量", check_logo_quality), ("图标", lambda: check_icons(man)),
             ("icon-1024", lambda: check_master(man)), ("图标一致性", lambda: check_fidelity(man)),
             ("启动页", lambda: check_splash(man)),
             ("品牌色", check_colors), ("平台图标", check_platform), ("路径", check_paths),
             ("拼图", lambda: contact_sheet(man))]
    for label, step in steps:
        try:
            step()
        except Exception as e:  # 单项出错不影响其余检查
            check(f"{label}检查执行出错", False, f"{type(e).__name__}: {e}".replace(str(ROOT), "."))
    count = {s: sum(c["status"] == s for c in CHECKS) for s in ("通过", "警告", "失败")}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "report.json").write_text(json.dumps({"summary": count, "checks": CHECKS},
                                                ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"自检完成：通过 {count['通过']}，警告 {count['警告']}，失败 {count['失败']}")
    return 1 if count["失败"] else 0


if __name__ == "__main__":
    sys.exit(main())
