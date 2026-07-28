#!/usr/bin/env python3
"""Generate the extension icons.

Kept as a script rather than committed art so the mark can be regenerated at any
size, and so nothing binary enters the repo without a readable source. The mark
is three ascending blocks on an indigo field — a journey, one step at a time.

    python3 tools/make-icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = (16, 48, 128)

INDIGO = (76, 80, 196)
LIGHT = (245, 246, 252)


def blocks(size):
    """Three ascending squares, laid out on a 16x16 grid scaled to `size`."""
    unit = size / 16
    # (col, row_from_top, width, height) in grid units
    steps = [(2.5, 9.5, 3, 4), (6.5, 6.5, 3, 7), (10.5, 3, 3, 10.5)]
    return [
        (x * unit, y * unit, (x + w) * unit, (y + h) * unit) for x, y, w, h in steps
    ]


def render(size):
    radius = size * 0.22
    rects = blocks(size)
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5

            # Rounded-square mask: outside the corner radius, stay transparent.
            cx = min(max(px, radius), size - radius)
            cy = min(max(py, radius), size - radius)
            if (px - cx) ** 2 + (py - cy) ** 2 > radius**2:
                row += bytes((0, 0, 0, 0))
                continue

            colour = INDIGO
            for x0, y0, x1, y1 in rects:
                if x0 <= px <= x1 and y0 <= py <= y1:
                    colour = LIGHT
                    break
            row += bytes((*colour, 255))
        rows.append(bytes(row))
    return rows


def write_png(path, size):
    raw = b"".join(b"\x00" + row for row in render(size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        print(f"{path.relative_to(OUT.parent.parent)} — {write_png(path, size)} bytes")


if __name__ == "__main__":
    main()
