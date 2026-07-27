from PIL import Image, ImageDraw
import math

def gale_icon(size, bg=(18, 21, 27, 255), accent=(79, 209, 197, 255), rounded=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)

    # Signature: three sweeping "gale" arcs of increasing length, like wind gust lines,
    # converging toward a small solid dot (the "packet" being delivered).
    cx, cy = size * 0.42, size * 0.52
    widths = [size * 0.05, size * 0.045, size * 0.04]
    lengths = [0.62, 0.78, 0.94]
    y_offsets = [-0.16, 0.0, 0.16]
    for i, (ln, yo, w) in enumerate(zip(lengths, y_offsets, widths)):
        y = cy + size * yo
        x0 = size * 0.16
        x1 = x0 + size * ln * 0.62
        alpha = 255 - i * 40
        col = accent[:3] + (alpha,)
        d.line([(x0, y), (x1, y)], fill=col, width=int(w))
        # tapered curved tip using an arc
        d.arc(
            [x1 - size * 0.05, y - size * 0.05, x1 + size * 0.05, y + size * 0.05],
            start=250, end=340, fill=col, width=int(w),
        )

    # Delivered "packet" dot
    dot_r = size * 0.07
    d.ellipse(
        [cx + size * 0.14 - dot_r, cy - dot_r, cx + size * 0.14 + dot_r, cy + dot_r],
        fill=accent,
    )
    return img

icon = gale_icon(512)
icon.save("/home/claude/idm-linux/assets/icon.png")

tray = gale_icon(64, bg=(0, 0, 0, 0))
tray.save("/home/claude/idm-linux/assets/tray.png")

small = gale_icon(256)
small.save("/home/claude/idm-linux/assets/icon-256.png")

print("done")
