#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EastGenesis 品牌板资产拆分脚本（仅依赖 Pillow + 标准库）。

读取 assets/brand/brand-board.png（只读，绝不写回），自动定位并裁剪各品牌资产，
导出到 assets/brand/ 各子目录，生成 icon-1024.png，抽取品牌色 HEX，
写出 colors.json / manifest.json，并回填 docs/BRAND.md 的自动区块。

坐标以 1448x1086 为参考尺寸目测，运行时按实际尺寸等比缩放，
再用像素分析（背景估计 + 内容包围盒 + 贴边外扩）自动校正。
脚本只新建/覆盖输出文件，不删除任何文件。
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import statistics

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"
BOARD = BRAND / "brand-board.png"  # 只读
DOC = ROOT / "docs" / "BRAND.md"
REF_W, REF_H = 1448, 1086
LOG: list[str] = []      # 自动校正日志
OUTPUTS: list[dict] = []  # 导出清单


def log(msg: str) -> None:
    LOG.append(msg)
    print(msg)


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def hexc(c) -> str:
    return "#{:02X}{:02X}{:02X}".format(*[int(round(v)) for v in c[:3]])


def pixels(im):
    """逐像素序列。Pillow 12.3 起 getdata() 已弃用（14 移除），有 get_flattened_data() 时优先用。"""
    f = getattr(im, "get_flattened_data", None)
    return f() if f else im.getdata()


SC = {"sx": 1.0, "sy": 1.0, "W": REF_W, "H": REF_H}


def S(box):
    """参考坐标 -> 实际像素坐标（左上含、右下不含）。"""
    x0, y0, x1, y1 = box
    return (round(x0 * SC["sx"]), round(y0 * SC["sy"]),
            min(SC["W"], round(x1 * SC["sx"])), min(SC["H"], round(y1 * SC["sy"])))


def estimate_bg(img, box):
    """取窗口四条边的像素，逐通道中位数作为背景色。"""
    px = img.load()
    x0, y0, x1, y1 = box
    pts = [(x, y0) for x in range(x0, x1)] + [(x, y1 - 1) for x in range(x0, x1)]
    pts += [(x0, y) for y in range(y0, y1)] + [(x1 - 1, y) for y in range(y0, y1)]
    vals = [px[p][:3] for p in pts]
    return tuple(statistics.median(v[i] for v in vals) for i in range(3))


def dist(a, b) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def content_bbox(img, box, bg, tol=18.0, brighter=False, min_hits=2):
    """窗口内与背景差异 > tol 的像素包围盒（整图坐标）。
    brighter=True 时，比背景更亮（任一通道 +3 以上）的像素也算内容，
    用于浅底上的白色图标本体。min_hits 过滤孤立噪点行/列。"""
    px = img.load()
    x0, y0, x1, y1 = box
    rows, cols = {}, {}
    for y in range(y0, y1):
        for x in range(x0, x1):
            c = px[x, y][:3]
            hit = dist(c, bg) > tol
            if not hit and brighter:
                hit = any(c[i] > bg[i] + 3 for i in range(3))
            if hit:
                rows[y] = rows.get(y, 0) + 1
                cols[x] = cols.get(x, 0) + 1
    ys = [y for y, n in rows.items() if n >= min_hits]
    xs = [x for x, n in cols.items() if n >= min_hits]
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def refine(img, name, win, limit, tol=18.0, brighter=False, step=6, max_iter=8, min_hits=2):
    """在搜索窗口内找内容包围盒；若内容贴窗口边，则向该侧外扩（不越过 limit），
    直到四边都不贴边。背景色取初始窗口边框中位数。返回 (bbox, bg)。"""
    win, limit = S(win), S(limit)
    bg = estimate_bg(img, win)
    x0, y0, x1, y1 = win
    bb = None
    for it in range(max_iter + 1):
        bb = content_bbox(img, (x0, y0, x1, y1), bg, tol, brighter, min_hits)
        if bb is None:
            log(f"[{name}] 窗口 {win} 内未检测到内容")
            return None, bg
        touch = [bb[0] <= x0, bb[1] <= y0, bb[2] >= x1, bb[3] >= y1]
        grow = [touch[0] and x0 > limit[0], touch[1] and y0 > limit[1],
                touch[2] and x1 < limit[2], touch[3] and y1 < limit[3]]
        if not any(grow):
            if any(touch):
                log(f"[{name}] 内容贴到限制边界 {touch}，停止外扩（需人工复核）")
            break
        if it == max_iter:  # 外扩次数用完仍贴边：包围盒可能被截断
            log(f"[{name}] 外扩 {max_iter} 次后内容仍贴边 {touch}，停止外扩（需人工复核）")
            break
        x0 = max(limit[0], x0 - step) if grow[0] else x0
        y0 = max(limit[1], y0 - step) if grow[1] else y0
        x1 = min(limit[2], x1 + step) if grow[2] else x1
        y1 = min(limit[3], y1 + step) if grow[3] else y1
        log(f"[{name}] 内容贴边，第 {it + 1} 次外扩窗口 -> {(x0, y0, x1, y1)}")
    log(f"[{name}] 背景 {hexc(bg)}，内容包围盒 {bb}")
    return bb, bg


def pad_box(bb, pad):
    return (bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad)


