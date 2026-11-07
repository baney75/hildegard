# Control: crop to the aspect from the centre and resize. Fixes nothing.
from PIL import Image
W, H = __SIZE__
im = Image.open('photo.jpg').convert('RGB'); w, h = im.size
asp = W / H
cw = w if w / h <= asp else int(round(h * asp)); ch = int(round(cw / asp)) if w / h <= asp else h
x0, y0 = (w - cw) // 2, (h - ch) // 2
im.crop((x0, y0, x0 + cw, y0 + ch)).resize((W, H), Image.LANCZOS).save('out.jpg', quality=85)
