// Shareable pattern URLs: the boards (grid dimensions, BPM, and each grid's
// alive cells as a bit-packed base64url string) round-trip through the
// location hash, so copying the URL shares the composition. Grid 1 uses the
// original "cells" param, extra grids "cells2"/"cells3", keeping links from
// the single-grid era valid.

/** Encode the visible boards as a hash fragment (without the leading "#"). */
export function encodeBoards(boards, cols, rows, bpm) {
  const params = new URLSearchParams();
  params.set("cols", String(cols));
  params.set("rows", String(rows));
  params.set("bpm", String(bpm));
  if (boards.length > 1) params.set("grids", String(boards.length));
  boards.forEach((cells, g) => {
    params.set(g === 0 ? "cells" : `cells${g + 1}`, packCells(cells));
  });
  return params.toString();
}

/**
 * Decode a location hash. Returns { cols, rows, bpm, boards } (boards is an
 * array of Uint8Arrays, one per shared grid) or null if the hash doesn't
 * contain a valid pattern.
 */
export function decodeFragment(hash) {
  const raw = (hash || "").replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const cols = Number(params.get("cols"));
  const rows = Number(params.get("rows"));
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  const count = Math.max(1, Math.min(3, Number(params.get("grids")) || 1));
  const boards = [];
  for (let g = 0; g < count; g++) {
    const packed = params.get(g === 0 ? "cells" : `cells${g + 1}`);
    const cells = packed ? unpackCells(packed, cols * rows) : null;
    boards.push(cells || new Uint8Array(cols * rows));
  }
  if (!params.get("cells")) return null;
  const bpm = Number(params.get("bpm")) || null;
  return { cols, rows, bpm, boards };
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