def square_around(bb, pad=0):
    """以包围盒中心为中心的正方形框（保证图标居中）。"""
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
    side = max(bb[2] - bb[0], bb[3] - bb[1]) + 2 * pad
    x0, y0 = round(cx - side / 2), round(cy - side / 2)
    return (x0, y0, x0 + side, y0 + side)


def rounded_mask(size, radius, ss=4, inset=0):
    """4 倍超采样圆角矩形蒙版，边缘抗锯齿；inset 内缩像素，用于切掉投影杂边。"""
    w, h = size
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (inset * ss, inset * ss, (w - inset) * ss - 1, (h - inset) * ss - 1),
        radius=max(0, radius - inset) * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def save(im, rel, purpose):
    p = BRAND / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    assert p.resolve() != BOARD.resolve(), "禁止覆盖原图"
    im.save(p, optimize=True)
    OUTPUTS.append({"file": f"assets/brand/{rel}", "size": list(im.size),
                    "mode": im.mode, "purpose": purpose})
    log(f"  -> assets/brand/{rel} {im.size[0]}x{im.size[1]} {im.mode}")


def _emit(op, x, y, c, a, bg):
    """按 C = a*F + (1-a)*B 反解前景色 F；a 近 1 时直接取原色。"""
    if a < 0.04:
        op[x, y] = (0, 0, 0, 0)
    elif a >= 0.92:
        op[x, y] = (c[0], c[1], c[2], 255)
    else:
        f = [max(0, min(255, round((c[i] - (1 - a) * bg[i]) / a))) for i in range(3)]
        op[x, y] = (f[0], f[1], f[2], round(a * 255))


def unblend_light(im, bg, noise=6):
    """浅色底反混合（color-to-alpha）：a = max_c (B-C)/B；比背景亮 20 以上才计入，
    避免浅底渐变变成白色噪点。适用于浅色面板上的彩色标志与深色文字。"""
    src = im.convert("RGB")
    out = Image.new("RGBA", src.size)
    sp, op = src.load(), out.load()
    for y in range(src.size[1]):
        for x in range(src.size[0]):
            c = sp[x, y]
            a = 0.0
            for i in range(3):
                d = c[i] - bg[i]
                if d < -noise:
                    a = max(a, -d / max(1, bg[i]))
                elif d > 20:
                    a = max(a, d / max(1, 255 - bg[i]))
            _emit(op, x, y, c, min(1.0, a), bg)
    return out


