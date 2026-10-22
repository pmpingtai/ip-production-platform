"""產生四張圖文選單圖片（2500 × 843，單列），輸出到 assets/：

- richmenu_guest.png：訪客｜加入團隊成員
- richmenu_member.png：團隊成員｜我的工作、我的進度
- richmenu_producer.png、richmenu_director.png：製作人、導演｜核准團隊成員、團隊進度（目前內容相同）

按鈕的格子寫在 tools/make_blueprints.py 的 MENUS（平均分欄），兩邊要一致。
換圖後推上 GitHub，再到 Make 手動執行「風雅存｜建立圖文選單（手動執行）」。

執行：python tools/make_richmenu.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 2500, 843
FONT, FONT_REG = r"C:\Windows\Fonts\msjhbd.ttc", r"C:\Windows\Fonts\msjh.ttc"
PAPER, INK, SOFT, ACCENT, LINE = (247, 244, 238), (35, 32, 28), (110, 102, 92), (138, 59, 46), (226, 218, 205)

# 圖示用線條畫，不依賴 emoji 字型
def icon_join(d, cx, cy, s):
    lw = int(s * 0.08)
    d.ellipse([cx - s * 0.55, cy - s * 0.75, cx - s * 0.05, cy - s * 0.25], outline=ACCENT, width=lw)
    d.arc([cx - s * 0.8, cy - s * 0.1, cx + s * 0.2, cy + s * 0.9], 180, 360, fill=ACCENT, width=lw)
    d.line([(cx + s * 0.45, cy - s * 0.35), (cx + s * 0.45, cy + s * 0.15)], fill=ACCENT, width=lw)
    d.line([(cx + s * 0.2, cy - s * 0.1), (cx + s * 0.7, cy - s * 0.1)], fill=ACCENT, width=lw)


def icon_list(d, cx, cy, s):
    lw = int(s * 0.08)
    for i, y in enumerate((-0.45, 0, 0.45)):
        yy = cy + y * s
        d.rounded_rectangle([cx - s * 0.7, yy - s * 0.1, cx - s * 0.5, yy + s * 0.1], radius=s * 0.04, fill=ACCENT)
        d.line([(cx - s * 0.35, yy), (cx + s * 0.7, yy)], fill=ACCENT, width=lw)


def icon_chart(d, cx, cy, s):
    lw = int(s * 0.08)
    d.line([(cx - s * 0.7, cy + s * 0.6), (cx + s * 0.7, cy + s * 0.6)], fill=ACCENT, width=lw)
    for x, h in ((-0.45, 0.5), (0, 0.9), (0.45, 1.25)):
        d.rounded_rectangle([cx + (x - 0.14) * s, cy + (0.6 - h) * s, cx + (x + 0.14) * s, cy + 0.6 * s - lw],
                            radius=s * 0.05, fill=ACCENT)


def icon_check(d, cx, cy, s):
    lw = int(s * 0.1)
    d.ellipse([cx - s * 0.7, cy - s * 0.7, cx + s * 0.7, cy + s * 0.7], outline=ACCENT, width=int(s * 0.08))
    d.line([(cx - s * 0.32, cy), (cx - s * 0.08, cy + s * 0.25), (cx + s * 0.35, cy - s * 0.25)], fill=ACCENT, width=lw, joint="curve")


MENUS = {
    "richmenu_guest.png": [("加入團隊成員", "填寫姓名與角色，由製作人核准", icon_join)],
    "richmenu_member.png": [("我的工作", "本週到期・退回修改", icon_list), ("我的進度", "各工作的狀態", icon_chart)],
    "richmenu_producer.png": [("核准團隊成員", "決定新成員的角色", icon_check), ("團隊進度", "總表與各組進度", icon_chart)],
    "richmenu_director.png": [("核准團隊成員", "決定新成員的角色", icon_check), ("團隊進度", "總表與各組進度", icon_chart)],
}


def draw(buttons):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    title, sub = ImageFont.truetype(FONT, 118), ImageFont.truetype(FONT_REG, 64)
    step = W // len(buttons)
    for i, (label, desc, icon) in enumerate(buttons):
        x0 = i * step
        if i:
            d.line([(x0, 120), (x0, H - 120)], fill=LINE, width=6)
        cx = x0 + step // 2
        icon(d, cx, 250, 110)
        d.text((cx, 500), label, font=title, fill=INK, anchor="mm")
        d.text((cx, 640), desc, font=sub, fill=SOFT, anchor="mm")
    d.line([(0, 0), (W, 0)], fill=LINE, width=8)
    return img


def main():
    out = ROOT / "assets"
    out.mkdir(exist_ok=True)
    for name, buttons in MENUS.items():
        p = out / name
        draw(buttons).save(p, optimize=True)
        print(p.relative_to(ROOT), p.stat().st_size)


if __name__ == "__main__":
    main()
