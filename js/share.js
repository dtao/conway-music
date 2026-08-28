// Shareable pattern URLs: the board (grid dimensions, BPM, and alive cells
// as a bit-packed base64url string) round-trips through the location hash,
// so copying the URL shares the composition.

/** Encode the current board as a hash fragment (without the leading "#"). */
export function encodeBoard(grid, bpm) {
  const params = new URLSearchParams();
  params.set("cols", String(grid.cols));
  params.set("rows", String(grid.rows));
  params.set("bpm", String(bpm));
  params.set("cells", packCells(grid.cells));
  return params.toString();
}

/**
 * Decode a location hash. Returns { cols, rows, bpm, cells } or null if the
 * hash doesn't contain a valid pattern.
 */
export function decodeFragment(hash) {
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const cols = Number(params.get("cols"));
  const rows = Number(params.get("rows"));
  const packed = params.get("cells");
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 || !packed) {
    return null;
  }
  const cells = unpackCells(packed, cols * rows);
  if (!cells) return null;
  const bpm = Number(params.get("bpm")) || null;
  return { cols, rows, bpm, cells };
}

function packCells(cells) {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8));
  for (let i = 0; i < cells.length; i++) {
    if (cells[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpackCells(packed, cellCount) {
  let binary;
  try {
    binary = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (binary.length !== Math.ceil(cellCount / 8)) return null;
  const cells = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    cells[i] = (binary.charCodeAt(i >> 3) >> (i & 7)) & 1;
  }
  return cells;
}