def sky_field(src, strip=6, win=15):
    """深色底的逐行底色：左右两侧各取 strip 列的下四分位（避开辉光和星点），再沿竖直方向滑动中位数平滑。
    夜空越往下越亮，左右也有差异；用单一底色会把标志下方的星点误判为半透明前景。
    返回每行的 (左侧色, 右侧色)，行内按 x 线性插值。"""
    px = src.load()
    w, h = src.size

    def q25(xs, y):
        return tuple(sorted(px[x, y][i] for x in xs)[len(xs) // 4] for i in range(3))

    raw = [(q25(range(strip), y), q25(range(w - strip, w), y)) for y in range(h)]
    half = win // 2
    return [tuple(tuple(statistics.median(s[k][i] for s in raw[max(0, y - half):y + half + 1])
                        for i in range(3)) for k in (0, 1)) for y in range(h)]


def matte_on_dark(im, name, mode="color", lo=25.0, hi=110.0, accent=None):
    """深色底抠图，底色按 sky_field 逐像素估计。结果只保证在深色底上还原准确。
    mode='white'：白字按最小通道求 alpha（边缘无粉边）。accent(c) 为真的像素（字标 i 上的金点）
    按绿通道求 alpha 并保留颜色：深红底的绿通道接近 0，金色的绿通道高。
    mode='color'：金/红标志按与底色的距离求 alpha。
    两种模式都做去噪点：离实心部分 2px 以外的淡像素与 7x7 均值取小，孤立星点被压到接近透明，
    平滑的辉光基本不受影响。白字的细笔画 alpha 较低，实心阈值取 64（彩色取 200）。"""
    src = im.convert("RGB")
    w, h = src.size
    sp = src.load()
    field = sky_field(src)

    def bg_at(x, y):
        (left, right), t = field[y], x / max(1, w - 1)
        return tuple(left[i] + (right[i] - left[i]) * t for i in range(3))

    gref, n_acc = 255, 0
    if mode == "white" and accent:
        gs = sorted(sp[x, y][1] for y in range(h) for x in range(w) if accent(sp[x, y]))
        n_acc = len(gs)
        gref = gs[int(0.9 * (n_acc - 1))] if gs else 255
    amap = Image.new("L", src.size)
    ap = amap.load()
    for y in range(h):
        for x in range(w):
            c, bg = sp[x, y], bg_at(x, y)
            if mode == "white" and accent and accent(c):
                a = (c[1] - bg[1]) / max(1, gref - bg[1])
            elif mode == "white":
                a = (min(c) - min(bg)) / max(1, 255 - min(bg))
            else:
                a = (dist(c, bg) - lo) / (hi - lo)
            ap[x, y] = round(255 * max(0.0, min(1.0, a)))
    solid = 200 if mode == "color" else 64  # 最亮的星点 alpha 约 0.5，彩色取 200 才不会被当成实心
    near = amap.point(lambda v: 255 if v >= solid else 0).filter(ImageFilter.MaxFilter(5))
    soft = ImageChops.darker(amap, amap.filter(ImageFilter.BoxBlur(3)))
    amap = ImageChops.composite(amap, soft, near)
    ap = amap.load()
    out = Image.new("RGBA", src.size)
    op = out.load()
    for y in range(h):
        for x in range(w):
            _emit(op, x, y, sp[x, y], ap[x, y] / 255, bg_at(x, y))
    CTX[name]["sky"] = {"top": [hexc(v) for v in field[0]], "bottom": [hexc(v) for v in field[-1]]}
    log(f"[{name}] 逐行底色 左上 {hexc(field[0][0])} 右上 {hexc(field[0][1])} "
        f"左下 {hexc(field[-1][0])} 右下 {hexc(field[-1][1])}"
        + (f"；金色点缀 {n_acc} 像素（绿通道参考 {gref}）" if accent else ""))
    return out


def feather(im, f):
    """alpha 在外圈 f 像素内线性衰减到 0。辉光会越过本体包围盒，羽化可避免硬切边。"""
    m = Image.new("L", im.size, 255)
    d = ImageDraw.Draw(m)
    for i in range(f):
        d.rectangle((i, i, im.width - 1 - i, im.height - 1 - i), outline=round(255 * i / f))
    im.putalpha(ImageChops.multiply(im.getchannel("A"), m))
    return im


# 区域表（1448x1086 参考坐标）：名称 -> (搜索窗口, 外扩上限, 容差, brighter[, min_hits])
# 外扩上限卡在相邻元素/分隔线/标签之前，保证不会吃进邻居。
# 主视觉夜空有 2x2 左右的亮星点，正好满足默认 min_hits=2，会把包围盒撑大；主视觉两项改为 4。
R = {
    "hero_mark":    ((100, 70, 325, 292), (60, 40, 332, 300), 60, False, 4),
    "hero_word":    ((328, 120, 790, 245), (326, 105, 800, 255), 60, False, 4),
    "light_mark":   ((945, 125, 1100, 285), (935, 115, 1105, 300), 18, False),
    "light_word":   ((1105, 165, 1410, 260), (1100, 150, 1425, 300), 18, False),
    # 图标容差 90/100：高于柔和投影与浅底的差异，只保留图标本体
    "icon_color":   ((45, 473, 165, 584), (40, 470, 185, 586), 90, False),
    "icon_dark":    ((220, 473, 340, 584), (200, 470, 360, 586), 90, False),
    "icon_light":   ((390, 473, 510, 584), (372, 470, 530, 586), 100, True),
    "icon_mono":    ((560, 473, 680, 584), (542, 470, 700, 586), 100, True),
    "min64":        ((750, 492, 825, 566), (740, 488, 835, 568), 40, False),
    "min32":        ((852, 505, 908, 560), (845, 500, 915, 568), 40, False),
    "min24":        ((937, 510, 986, 558), (930, 505, 993, 568), 40, False),
    "min16":        ((1014, 514, 1057, 556), (1008, 508, 1065, 568), 40, False),
    "sw_red":       ((1098, 484, 1258, 555), (1092, 478, 1259, 556), 40, False),
    "sw_gold":      ((1259, 484, 1420, 555), (1259, 478, 1430, 556), 40, False),
    "panel_dock":   ((4, 622, 489, 884), (0, 615, 489, 886), 90, False),
    "panel_splash": ((489, 622, 960, 884), (489, 615, 960, 886), 90, False),
    "panel_ui":     ((960, 622, 1446, 884), (960, 615, 1448, 886), 90, False),
}
CTX: dict = {}    # 各步骤之间共享的包围盒与测量值（写入 manifest）
CACHE: dict = {}  # 不可序列化的中间结果（图像）


def find(img, name):
    win, limit, tol, brighter, *opt = R[name]
    bb, bg = refine(img, name, win, limit, tol=tol, brighter=brighter,
                    min_hits=opt[0] if opt else 2)
    if bb is None:
        raise RuntimeError(f"区域 {name} 定位失败，请检查参考坐标")
    CTX[name] = {"bbox": list(bb), "bg": hexc(bg)}
    return bb, bg


def median_color(img, box):
    """实际坐标框内逐通道中位数。"""
    px = img.load()
    vals = [px[x, y][:3] for y in range(box[1], box[3]) for x in range(box[0], box[2])]
    return tuple(statistics.median(v[i] for v in vals) for i in range(3))


def rel_box(bb, fx0, fy0, fx1, fy1):
    """包围盒内按比例取子框。"""
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    return (bb[0] + round(w * fx0), bb[1] + round(h * fy0),
            bb[0] + max(round(w * fx0) + 1, round(w * fx1)),
            bb[1] + max(round(h * fy0) + 1, round(h * fy1)))


def union(*bbs):
    bbs = [b for b in bbs if b]
    return (min(b[0] for b in bbs), min(b[1] for b in bbs),
            max(b[2] for b in bbs), max(b[3] for b in bbs))


def pred_bbox(img, box, pred, min_hits=2):
    """实际坐标窗口内满足 pred 的像素包围盒（整图坐标）。"""
    px = img.load()
    x0, y0, x1, y1 = box
    rows, cols = {}, {}
    for y in range(y0, y1):
        for x in range(x0, x1):
            if pred(px[x, y][:3]):
                rows[y] = rows.get(y, 0) + 1
                cols[x] = cols.get(x, 0) + 1
    ys = [y for y, n in rows.items() if n >= min_hits]
    xs = [x for x, n in cols.items() if n >= min_hits]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1) if xs and ys else None


def light_neutral(c):
    return min(c) > 215 and max(c) - min(c) < 20


def scan_edge(img, a0, a1, fixed, axis="x"):
    """沿一行（axis='x'）或一列扫描，返回首个浅色中性像素位置，用于找面板边界。"""
    px = img.load()
    k, kf = (SC["sx"], SC["sy"]) if axis == "x" else (SC["sy"], SC["sx"])
    f = round(fixed * kf)
    for t in range(round(a0 * k), round(a1 * k)):
        if light_neutral(px[(t, f) if axis == "x" else (f, t)][:3]):
            return t
    return None


def corner_radius(img, bb, bg, tol):
    """沿左上/右上对角线向内找首个内容像素 t，圆角半径 r ≈ t / (1 - 1/√2)。"""
    px = img.load()
    ts = []
    for sx_, x_start in ((1, bb[0]), (-1, bb[2] - 1)):
        for t in range(min(bb[2] - bb[0], bb[3] - bb[1]) // 2):
            if dist(px[x_start + sx_ * t, bb[1] + t][:3], bg) > tol:
                ts.append(t)
                break
    return round(statistics.mean(ts) / 0.2929) if ts else None


def is_text_light(c):
    """深色底上的浅灰/白色文字（排除橙红辉光）。"""
    return min(c) > 110 and max(c) - min(c) < 60


def is_gold(c):
    """金色点缀（字标 i 上的点）：G、R 都明显高于 B。白字三通道接近、红色辉光 G≈B，都不会命中。"""
    return c[1] - c[2] > 15 and c[0] - c[2] > 40


def export_logos(img):
    log("== Logo ==")
    # 浅色模式：浅色面板上的标志 + 字标
    m, bg_l = find(img, "light_mark")
    w, _ = find(img, "light_word")
    lock = pad_box(union(m, w), 20)
    CTX["light_bg"] = hexc(bg_l)
    save(img.crop(lock), "logo/logo-light.png", "浅色模式 Logo（含原浅色底）")
    save(unblend_light(img.crop(lock), bg_l), "logo/logo-light-transparent.png",
         "浅色模式 Logo 透明版，用于浅色背景")
    save(unblend_light(img.crop(pad_box(m, 10)), bg_l), "logo/mark-color.png",
         "彩色标志（G 标）透明版，主用")
    save(unblend_light(img.crop(pad_box(w, 10)), bg_l), "logo/wordmark-dark.png",
         "深色字标 EastGenesis DESKTOP，用于浅色背景")
    # 深色模式：主视觉上的标志 + 字标 + 标语
    hm, bg_d = find(img, "hero_mark")
    hw, _ = find(img, "hero_word")
    cn = pred_bbox(img, S((330, 250, 760, 300)), is_text_light)
    en = pred_bbox(img, S((320, 300, 760, 332)), is_text_light)
    CTX.update(hero_bg=hexc(bg_d), slogan_cn=list(cn or []), slogan_en=list(en or []))
    full = union(hm, hw, cn, en)
    # 右侧封顶在右上角竖排英文之前，左上避开“一桌智能”
    full = (full[0] - 16, full[1] - 14, min(full[2] + 16, round(784 * SC["sx"])), full[3] + 16)
    save(img.crop(full), "logo/logo-dark.png", "深色模式 Logo（含原深色底与中英文标语）")
    mk = feather(matte_on_dark(img.crop(pad_box(hm, 10)), "hero_mark", "color"), 8)
    CACHE["hero_mark"] = mk
    wd = matte_on_dark(img.crop(pad_box(hw, 8)), "hero_word", "white", accent=is_gold)
    save(mk, "logo/mark-for-dark-bg.png", "彩色标志（带辉光）透明版，仅用于深色背景")
    save(wd, "logo/wordmark-light.png", "白色字标 EastGenesis DESKTOP，用于深色背景")
    box = pad_box(union(hm, hw), 10)
    canvas = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    canvas.alpha_composite(mk, (hm[0] - 10 - box[0], hm[1] - 10 - box[1]))
    canvas.alpha_composite(wd, (hw[0] - 8 - box[0], hw[1] - 8 - box[1]))
    save(canvas, "logo/logo-dark-transparent.png", "深色模式 Logo 透明版，仅用于深色背景")


# 本体检测异常时，在搜索窗口内粗定位 G 字形（export_icons 兜底用）
GLYPH_PRED = {
    "color": lambda c: max(c) > 170,
    "dark": lambda c: max(c) > 170,
    "light": lambda c: c[0] - c[2] > 60,
    "mono": lambda c: max(c) < 110,
}


def icon_gradient(img, sq):
    """图标底色两端：靠近上缘、下缘各取一条横带的中位数，按竖直线性渐变近似。"""
    return (median_color(img, rel_box(sq, 0.30, 0.03, 0.70, 0.08)),
            median_color(img, rel_box(sq, 0.30, 0.92, 0.70, 0.97)))


def glyph_bbox(img, sq, rr, tol=60):
    """图标内 G 字形的包围盒（整图坐标）：与重建的底色渐变任一通道相差 > tol 的像素。
    只在内缩后的圆角区域内判定：圆角外的板面、贴边的抗锯齿不参与，
    底色本身偏亮的部分也不会被误判为字形。"""
    side = sq[2] - sq[0]
    top, bottom = icon_gradient(img, sq)
    diff = ImageChops.difference(img.crop(sq).convert("RGB"), vgrad(side, top, bottom))
    keep = rounded_mask((side, side), round(rr * side), inset=max(2, side // 16))
    keep = keep.point(lambda v: 255 if v >= 250 else 0)
    diff = ImageChops.multiply(diff, Image.merge("RGB", (keep, keep, keep)))
    g = pred_bbox(diff, (0, 0, side, side), lambda c: max(c) > tol)
    return (g[0] + sq[0], g[1] + sq[1], g[2] + sq[0], g[3] + sq[1]) if g else None


def measure_glyph(img, name, sq, rr):
    """测量字形包围盒相对图标边长的比例与中心偏移（用于居中校验与 icon-1024 重建）。"""
    side = sq[2] - sq[0]
    g = glyph_bbox(img, sq, rr)
    if g is None:
        raise RuntimeError(f"{name} 未检测到字形")
    ratio = (g[2] - g[0]) / side
    dx = ((g[0] + g[2]) / 2 - (sq[0] + sq[2]) / 2) / side
    dy = ((g[1] + g[3]) / 2 - (sq[1] + sq[3]) / 2) / side
    CTX[name]["glyph"] = {"bbox": list(g), "ratio_w": round(ratio, 4),
                          "offset": [round(dx, 4), round(dy, 4)]}
    log(f"[{name}] 字形宽/图标边长 = {ratio:.3f}，中心偏移 ({dx:+.3f}, {dy:+.3f})")
    return g, ratio, dx, dy


def export_icons(img):
    log("== 图标版本 ==")
    ref_side, rr = None, 0.2237  # rr: 圆角半径/边长，缺省取 macOS 网格比例
    offs = (0.0, 0.0)
    for v in ("color", "dark", "light", "mono"):
        name = f"icon_{v}"
        bb, bg = find(img, name)
        side = min(bb[2] - bb[0], bb[3] - bb[1])  # 取短边，抵消投影把某一侧撑长
        if ref_side and not 0.85 <= side / ref_side <= 1.15:
            # 白色图标与浅底几乎同色时本体检测不可靠：沿用彩色图标边长，按字形中心反推
            g = pred_bbox(img, S(R[name][0]), GLYPH_PRED[v])
            if g is None:
                raise RuntimeError(f"{name} 本体与字形均未检测到")
            cx = (g[0] + g[2]) / 2 - offs[0] * ref_side
            cy = (g[1] + g[3]) / 2 - offs[1] * ref_side
            bb = (round(cx - ref_side / 2), round(cy - ref_side / 2),
                  round(cx + ref_side / 2), round(cy + ref_side / 2))
            side = ref_side
            log(f"[{name}] 本体检测异常，改用彩色图标边长 {ref_side} + 字形中心定位（需复核）")
        # 正方形：水平方向以包围盒中心居中，顶边对齐（投影只会向下延伸）
        x0 = round((bb[0] + bb[2]) / 2 - side / 2)
        sq = (x0, bb[1], x0 + side, bb[1] + side)
        if v == "color":
            ref_side = side
            r = corner_radius(img, bb, bg, R[name][2] / 2)
            if r and 0.15 <= r / side <= 0.30:
                rr = r / side
            log(f"[{name}] 圆角半径比 {rr:.4f}")
        tile = img.crop(sq).convert("RGBA")
        save(img.crop(pad_box(sq, 6)), f"icons/board-crops/icon-{v}-raw.png",
             f"{v} 图标原始截取（含周边，供比对）")
        tile.putalpha(rounded_mask(tile.size, round(rr * tile.size[0]), inset=1))
        save(tile, f"icons/icon-{v}.png", f"{v} 版本应用图标（圆角透明，板上分辨率）")
        _, _, dx, dy = measure_glyph(img, name, sq, rr)
        if v == "color":
            offs = (dx, dy)
            CTX["icon_rr"] = round(rr, 4)
            CTX["icon_sq"] = list(sq)
        if v == "mono":
            export_mono_mark(img, sq)


def export_mono_mark(img, sq):
    """从单色图标中抽取黑色 G 标：以图标白色本体为底反混合，并派生白色版。"""
    side = sq[2] - sq[0]
    white = median_color(img, rel_box(sq, 0.05, 0.42, 0.10, 0.58))
    g = pred_bbox(img, pad_box(sq, -max(3, side // 12)), lambda c: max(c) < 200, min_hits=1)
    if g is None:
        log("[mono] 未检测到字形，跳过 mark-mono")
        return
    black = unblend_light(img.crop(pad_box(g, 3)), white, noise=10)
    save(black, "logo/mark-mono.png", "单色（黑）标志透明版（板上分辨率较低）")
    wht = Image.new("RGBA", black.size, (255, 255, 255, 0))
    wht.putalpha(black.getchannel("A"))
    save(wht, "logo/mark-mono-white.png", "单色（白）标志透明版，用于深色或彩色背景")


def export_app_icon_refs(img):
    log("== 最小尺寸效果（板上预览，非精确像素）==")
    for n in (64, 32, 24, 16):
        bb, _ = find(img, f"min{n}")
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        save(img.crop(pad_box(bb, 2)), f"app-icons/board-preview-{n}.png",
             f"板上 {n}px 预览截图（实际 {w}x{h}px，仅作视觉参考）")


def vgrad(side, top, bottom):
    """竖直线性渐变正方形。"""
    col = Image.new("RGB", (1, side))
    px = col.load()
    for y in range(side):
        t = y / max(1, side - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return col.resize((side, side), Image.NEAREST)


def mark_layer(mark, side, ratio, off):
    """标志图层：实心部分（alpha>=0.5）宽度 = ratio * side，中心偏移 off（相对边长）。"""
    core = mark.getchannel("A").point(lambda v: 255 if v >= 128 else 0).getbbox()
    k = ratio * side / (core[2] - core[0])
    big = mark.resize((round(mark.width * k), round(mark.height * k)), Image.LANCZOS)
    ccx, ccy = (core[0] + core[2]) / 2 * k, (core[1] + core[3]) / 2 * k
    layer = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    layer.paste(big, (round(side / 2 + off[0] * side - ccx), round(side / 2 + off[1] * side - ccy)))
    return layer


def plane_img(side, coef):
    """平面渐变：每个通道 c = k0 + k1*u + k2*v，u、v 为像素中心的相对坐标（0–1）。"""
    im = Image.new("RGB", (side, side))
    im.putdata([tuple(max(0, min(255, round(k[0] + k[1] * (x + .5) / side + k[2] * (y + .5) / side)))
                      for k in coef) for y in range(side) for x in range(side)])
    return im


def solve3(A, b):
    """3x3 线性方程组（高斯消元，部分主元）。"""
    M = [A[i][:] + [b[i]] for i in range(3)]
    for i in range(3):
        p = max(range(i, 3), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        for r in range(3):
            if r != i and M[i][i]:
                f = M[r][i] / M[i][i]
                M[r] = [M[r][k] - f * M[i][k] for k in range(4)]
    return [M[i][3] / M[i][i] if M[i][i] else 0.0 for i in range(3)]


def fit_icon_plane(img, sq, mark, ratio, off, rr):
    """拟合板上彩色图标的底色平面。
    把主视觉标志按同样比例和位置放到板上图标里，只取标志 alpha < 5% 的纯底色像素，
    每个通道拟合 c = k0 + k1*u + k2*v；Tukey 重加权 10 轮，压低金弧外的辉光环和 G 内腔等离群区域。
    返回 (coef, 样本数)。"""
    side = sq[2] - sq[0]
    tile = img.crop(tuple(sq)).load()
    lay = mark_layer(mark, side, ratio, off).load()
    keep = rounded_mask((side, side), round(rr * side), inset=4).load()
    S = [((x + .5) / side, (y + .5) / side, tile[x, y]) for y in range(side) for x in range(side)
         if keep[x, y] >= 250 and lay[x, y][3] < 13]
    coef = []
    for ch in range(3):
        w = [1.0] * len(S)
        for _ in range(10):
            A = [[0.0] * 3 for _ in range(3)]
            b = [0.0] * 3
            for (u, v, c), wi in zip(S, w):
                ph = (1.0, u, v)
                for i in range(3):
                    b[i] += wi * ph[i] * c[ch]
                    for j in range(3):
                        A[i][j] += wi * ph[i] * ph[j]
            k = solve3(A, b)
            res = [c[ch] - (k[0] + k[1] * u + k[2] * v) for u, v, c in S]
            s = 4.685 * max(1.0, 1.4826 * sorted(abs(r) for r in res)[len(res) // 2])
            w = [(1 - (r / s) ** 2) ** 2 if abs(r) < s else 0.0 for r in res]
        coef.append([round(v, 3) for v in k])
    return coef, len(S)


def css_gradient(coef):
    """平面渐变的 CSS 近似：方向取红色通道的梯度（底色以红为主），两端取渐变线经过的两个角。"""
    import math
    ku, kv = coef[0][1], coef[0][2]
    deg = round(math.degrees(math.atan2(-ku, kv))) % 360  # CSS：0deg 向上，顺时针
    dx, dy = math.sin(math.radians(deg)), -math.cos(math.radians(deg))
    corners = [(0, 0), (1, 0), (0, 1), (1, 1)]
    a = min(corners, key=lambda p: p[0] * dx + p[1] * dy)
    b = max(corners, key=lambda p: p[0] * dx + p[1] * dy)
    at = lambda p: [max(0, min(255, k[0] + k[1] * p[0] + k[2] * p[1])) for k in coef]
    return f"linear-gradient({deg}deg, {hexc(at(a))} 0%, {hexc(at(b))} 100%)"


def compose_icon(side, coef, mark, ratio, off, rr):
    """重建图标：平面渐变圆角底 + 主视觉标志。"""
    body = plane_img(side, coef).convert("RGBA")
    body.alpha_composite(mark_layer(mark, side, ratio, off))
    body.putalpha(rounded_mask((side, side), round(rr * side)))
    return body


def export_icon_master(img, colors):
    """icon-1024.png：按板上彩色图标的比例，用主视觉大尺寸标志重建（板上图标仅约 94px）。
    底色用 fit_icon_plane 拟合的平面渐变，结果同时写入 colors（图标底色）。"""
    log("== icon-1024 ==")
    sq = CTX["icon_sq"]
    gl = CTX["icon_color"]["glyph"]
    ratio = min(0.80, max(0.60, gl["ratio_w"]))
    off = [max(-0.05, min(0.05, v)) for v in gl["offset"]]
    rr = CTX["icon_rr"]
    mark = CACHE["hero_mark"]
    coef, n = fit_icon_plane(img, sq, mark, ratio, off, rr)
    at = lambda u, v: [max(0, min(255, k[0] + k[1] * u + k[2] * v)) for k in coef]
    corners = {k: hexc(at(u, v)) for k, (u, v) in
               {"top_left": (0, 0), "top_right": (1, 0), "bottom_left": (0, 1), "bottom_right": (1, 1)}.items()}
    css = css_gradient(coef)
    CTX["icon_master"] = {"model": "plane", "coef": coef, "samples": n, "corners": corners, "css": css,
                          "ratio": ratio, "offset": off, "radius_ratio": rr}
    colors["measured"]["icon-bg"] = {
        "name": "彩色图标底色（平面拟合）", "hex": f"{corners['top_left']} → {corners['bottom_right']}",
        "css": css, "note": f"板上彩色图标去掉标志后的底色，平面拟合（{n} 个样本）；左上 → 右下"}
    log(f"  底色平面拟合（{n} 个样本）：左上 {corners['top_left']} 右上 {corners['top_right']} "
        f"左下 {corners['bottom_left']} 右下 {corners['bottom_right']}；CSS 近似 {css}；字形比例 {ratio:.3f}")
    # macOS 网格：1024 画布，824 本体，四周 100 留白
    master = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    master.alpha_composite(compose_icon(824, coef, mark, ratio, off, rr), (100, 100))
    save(master, "icons/icon-1024.png", "应用图标母版 1024（macOS 网格留白），tauri icon 输入")
    bleed = compose_icon(1024, coef, mark, ratio, off, rr)
    save(bleed, "icons/icon-1024-fullbleed.png", "满版图标 1024（无留白），用于 Web / 文档 / 小尺寸派生")
    for n in (512, 256, 128, 64, 32, 24, 16):
        save(bleed.resize((n, n), Image.LANCZOS), f"app-icons/icon-{n}.png",
             f"{n}px 应用图标（由满版母版缩放）")


def export_panels(img):
    log("== 启动页 / UI 参考 ==")
    right = scan_edge(img, 700, 1100, 240, "x")   # 主视觉右边界
    bottom = scan_edge(img, 300, 560, 60, "y")     # 主视觉下边界
    if not right or not bottom:
        raise RuntimeError("主视觉面板边界检测失败")
    CTX["hero_panel"] = [0, 0, right, bottom]
    save(img.crop((0, 0, right, bottom)), "splash/hero-keyvisual.png",
         "主视觉 Key Visual（深红夜空 + 地平线日出 + Logo + 标语）")
    en = CTX.get("slogan_en") or [0, 0, 0, round(322 * SC["sy"])]
    y0 = en[3] + round(6 * SC["sy"])
    save(img.crop((0, y0, right, bottom)), "splash/splash-bg-horizon.png",
         "启动页背景素材：无文字的地平线日出光带（横向铺满、底部对齐使用）")
    for name, rel, purpose in (
            ("panel_splash", "splash/splash-reference.png", "启动加载页效果参考图"),
            ("panel_dock", "ui-reference/dock-preview.png", "桌面 Dock 图标效果参考图"),
            ("panel_ui", "ui-reference/product-ui.png", "产品界面效果参考图")):
        bb, bg = find(img, name)
        r = corner_radius(img, bb, bg, 45) or 12
        CTX[name]["radius"] = r
        tile = img.crop(bb).convert("RGBA")
        tile.putalpha(rounded_mask(tile.size, r, inset=1))
        save(tile, rel, f"{purpose}（圆角 {r}px 透明）")


CANON = {"east-red": ("东方红", "#D60000"), "china-gold": ("中国金", "#FFC700")}
SAMPLES = {  # 中性色取样框（参考坐标，均避开文字）
    "hero-bg": ("主视觉背景（深红夜空）", (20, 180, 60, 240)),
    "light-panel-bg": ("浅色面板背景", (930, 20, 1400, 60)),
    "page-bg": ("页面底色", (20, 945, 440, 975)),
    "ui-main-bg": ("产品界面主区背景（参考）", (1300, 695, 1420, 725)),
    "ui-sidebar-bg": ("产品界面侧栏背景（参考）", (1152, 790, 1195, 855)),
    "ui-nav-active": ("侧栏选中项底色（参考）", (1140, 762, 1190, 780)),
    "sunrise-core": ("日出高光核心", (484, 350, 496, 358)),
}


def export_colors(img):
    log("== 品牌色 ==")
    colors = {"canonical": {}, "swatches": {}, "measured": {}}
    for (key, (label, hx)), sw in zip(CANON.items(), ("sw_red", "sw_gold")):
        bb, bg = find(img, sw)
        tile = img.crop(bb).convert("RGBA")
        tile.putalpha(rounded_mask(tile.size, corner_radius(img, bb, bg, 45) or 8, inset=1))
        save(tile, f"colors/swatch-{key}.png", f"{label} 色块截取（标注 {hx}）")
        target = tuple(int(hx[i:i + 2], 16) for i in (1, 3, 5))
        ym = (bb[1] + bb[3]) // 2
        path = []  # 沿渐变中线取 21 个 5x5 中位数样本
        for k in range(21):
            x = bb[0] + round((bb[2] - bb[0] - 1) * (0.08 + 0.84 * k / 20))
            path.append(median_color(img, (x - 2, ym - 2, x + 3, ym + 3)))
        best = min(path, key=lambda c: dist(c, target))
        colors["canonical"][key] = {"name": label, "hex": hx}
        colors["swatches"][key] = {
            "left": hexc(path[0]), "center": hexc(path[10]), "right": hexc(path[-1]),
            "closest": hexc(best), "delta_closest": round(dist(best, target), 1),
            "delta_center": round(dist(path[10], target), 1)}
        log(f"[{sw}] {label} 标注 {hx}；渐变 {hexc(path[0])} -> {hexc(path[-1])}，"
            f"最接近 {hexc(best)}（ΔRGB {dist(best, target):.1f}）")
    for key, (label, box) in SAMPLES.items():
        colors["measured"][key] = {"name": label, "hex": hexc(median_color(img, S(box))),
                                   "box": list(S(box))}
    ink = [c for c in pixels(img.crop(tuple(CTX["light_word"]["bbox"]))) if max(c) < 80]
    mk = list(pixels(img.crop(tuple(CTX["light_mark"]["bbox"]))))
    gold = [c for c in mk if c[0] > 200 and c[1] > 150 and c[2] < 90]
    red = [c for c in mk if c[0] > 150 and c[1] < 50 and c[2] < 50]
    for key, label, pxs in (("ink", "字标墨色", ink), ("mark-gold", "标志金色（实测）", gold),
                            ("mark-red", "标志红色（实测）", red)):
        if pxs:
            med = tuple(statistics.median(p[i] for p in pxs) for i in range(3))
            colors["measured"][key] = {"name": label, "hex": hexc(med), "pixels": len(pxs)}
    CTX["colors"] = colors  # 图标底色由 export_icon_master 补入，之后再写 colors.json
    return colors


def write_colors(colors):
    out = BRAND / "colors" / "colors.json"
    out.write_text(json.dumps(colors, ensure_ascii=False, indent=2), encoding="utf-8")
    OUTPUTS.append({"file": "assets/brand/colors/colors.json", "purpose": "品牌色标注值与实测值"})


def write_brand_block(colors):
    """回填 docs/BRAND.md 中 BRAND:AUTO 标记之间的实测色值表。"""
    import datetime
    a, b = "<!-- BRAND:AUTO:START -->", "<!-- BRAND:AUTO:END -->"
    if not DOC.exists() or a not in DOC.read_text(encoding="utf-8"):
        log("docs/BRAND.md 不存在或缺少自动区块标记，跳过回填")
        return
    text = DOC.read_text(encoding="utf-8")
    rows = [f"> 由 `scripts/brand/extract_brand_assets.py` 于 {datetime.date.today()} 生成，请勿手改。",
            "", "| 项目 | 实测 HEX | 说明 |", "|---|---|---|"]
    for key, s in colors["swatches"].items():
        c = colors["canonical"][key]
        rows.append(f"| {c['name']} 色块 | {s['left']} → {s['right']} | 渐变；最接近标注值 "
                    f"{c['hex']} 的样本为 {s['closest']}（ΔRGB {s['delta_closest']}） |")
    for m in colors["measured"].values():
        rows.append(f"| {m['name']} | {m['hex']} | {m.get('note', '像素中位数取样')} |")
    head, rest = text.split(a, 1)
    tail = rest.split(b, 1)[1]
    DOC.write_text(head + a + "\n" + "\n".join(rows) + "\n" + b + tail, encoding="utf-8")
    log("已回填 docs/BRAND.md 自动区块")


def main():
    before = sha256(BOARD)
    with Image.open(BOARD) as im:
        img = im.convert("RGB")  # 内存副本，原图只读
    SC.update(W=img.width, H=img.height, sx=img.width / REF_W, sy=img.height / REF_H)
    log(f"原图 {img.width}x{img.height}，缩放 sx={SC['sx']:.4f} sy={SC['sy']:.4f}，SHA-256 {before}")
    export_logos(img)
    export_icons(img)
    export_app_icon_refs(img)
    export_panels(img)
    colors = export_colors(img)
    export_icon_master(img, colors)
    write_colors(colors)
    write_brand_block(colors)
    after = sha256(BOARD)
    assert after == before, "原图被修改！"
    manifest = {"board": "assets/brand/brand-board.png", "sha256": before, "sha256_after": after,
                "size": [img.width, img.height], "scale": [SC["sx"], SC["sy"]],
                "measurements": CTX, "outputs": OUTPUTS, "log": LOG}
    (BRAND / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
    print(f"完成：导出 {len(OUTPUTS)} 个文件，原图 SHA-256 未变。")


if __name__ == "__main__":
    main()
