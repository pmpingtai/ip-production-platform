"""產生四張圖文選單圖片（2500 × 843，單列），輸出到 assets/：

- richmenu_guest.png：訪客｜加入團隊成員
- richmenu_member.png：團隊成員｜我的工作（含我的進度）、雲端資料夾
- richmenu_producer.png：製片人｜核准團隊成員、團隊進度、我的工作、雲端資料夾
- richmenu_director.png：導演、副製片｜團隊進度、我的工作、雲端資料夾

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


def icon_cloud(d, cx, cy, s):
    lw = int(s * 0.08)
    d.arc([cx - s * 0.75, cy - s * 0.15, cx - s * 0.15, cy + s * 0.45], 90, 270, fill=ACCENT, width=lw)
    d.arc([cx - s * 0.45, cy - s * 0.6, cx + s * 0.25, cy + s * 0.1], 180, 340, fill=ACCENT, width=lw)
    d.arc([cx - s * 0.05, cy - s * 0.35, cx + s * 0.75, cy + s * 0.45], 250, 90, fill=ACCENT, width=lw)
    d.line([(cx - s * 0.45, cy + s * 0.45), (cx + s * 0.35, cy + s * 0.45)], fill=ACCENT, width=lw)


CLOUD = ("雲端資料夾", "企劃・劇本・美術…", icon_cloud)

MENUS = {
    "richmenu_guest.png": [("加入團隊成員", "選擇專案與角色，由製片人核准", icon_join)],
    # 2026-11-02 起每張成員選單最右邊加「雲端資料夾」（專案 IP 資料庫的七個分類）
    # 我的進度已併入我的工作（2026-11-02）
    "richmenu_member.png": [("我的工作", "進度・本週到期・退回修改", icon_list), CLOUD],
    "richmenu_producer.png": [("核准團隊成員", "申請加入你的專案", icon_check), ("團隊進度", "進度・逾期・待審核", icon_chart),
                              ("我的工作", "自己負責的工作", icon_list), CLOUD],
    "richmenu_director.png": [("團隊進度", "進度・逾期・待審核", icon_chart), ("我的工作", "自己負責的工作", icon_list), CLOUD],
}


def fit(path, text, size, width):
    """字太長時縮小，讓文字留在自己的格子裡"""
    while size > 40:
        font = ImageFont.truetype(path, size)
        if font.getlength(text) <= width:
            return font
        size -= 4
    return ImageFont.truetype(path, size)


def draw(buttons):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    step = W // len(buttons)
    for i, (label, desc, icon) in enumerate(buttons):
        x0 = i * step
        if i:
            d.line([(x0, 120), (x0, H - 120)], fill=LINE, width=6)
        cx = x0 + step // 2
        icon(d, cx, 250, 110)
        d.text((cx, 500), label, font=fit(FONT, label, 118, step - 80), fill=INK, anchor="mm")
        d.text((cx, 640), desc, font=fit(FONT_REG, desc, 64, step - 80), fill=SOFT, anchor="mm")
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
