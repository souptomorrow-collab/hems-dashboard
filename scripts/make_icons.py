# -*- coding: utf-8 -*-
"""
產生網站圖示（加到手機主畫面、iPhone 書籤用的 PNG），存到 public/icons/。

為什麼要這支：網頁分頁上的小圖示是 index.html 裡的 SVG 表情符號，
但「加到主畫面」需要 PNG（iOS 不吃 SVG），所以另外畫一組。
圖案和側欄 logo 一致：橘色漸層圓角方塊＋白色閃電。

執行：python scripts/make_icons.py（需要 Pillow）
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "public", "icons")

TOP = (255, 176, 32)      # 和 CSS 的 --c-solar 相同
BOTTOM = (255, 122, 69)   # 側欄 logo 漸層的另一端
SS = 4                    # 先畫 4 倍大再縮小，邊緣才平滑


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_icon(size, maskable=False):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # 對角漸層背景
    grad = Image.new("RGBA", (big, big))
    px = grad.load()
    for y in range(big):
        for x in range(big):
            c = lerp(TOP, BOTTOM, (x + y) / (2 * (big - 1)))
            px[x, y] = (*c, 255)

    # maskable（Android 自適應圖示）要鋪滿整格，系統會自己裁成圓形或圓角；一般圖示用圓角方塊
    mask = Image.new("L", (big, big), 0)
    if maskable:
        ImageDraw.Draw(mask).rectangle([0, 0, big, big], fill=255)
    else:
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    # 閃電：座標以 0～1 表示；maskable 的安全區只有中間 80%，圖案縮小一點
    bolt = [(0.58, 0.10), (0.24, 0.56), (0.47, 0.56), (0.40, 0.90), (0.76, 0.42), (0.53, 0.42), (0.62, 0.10)]
    scale = 0.62 if maskable else 0.78
    off = (1 - scale) / 2
    pts = [((off + x * scale) * big, (off + y * scale) * big) for x, y in bolt]
    ImageDraw.Draw(img).polygon(pts, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    outputs = {
        "icon-192.png": (192, False),
        "icon-512.png": (512, False),
        "icon-maskable-512.png": (512, True),
        "apple-touch-icon.png": (180, True),  # iOS 會自己加圓角，所以用鋪滿的版本
    }
    for name, (size, maskable) in outputs.items():
        path = os.path.join(OUT, name)
        draw_icon(size, maskable).save(path, optimize=True)
        print(f"{name}  {size}×{size}  {os.path.getsize(path) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
